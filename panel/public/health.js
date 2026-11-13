// Keep one foreground sample; a restored or disconnected page must not display
// an old path's latency as if it belonged to the current connection.
export function createHeartbeatPolicy() {
  let mean = null, deviation = 0, latest = 0, misses = 0;
  return {
    get timeoutMs() { return Math.round(Math.max(2000, Math.min(6000, mean === null ? 2000 : Math.max(mean + 4 * deviation + 500, latest * 2 + 1000)))); },
    get confirmationMs() { return Math.max(1000, Math.min(2000, Math.round(this.timeoutMs / 2))); },
    get suspect() { return misses > 0; },
    miss() { return ++misses; },
    cancel() { misses = 0; },
    sample(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 600000) return false;
      latest = ms;
      if (mean === null) { mean = ms; deviation = ms / 2; }
      else { deviation = .75 * deviation + .25 * Math.abs(mean - ms); mean = .875 * mean + .125 * ms; }
      misses = 0; return true;
    },
  };
}
export function createRoundTrip(now = () => performance.now()) {
  let sample = null, measuredAt = 0;
  return {
    get value() { const age = now() - measuredAt; return age >= 0 && age <= 10000 ? sample : null; },
    set(ms) { sample = Number.isFinite(ms) && ms >= 0 && ms <= 600000 ? Math.round(ms) : null; measuredAt = now(); },
    clear() { sample = null; },
  };
}

// One read-only probe at a time, independent of the single in-flight input.
export function createHealthClient(channel) {
  let pending, sequence = 0, ended = false;
  const latency = createRoundTrip();
  const policy = createHeartbeatPolicy();
  channel.binaryType = 'arraybuffer';
  const reject = (message, code) => {
    latency.clear();
    if (!pending) return;
    const current = pending; pending = undefined;
    clearTimeout(current.timer); current.reject(Object.assign(new Error(message), { code }));
  };
  const close = () => {
    if (ended) return;
    ended = true; reject('直连心跳已关闭'); channel.close();
  };
  const send = () => {
    if (!pending || channel.readyState !== 'open') return;
    try {
      if (channel.bufferedAmount > 4096) throw new Error();
      const bytes = new ArrayBuffer(4);
      new DataView(bytes).setUint32(0, pending.id);
      pending.sentAt = performance.now();
      channel.send(bytes);
    } catch { close(); }
  };
  channel.addEventListener('open', send);
  channel.addEventListener('close', close);
  channel.addEventListener('error', close);
  channel.addEventListener('message', event => {
    if (ended) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 4) { close(); return; }
    const id = new DataView(event.data).getUint32(0);
    if (!id || id > sequence) { close(); return; }
    // A canceled/backgrounded probe can arrive late; it cannot satisfy a new one.
    if (id !== pending?.id || pending.sentAt === undefined) return;
    const current = pending; pending = undefined;
    latency.set(performance.now() - current.sentAt);
    policy.sample(performance.now() - current.sentAt);
    clearTimeout(current.timer); current.resolve(latency.value);
  });
  return {
    close,
    get rttMs() { return latency.value; },
    cancel() { reject('直连心跳已取消'); },
    ping({ confirmation = false, timeoutMs } = {}) {
      if (ended || pending || channel.readyState === 'closed' || channel.readyState === 'closing' || sequence >= 2147483647) return Promise.reject(new Error('直连心跳不可用'));
      return new Promise((resolve, rejectProbe) => {
        const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(10000, Math.round(timeoutMs)) : confirmation ? policy.confirmationMs : policy.timeoutMs;
        pending = { id: ++sequence, resolve, reject: rejectProbe, timer: setTimeout(() => reject('直连心跳超时', 'heartbeat_timeout'), budget) };
        send();
      });
    },
  };
}
