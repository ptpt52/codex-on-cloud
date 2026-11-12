import { EventEmitter } from 'node:events';
import { forwardChannel, DIRECT_CHUNK } from './forward-channel.mjs';

// One authenticated WSS, separate from agent/rule management. Every logical
// stream retains the same four-record credit window as a direct data channel;
// a paused target never pauses the physical WebSocket or another rule.
export const MUX_LIMITS = Object.freeze({ streams: 128, buffer: 1024 * 1024, queue: 16 * 1024 * 1024, opens: 256, header: 5 });
const signal = () => {
  const events = new EventEmitter();
  return { subscribe(fn) { events.on('value', fn); return { unSubscribe: () => events.off('value', fn) }; }, emit(value) { events.emit('value', value); } };
};
export function createForwardMux(ws, { valid, healthy, connect }) {
  const channels = new Map();
  const queues = new Map();
  let ended = false, last = 0, openedAt = performance.now(), opens = 0, queued = 0, writing, writeDeadline;
  function pump() {
    if (ended || writing || !queues.size) return;
    let entry = queues.entries().next().value;
    // Small control records go first without overtaking their own FIN/data.
    for (const candidate of queues) if (candidate[1].frames[0][0] !== 2) { entry = candidate; break; }
    const [id, group] = entry, frame = group.frames.shift();
    group.bytes -= frame.length; queued -= frame.length; queues.delete(id);
    if (group.frames.length) queues.set(id, group); // One record per round.
    writing = { id, bytes: frame.length };
    writeDeadline = setTimeout(() => ws.terminate(), 15000).unref();
    try { ws.send(frame, error => {
      clearTimeout(writeDeadline); writing = undefined;
      if (ended) return;
      if (error) ws.terminate(); else queueMicrotask(pump);
    }); } catch { ws.terminate(); }
  }
  function send(op, id, bytes = Buffer.alloc(0)) {
    if (ended || !valid() || ws.readyState !== 1 || bytes.length > DIRECT_CHUNK || ws.bufferedAmount > MUX_LIMITS.buffer) throw Error('Mux unavailable');
    const group = queues.get(id) || { frames: [], bytes: 0 };
    if (group.frames.length >= 32 || group.bytes + bytes.length + 5 > 256 * 1024 || queued + bytes.length + 5 > MUX_LIMITS.queue || !queues.has(id) && queues.size >= 256) throw Error('Mux queue limit');
    const frame = Buffer.allocUnsafe(5 + bytes.length); frame[0] = op; frame.writeUInt32BE(id, 1); bytes.copy(frame, 5);
    // ACKs acknowledge the opposite direction, outside the business sequence.
    // They can precede queued data, but must keep their own increasing order.
    const ack = value => value[0] === 1 && /^\{"type":"ack","id":\d+\}$/.test(value.subarray(5).toString());
    if (ack(frame)) {
      let at = 0; while (at < group.frames.length && ack(group.frames[at])) at++;
      group.frames.splice(at, 0, frame);
    } else group.frames.push(frame);
    group.bytes += frame.length; queued += frame.length; queues.set(id, group); pump();
  }
  function close() {
    if (ended) return;
    ended = true; clearTimeout(writeDeadline); queues.clear(); queued = 0;
    for (const channel of [...channels.values()]) channel.close(false);
    channels.clear();
  }
  function receive(frame) {
    if (ended || !valid() || frame.length < 5 || frame.length > DIRECT_CHUNK + 5) throw Error('Invalid mux frame');
    const op = frame[0], id = frame.readUInt32BE(1), bytes = frame.subarray(5);
    if (!id || id > 2147483647 || ![1, 2, 3, 4].includes(op)) throw Error('Invalid mux frame');
    if (op === 4) {
      if (id <= last || bytes.length) throw Error('Reused mux stream');
      last = id;
      if (performance.now() - openedAt >= 10000) { openedAt = performance.now(); opens = 0; }
      if (++opens > MUX_LIMITS.opens) throw Error('Mux open rate');
      if (!healthy() || channels.size >= MUX_LIMITS.streams) { send(3, id); return; }
      const channel = { readyState: 'open', get bufferedAmount() { return (queues.get(id)?.bytes || 0) + (writing?.id === id ? writing.bytes : 0); }, onMessage: signal(), stateChange: signal(), error: signal(),
        send(value) { send(Buffer.isBuffer(value) ? 2 : 1, id, Buffer.from(value)); },
        close(notify = true) {
          if (channel.readyState === 'closed') return;
          channel.readyState = 'closed'; channels.delete(id); channel.stateChange.emit('closed');
          const group = queues.get(id); if (group) { queued -= group.bytes; queues.delete(id); }
          if (notify && !ended) { try { send(3, id); } catch { ws.terminate(); } }
        } };
      channels.set(id, channel);
      const socket = forwardChannel(channel, { transport: 'relay', shared: true });
      const timer = setTimeout(() => socket.terminate(), 10000).unref();
      socket.once('close', () => clearTimeout(timer));
      socket.once('message', (record, binary) => {
        clearTimeout(timer);
        if (binary || !valid() || !healthy()) return socket.terminate();
        let value; try { value = JSON.parse(record.toString()); } catch { return socket.terminate(); }
        connect(socket, value);
      });
      send(5, id); return;
    }
    if (op === 3 && bytes.length) throw Error('Invalid mux close');
    const channel = channels.get(id);
    // A local close can cross already-sent records/credits. IDs are monotonic
    // and never reused, so these records cannot reach a replacement stream.
    if (!channel) { if (id > last) throw Error('Unknown mux stream'); return; }
    if (op === 3) return channel.close(false);
    channel.onMessage.emit(op === 1 ? bytes.toString('utf8') : bytes);
  }
  return { receive, close, get streams() { return channels.size; } };
}
