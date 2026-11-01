// Fixed-size read-only echo. No helper action, input queue or persistent state.
export function attachRTCHealth(channel, { valid, fail }) {
  let ended = false, lastId = 0, windowStart = performance.now(), count = 0;
  const close = () => { if (ended) return; ended = true; channel.close(); };
  const invalid = () => { if (ended) return; close(); fail(); };
  channel.onMessage.subscribe(bytes => {
    if (ended) return;
    const now = performance.now();
    if (now - windowStart >= 1000) { windowStart = now; count = 0; }
    if (!valid() || !Buffer.isBuffer(bytes) || bytes.length !== 4 || ++count > 8 || channel.readyState !== 'open' || channel.bufferedAmount > 4096) { invalid(); return; }
    const id = bytes.readUInt32BE(0);
    if (id <= lastId || id > 2147483647) { invalid(); return; }
    lastId = id;
    try { channel.send(bytes); } catch { invalid(); }
  });
  channel.error.subscribe(invalid);
  channel.stateChange.subscribe(state => { if (state === 'closed') invalid(); });
  return { close };
}
