import { EventEmitter } from 'node:events';

// Ordered/reliable SCTP preserves message boundaries. Four acknowledged records
// bound the receiver even while its target TCP socket applies backpressure.
export const DIRECT_WINDOW = 4, DIRECT_CHUNK = 16384, DIRECT_BUFFER = 256 * 1024;
export function forwardChannel(channel) {
  const socket = new EventEmitter(), subscriptions = [], outgoing = [], incoming = [];
  let ended = false, paused = false, closing = false, queued = 0, sent = 0, acked = 0, received = 0, delivered = 0, credited = 0;
  Object.defineProperties(socket, {
    readyState: { get: () => ended ? 3 : closing ? 2 : channel.readyState === 'open' ? 1 : 0 },
    bufferedAmount: { get: () => queued + channel.bufferedAmount },
    transport: { value: 'direct' },
  });
  function finish() {
    if (ended) return;
    ended = true;
    for (const subscription of subscriptions) subscription.unSubscribe();
    for (const item of outgoing.splice(0)) queueMicrotask(() => item.callback?.(new Error('Direct channel closed')));
    incoming.length = 0; queued = 0;
    channel.close(); socket.emit('close');
  }
  function send(bytes) {
    if (channel.readyState !== 'open' || channel.bufferedAmount + Buffer.byteLength(bytes) > DIRECT_BUFFER) throw new Error('Direct buffer limit');
    channel.send(bytes);
  }
  function flush() {
    if (ended) return;
    try {
      while (outgoing.length && sent - acked < DIRECT_WINDOW) {
        if (sent >= 2147483647) throw new Error('Direct sequence limit');
        const item = outgoing.shift(); queued -= Buffer.byteLength(item.bytes); sent++;
        send(item.bytes); queueMicrotask(() => item.callback?.());
      }
      if (closing && !outgoing.length && sent === acked) finish();
    } catch { finish(); }
  }
  function credit() {
    if (delivered === credited || ended) return;
    try { send(JSON.stringify({ type: 'ack', id: delivered })); credited = delivered; }
    catch { finish(); }
  }
  function drain() {
    while (!ended && !paused && incoming.length) {
      const item = incoming.shift(); delivered = item.id;
      socket.emit('message', item.bytes, item.binary);
      if (!paused) credit();
    }
  }
  socket.send = (value, options, callback) => {
    if (typeof options === 'function') callback = options;
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : String(value);
    if (ended || closing || Buffer.byteLength(bytes) > DIRECT_CHUNK || queued + Buffer.byteLength(bytes) > DIRECT_BUFFER || outgoing.length >= 32) {
      queueMicrotask(() => callback?.(new Error('Direct buffer limit'))); finish(); return;
    }
    outgoing.push({ bytes, callback }); queued += Buffer.byteLength(bytes); flush();
  };
  socket.pause = () => { paused = true; };
  socket.resume = () => { paused = false; credit(); drain(); };
  socket.terminate = finish;
  socket.close = (code = 1000, reason = '') => {
    if (ended || closing) return;
    if (code !== 1000) socket.send(JSON.stringify({ type: 'error', code: reason || 'protocol_error' }));
    closing = true; flush();
  };
  subscriptions.push(channel.onMessage.subscribe(value => {
    if (ended) return;
    const binary = Buffer.isBuffer(value), size = Buffer.byteLength(value);
    if (size > DIRECT_CHUNK) return finish();
    if (!binary) {
      let record; try { record = JSON.parse(value); } catch { return finish(); }
      if (record?.type === 'ack') {
        if (Object.keys(record).sort().join(',') !== 'id,type' || !Number.isInteger(record.id) || record.id <= acked || record.id > sent) return finish();
        acked = record.id; flush(); return;
      }
    }
    if (++received > 2147483647 || received - credited > DIRECT_WINDOW) return finish();
    incoming.push({ bytes: Buffer.from(value), binary, id: received }); drain();
  }));
  subscriptions.push(channel.stateChange.subscribe(state => { if (state === 'closed') finish(); }));
  subscriptions.push(channel.error.subscribe(finish));
  return socket;
}
