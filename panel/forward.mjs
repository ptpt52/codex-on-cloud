import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { equal } from './auth.mjs';

export const FORWARD_LIMITS = Object.freeze({ mappings: 4, connections: 8, chunk: 16384, buffer: 256 * 1024, pairMs: 120000 });
const fail = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export function forwardPorts(value = '22') {
  if (value === '') return [];
  const fields = String(value).split(',').map(item => item.trim());
  if (fields.length > 16 || fields.some(item => !/^[1-9]\d{0,4}$/.test(item) || Number(item) > 65535)) throw new Error('TCP_FORWARD_PORTS 需为最多 16 个以逗号分隔的端口，或留空禁用');
  return [...new Set(fields.map(Number))];
}

// Forwarding has its own lifetime: a desktop reconnect/mode change never
// touches these sockets. Only revocation, expiry, stop or gateway exit does.
export function createForwarding(config, { now = Date.now } = {}) {
  const mappings = new Map();
  const controls = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 });
  const streams = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: FORWARD_LIMITS.chunk });
  const ports = () => (config.forwardPorts ?? [22]).filter(port => ![config.port, config.agentPort, config.tunnelMetricsPort].includes(port));
  const authorized = item => item.valid() && (item.state !== 'pending' || item.expires > now());
  function remove(item) {
    if (mappings.get(item.id) !== item) return;
    mappings.delete(item.id); clearTimeout(item.timer);
    for (const stream of item.streams) { stream.ws.terminate(); stream.tcp.destroy(); }
    item.control?.terminate();
  }
  function refresh() { for (const item of mappings.values()) if (!authorized(item)) remove(item); }
  const timer = setInterval(refresh, 5000).unref();
  function list(owner) {
    refresh();
    return { ports: ports(), limit: FORWARD_LIMITS.mappings, maxConnections: FORWARD_LIMITS.connections,
      mappings: [...mappings.values()].filter(item => item.owner === owner).map(item => ({ id: item.id, localPort: item.localPort, targetPort: item.targetPort,
        state: item.state, expires: item.state === 'pending' ? item.expires : null, connections: item.streams.size, sent: item.sent, received: item.received, error: item.error || '' })) };
  }
  function create(body, owner, valid) {
    refresh();
    if (Object.keys(body).sort().join(',') !== 'localPort,targetPort' || !Number.isInteger(body.localPort) || body.localPort < 1024 || body.localPort > 65535 || !ports().includes(body.targetPort)) throw fail(400, '请选择允许的服务器端口，本机端口需在 1024–65535 之间');
    if (!valid()) throw fail(409, '页面控制权已变化');
    if (mappings.size >= FORWARD_LIMITS.mappings) throw fail(409, '最多保留 4 个映射，请先停止不用的映射');
    if ([...mappings.values()].some(item => item.owner === owner && item.localPort === body.localPort)) throw fail(409, '该本机端口已有待配对或活动映射');
    const code = secret(), item = { id: randomBytes(16).toString('hex'), owner, valid, pairHash: digest(code), expires: now() + FORWARD_LIMITS.pairMs,
      localPort: body.localPort, targetPort: body.targetPort, state: 'pending', streams: new Set(), sent: 0, received: 0, opens: 0, openedAt: now() };
    mappings.set(item.id, item);
    return { id: item.id, code, expires: item.expires, localPort: item.localPort, targetPort: item.targetPort };
  }
  function stop(body, owner) {
    if (Object.keys(body).join(',') !== 'id' || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) throw fail(400, '映射标识无效');
    const item = mappings.get(body.id);
    if (item && item.owner !== owner) throw fail(409, '映射属于其他页面，请重新接管');
    if (item) remove(item);
    return { ok: true };
  }
  function heartbeat(ws) {
    let alive = true;
    const interval = setInterval(() => {
      if (!alive || ws.readyState !== 1) return ws.terminate();
      alive = false; ws.ping();
    }, 15000).unref();
    ws.on('pong', () => { alive = true; });
    ws.once('close', () => clearInterval(interval)); ws.on('error', () => {});
  }
  function control(item, ws) {
    clearTimeout(item.timer);
    item.control = ws; heartbeat(ws);
    item.timer = setTimeout(() => remove(item), 5000).unref();
    const token = secret(); item.streamHash = digest(token);
    ws.once('close', () => remove(item));
    ws.on('message', (data, binary) => {
      let value;
      try { if (binary) throw new Error(); value = JSON.parse(data.toString('utf8')); } catch { return remove(item); }
      if (!authorized(item) || item.state !== 'connecting' || !value || Object.keys(value).join(',') !== 'type' || value.type !== 'listening') return remove(item);
      clearTimeout(item.timer); item.state = 'active'; ws.send('{"type":"listening"}');
    });
    ws.send(JSON.stringify({ type: 'ready', version: 1, id: item.id, streamToken: token, localPort: item.localPort, targetPort: item.targetPort, maxConnections: FORWARD_LIMITS.connections }));
  }
  function transfer(item, ws) {
    const tcp = net.createConnection({ host: '127.0.0.1', port: item.targetPort, allowHalfOpen: true, highWaterMark: 32768 });
    const stream = { ws, tcp }; item.streams.add(stream); heartbeat(ws);
    let connected = false, clientFin = false, pending = 0;
    const deadline = setTimeout(() => tcp.destroy(new Error('connect timeout')), 5000).unref();
    const abort = () => { ws.terminate(); tcp.destroy(); };
    ws.once('close', () => { clearTimeout(deadline); tcp.destroy(); item.streams.delete(stream); });
    tcp.once('connect', () => {
      clearTimeout(deadline);
      if (!authorized(item)) return abort();
      connected = true; tcp.setNoDelay(true); tcp.setKeepAlive(true, 30000); ws.send('{"type":"ready"}');
    });
    ws.on('message', (data, binary) => {
      if (!authorized(item) || !connected || clientFin) return abort();
      if (!binary) {
        if (data.toString('utf8') !== '{"type":"fin"}') return abort();
        clientFin = true; tcp.end(); return;
      }
      item.sent = Math.min(Number.MAX_SAFE_INTEGER, item.sent + data.length);
      if (!tcp.write(data)) ws.pause();
      if (tcp.writableLength > FORWARD_LIMITS.buffer) abort();
    });
    tcp.on('drain', () => { if (ws.readyState === 1) ws.resume(); });
    tcp.on('data', data => {
      if (!authorized(item) || ws.readyState !== 1) return abort();
      item.received = Math.min(Number.MAX_SAFE_INTEGER, item.received + data.length);
      if (ws.bufferedAmount + data.length > FORWARD_LIMITS.buffer) return abort();
      tcp.pause();
      for (let offset = 0; offset < data.length; offset += FORWARD_LIMITS.chunk) {
        pending++;
        ws.send(data.subarray(offset, offset + FORWARD_LIMITS.chunk), { binary: true }, error => {
          pending--; if (error) abort(); else if (!pending && !tcp.destroyed) tcp.resume();
        });
      }
    });
    tcp.once('end', () => { if (ws.readyState === 1) ws.send('{"type":"fin"}'); });
    tcp.once('error', () => { item.error = connected ? '目标服务连接已断开' : '目标端口无法连接'; if (ws.readyState === 1) ws.send('{"type":"error"}', () => ws.close(1011, 'Target unavailable')); });
    tcp.once('close', () => { clearTimeout(deadline); if (ws.readyState === 1) ws.close(); });
  }
  function upgrade(req, socket, head, pathname) {
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    refresh();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if (!match || req.headers['sec-websocket-protocol'] !== 'codex-forward-v1') return deny(401);
    const hash = digest(match[1]);
    if (pathname === '/forward/helper') {
      const item = [...mappings.values()].find(item => item.state === 'pending' && equal(item.pairHash, hash));
      if (!item || !authorized(item)) return deny(401);
      // Reserve synchronously before upgrading: the pairing code is single-use.
      item.state = 'connecting'; item.pairHash = null;
      item.timer = setTimeout(() => remove(item), 5000).unref();
      socket.once('close', () => { if (!item.control) remove(item); });
      try { controls.handleUpgrade(req, socket, head, ws => control(item, ws)); } catch { remove(item); socket.destroy(); }
      return;
    }
    if (pathname !== '/forward/data') return deny(404);
    const item = [...mappings.values()].find(item => item.state === 'active' && equal(item.streamHash, hash));
    if (!item || !authorized(item)) return deny(401);
    if (now() - item.openedAt >= 10000) { item.openedAt = now(); item.opens = 0; }
    if (item.streams.size >= FORWARD_LIMITS.connections || ++item.opens > 32) return deny(429);
    streams.handleUpgrade(req, socket, head, ws => transfer(item, ws));
  }
  function close() {
    clearInterval(timer); for (const item of mappings.values()) remove(item);
    controls.close(); streams.close();
  }
  return { list, create, stop, refresh, upgrade, close };
}
