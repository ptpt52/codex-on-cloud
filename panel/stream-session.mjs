export const STREAM_ID = /^[a-f0-9]{32}$/;
export const STREAM_CHUNK = 12 * 1024;
export const STREAM_WINDOW = 256 * 1024;
export const STREAM_LIMIT = 1024 * 1024;
export const STREAM_TTL = 15000;
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 40;
function decode(text) {
  if (typeof text !== 'string' || !text.length || text.length > STREAM_CHUNK * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('invalid chunk');
  const bytes = Buffer.from(text, 'base64'); if (!bytes.length || bytes.length > STREAM_CHUNK) throw new Error('invalid chunk'); return bytes;
}

// One upstream, two authenticated paths, bounded unacknowledged output. Input
// is never retransmitted. An uncertain input gap requires a fresh attachment.
export function createStreamSession({ id, valid, connect, canActivate = async () => true, closed = () => {}, ttl = STREAM_TTL }) {
  const peers = new Map(), output = [];
  let upstream, active, ended = false, epoch = 0, produced = 0, acked = 0, input = 0, assembly, assemblyTimer, expiry, activating = false, holding = false, holdTimer;
  const stop = () => {
    if (ended) return; ended = true; clearTimeout(expiry); clearTimeout(assemblyTimer); clearTimeout(holdTimer); clearInterval(guard);
    upstream?.close(); upstream = undefined; assembly = undefined; output.length = 0;
    for (const peer of peers.values()) peer.io.close(); peers.clear(); active = undefined; closed();
  };
  const check = () => { if (ended || !valid()) { stop(); return false; } return true; };
  const guard = setInterval(check, 1000).unref();
  function send(peer, value) {
    if (!check() || peers.get(peer.kind) !== peer || peer.io.buffered() > STREAM_LIMIT) return false;
    try { peer.io.send(value); return true; } catch { detach(peer); return false; }
  }
  function armExpiry() { clearTimeout(expiry); if (!ended) expiry = setTimeout(stop, ttl).unref(); }
  function detach(peer) {
    if (peers.get(peer.kind) !== peer) return;
    peers.delete(peer.kind); peer.io.close();
    if (active === peer) { active = undefined; upstream?.pause(); armExpiry(); }
  }
  function pressure() { if (!active || holding || produced - acked >= STREAM_WINDOW) upstream?.pause(); else upstream?.resume(); }
  function flush(peer, from) {
    for (const chunk of output) if (chunk.at >= from) {
      peer.sent = chunk.at + chunk.bytes.length;
      if (active !== peer || !send(peer, { type: 'chunk', epoch, at: chunk.at, data: chunk.bytes.toString('base64') })) return;
    }
  }
  function push(bytes) {
    if (!check() || !Buffer.isBuffer(bytes) || !bytes.length) return;
    if (produced + bytes.length - acked > STREAM_LIMIT || produced + bytes.length > 2 ** 40 || output.length + Math.ceil(bytes.length / STREAM_CHUNK) > 1024) return stop();
    const start = produced;
    for (let at = 0; at < bytes.length; at += STREAM_CHUNK) {
      const data = Buffer.from(bytes.subarray(at, at + STREAM_CHUNK)); output.push({ at: produced, bytes: data }); produced += data.length;
    }
    if (active && !holding) flush(active, start); pressure();
  }
  async function receive(peer, value) {
    if (!check() || peers.get(peer.kind) !== peer || !value || typeof value !== 'object' || Array.isArray(value)) return;
    try {
      if (value.type === 'ping') {
        if (!integer(value.id) || value.id <= peer.ping) throw new Error();
        const now = Date.now(); if (now - peer.pingAt >= 1000) { peer.pingAt = now; peer.pings = 0; }
        if (++peer.pings > 8) throw new Error(); peer.ping = value.id; send(peer, { type: 'pong', id: value.id }); return;
      }
      if (value.type === 'end') return stop();
      if (value.type === 'activate') {
        if (!integer(value.epoch) || !integer(value.out) || !integer(value.input)) throw new Error();
        if (activating) { send(peer, { type: 'wait' }); return; }
        if (value.epoch !== epoch) { send(peer, { type: 'welcome', id, epoch }); return; }
        activating = true;
        try {
          if (!await canActivate(!!active && active !== peer) || !check() || peers.get(peer.kind) !== peer) { send(peer, { type: 'wait' }); return; }
          if (value.epoch !== epoch) { send(peer, { type: 'welcome', id, epoch }); return; }
          if (value.input !== input || assembly || value.out < acked || value.out > produced || (value.out !== produced && !output.some(item => item.at === value.out))) {
            send(peer, { type: 'reset', reason: value.input !== input || assembly ? 'input-unknown' : 'output-expired' }); stop(); return;
          }
          clearTimeout(expiry); clearTimeout(holdTimer); holding = false; active = peer; epoch++; peer.sent = value.out;
          acked = value.out; while (output.length && output[0].at + output[0].bytes.length <= acked) output.shift();
          send(peer, { type: 'active', epoch, input, out: value.out });
          flush(peer, value.out);
          if (!upstream) upstream = connect({ push, close: stop });
          pressure();
        } finally { activating = false; }
        return;
      }
      // Delayed records from a retired writer cannot act on the new route.
      if (active !== peer || value.epoch !== epoch) return;
      if (value.type === 'hold' || value.type === 'unhold') {
        clearTimeout(holdTimer); holding = value.type === 'hold';
        if (holding) {
          holdTimer = setTimeout(() => { holding = false; if (active) flush(active, active.sent); pressure(); }, 2500).unref();
          pressure(); send(peer, { type: 'held', epoch });
        } else { flush(peer, peer.sent); pressure(); }
        return;
      }
      if (value.type === 'ack') {
        if (!integer(value.at) || value.at > peer.sent || value.at > produced) throw new Error();
        if (value.at <= acked) return;
        if (value.at !== produced && !output.some(item => item.at === value.at)) throw new Error();
        acked = value.at; while (output.length && output[0].at + output[0].bytes.length <= acked) output.shift(); pressure(); return;
      }
      if (value.type !== 'input' || !integer(value.id) || value.id !== input + 1 || !Number.isInteger(value.part) || !Number.isInteger(value.parts) || value.parts < 1 || value.parts > 16 || value.part < 0 || value.part >= value.parts) throw new Error();
      const bytes = decode(value.data);
      if (!assembly) {
        if (value.part !== 0) throw new Error();
        assembly = { id: value.id, parts: value.parts, chunks: [], length: 0 };
        assemblyTimer = setTimeout(stop, 3000).unref();
      }
      if (assembly.id !== value.id || assembly.parts !== value.parts || assembly.chunks.length !== value.part || assembly.length + bytes.length > 128 * 1024) throw new Error();
      assembly.chunks.push(bytes); assembly.length += bytes.length;
      if (assembly.chunks.length === assembly.parts) {
        const data = Buffer.concat(assembly.chunks); assembly = undefined; clearTimeout(assemblyTimer);
        upstream.write(data); input = value.id; send(peer, { type: 'input-ack', epoch, id: input });
      }
    } catch { detach(peer); }
  }
  armExpiry();
  return {
    attach(kind, io) {
      if (!check() || !['relay', 'direct'].includes(kind)) { io.close(); return; }
      if (peers.has(kind)) detach(peers.get(kind));
      const peer = { kind, io, sent: 0, ping: 0, pings: 0, pingAt: Date.now() }; peers.set(kind, peer);
      send(peer, { type: 'welcome', id, epoch });
      return { receive: value => { void receive(peer, value); }, close: () => detach(peer), get active() { return active === peer; } };
    },
    close: stop,
    get idle() { return !assembly && (upstream?.idle ?? true); },
    get closed() { return ended; },
    get retained() { return produced - acked; },
  };
}
