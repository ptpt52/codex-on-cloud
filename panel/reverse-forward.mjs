import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { forwardHeartbeat } from './forward-heartbeat.mjs';

// Includes direct preflight, WSS upgrade, server readiness, the five-second
// target dial and its acknowledgement. Still at most eight pending sockets.
export const REVERSE_READY_MS = 40000;

// At most eight paused TCP sockets per mapping, each with a fixed deadline.
// A stream identifier is single-use and never authorizes another destination.
export function createReverseForwarding({ limits, active, authorized, streamLive, invalidReason, remove, retire, send, reserve, now }) {
  function disconnect(item) {
    const listener = item.listener; item.listener = null;
    if (listener) item.listenerClosing = new Promise(resolve => listener.close(resolve));
    for (const stream of item.streams) { clearTimeout(stream.timer); stream.ws?.terminate(); stream.tcp.destroy(); }
    item.streams.clear();
  }
  async function start(item, current) {
    if (item.keepStreams && item.listener?.listening) return;
    await item.listenerClosing;
    if (!current()) return;
    const listener = net.createServer({ allowHalfOpen: true, pauseOnConnect: true, highWaterMark: 32768 }, tcp => {
      tcp.on('error', () => {});
      if (!active(item)) return tcp.destroy();
      const reason = reserve(item);
      if (reason) { item.errorCode = reason; return tcp.destroy(); }
      const stream = { id: randomBytes(16).toString('hex'), tcp, ws: null, generation: item.generation };
      item.streams.add(stream);
      stream.timer = setTimeout(() => { item.errorCode = 'reverse_stream_timeout'; tcp.destroy(); if (stream.ws) retire(stream.ws, 'reverse_stream_timeout'); }, REVERSE_READY_MS).unref();
      tcp.once('close', () => { clearTimeout(stream.timer); item.streams.delete(stream); stream.ws?.close(1000); });
      send(item, { type: 'reverse_open', id: stream.id });
    });
    item.listener = listener;
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen({ host: '127.0.0.1', port: item.localPort, exclusive: true, backlog: 8 }, resolve); });
      if (!current()) { if (item.listener === listener) disconnect(item); else listener.close(); return; }
      listener.on('error', () => remove(item, 'reverse_listen_failed'));
    } catch (error) {
      if (item.listener === listener) item.listener = null;
      listener.close();
      if (current()) remove(item, error.code === 'EADDRINUSE' ? 'reverse_port_in_use' : 'reverse_listen_failed');
      throw error;
    }
  }
  function waiting(item, id) {
    return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) && [...item.streams].find(stream => stream.id === id && !stream.ws && stream.generation === item.generation && !stream.tcp.destroyed);
  }
  function transfer(item, ws, id) {
    const stream = waiting(item, id);
    if (!active(item) || !stream) { ws.close(4000, 'stream_authorization_invalid'); return; }
    stream.ws = ws;
    const { tcp } = stream;
    const live = () => streamLive(item, stream);
    let ready = false, clientFin = false, pending = 0;
    const abort = (code = 'protocol_error') => {
      if (live()) item.errorCode = code;
      tcp.destroy(); retire(ws, code);
    };
    if (ws.transport !== 'direct') forwardHeartbeat(ws, code => abort(code));
    ws.on('error', () => {});
    ws.once('close', () => { clearTimeout(stream.timer); tcp.destroy(); item.streams.delete(stream); });
    ws.on('message', (data, binary) => {
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live() || clientFin) return abort();
      if (item.serial && !binary) {
        let record; try { record = JSON.parse(data.toString()); } catch {}
        if (record?.type === 'error' && Object.keys(record).sort().join(',') === 'code,type' && ['serial_busy', 'serial_open_failed', 'serial_disconnected', 'serial_stalled'].includes(record.code)) { item.targetStatus = { state: 'failed', at: now() }; return abort(record.code); }
      }
      if (!ready) {
        if (!binary && data.toString() === '{"type":"target_ready"}') {
          ready = stream.established = true; clearTimeout(stream.timer); item.errorCode = ''; item.targetStatus = { state: 'reachable', at: now() };
          tcp.setNoDelay(true); tcp.setKeepAlive(true, 30000); tcp.resume(); return;
        }
        let record; try { record = binary ? null : JSON.parse(data.toString()); } catch {}
        if (record && Object.keys(record).sort().join(',') === 'code,type' && record.type === 'error' && ['target_timeout', 'target_unavailable', 'serial_busy', 'serial_open_failed', 'serial_disconnected', 'serial_stalled'].includes(record.code)) {
          item.targetStatus = { state: 'failed', at: now() }; return abort(record.code);
        }
        return abort();
      }
      if (!binary) { if (data.toString() !== '{"type":"fin"}') return abort(); clientFin = true; tcp.end(); return; }
      item.received = Math.min(Number.MAX_SAFE_INTEGER, item.received + data.length);
      if (!tcp.write(data)) ws.pause();
      if (tcp.writableLength > limits.buffer) abort('buffer_limit');
    });
    tcp.on('drain', () => { if (ws.readyState === 1) ws.resume(); });
    tcp.on('data', data => {
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live() || !ready || ws.readyState !== 1) return tcp.destroy();
      item.sent = Math.min(Number.MAX_SAFE_INTEGER, item.sent + data.length);
      if (ws.bufferedAmount + data.length > limits.buffer) return abort('buffer_limit');
      tcp.pause();
      for (let offset = 0; offset < data.length; offset += limits.chunk) {
        pending++; ws.send(data.subarray(offset, offset + limits.chunk), { binary: true }, error => { pending--; if (error) abort('helper_disconnected'); else if (!pending && !tcp.destroyed) tcp.resume(); });
      }
    });
    tcp.once('end', () => { if (ready && ws.readyState === 1) ws.send('{"type":"fin"}'); });
    tcp.once('error', () => abort('target_disconnected'));
    // Only after this acknowledgement may the helper dial its fixed target.
    ws.send('{"type":"ready"}');
  }
  return { start, disconnect, waiting, transfer };
}
