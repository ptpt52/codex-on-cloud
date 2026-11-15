export const DISCONNECT_GRACE = 1500;
export const STABLE_ROUTE = 1500;
export const ROUTE_COOLDOWN = 30000;
export const NETWORK_PROBE_INTERVAL = 5000;
export const RTC_SIGNAL_TIMEOUT = 12000;
export const RTC_CONNECT_TIMEOUT = 12000;
export const HEARTBEAT_CONGESTION_GRACE = 4000;
export function heartbeatProgress(sentAt, progressAt, now = performance.now()) {
  return progressAt >= sentAt && now >= progressAt && now - progressAt <= 1500;
}

// Fixed-size observations only. Quiet applications and pending helper actions
// are not congestion: observe only transport buffers and transport-level ACKs.
export function createPathQuality(now = () => performance.now()) {
  let mean = null, variation = 0, count = 0, at = -Infinity, version = 0;
  let queued = 0, queuedAt = null, queueSeen = -Infinity, ack = 0, ackAt = -Infinity;
  const fresh = () => count >= 2 && now() >= at && now() - at <= 10000;
  const pressure = () => {
    const time = now();
    const buffered = time >= queueSeen && time - queueSeen <= 10000 && queuedAt !== null && time - queuedAt >= 1000
      ? Math.min(800, 100 + queued / 256 + (time - queuedAt - 1000) / 10) : 0;
    const age = time - ackAt;
    const delayed = age >= 0 && age < 10000 ? Math.min(800, Math.max(0, ack - Math.max(250, (mean || 0) * 4))) * (1 - age / 10000) : 0;
    return Math.max(buffered, delayed);
  };
  return {
    sample(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 600000) return;
      variation = mean === null ? 0 : .75 * variation + .25 * Math.abs(ms - mean);
      mean = mean === null ? ms : (mean + ms) / 2; count = Math.min(3, count + 1); at = now(); version++;
    },
    buffered(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2 ** 40) return;
      const time = now();
      if (bytes < 16384) queuedAt = null;
      else if (queuedAt === null || time < queueSeen || time - queueSeen > 10000) queuedAt = time;
      queued = bytes; queueSeen = time;
    },
    acknowledge(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 600000) return;
      ack = now() - ackAt > 10000 ? ms : Math.max(ms, ack * .75); ackAt = now();
    },
    get rttMs() { return fresh() ? mean : null; },
    get scoreMs() { return fresh() ? mean + Math.min(100, variation / 2) + pressure() : null; },
    get metrics() { return { rttMs: fresh() ? Math.round(mean) : null, jitterMs: Math.round(variation), queuedBytes: queued,
      ackMs: now() - ackAt >= 0 && now() - ackAt <= 10000 ? Math.round(ack) : 0, penaltyMs: Math.round(pressure()) }; },
    get warming() { return count < 3; }, get version() { return version; },
    clear() { mean = null; variation = count = queued = ack = 0; at = queueSeen = ackAt = -Infinity; queuedAt = null; version++; },
  };
}
export function pathPreferred({ candidateMs, currentMs, candidate = 'direct', turn = false }) {
  if (![candidateMs, currentMs].every(ms => Number.isFinite(ms) && ms >= 0)) return false;
  if (candidate === 'direct' && !turn) return candidateMs <= currentMs + Math.max(15, currentMs * .2);
  return currentMs - candidateMs >= Math.max(candidate === 'relay' && !turn ? 40 : 20, currentMs * (candidate === 'relay' && !turn ? .35 : .2));
}
export function rtcFailureStatus(status) {
  if ([401, 403, 423].includes(status)) return 'auth';
  if (status === 409) return 'target';
  if (status === 429) return 'busy';
  if (status === 404) return 'disabled';
  if (status === 400) return 'protocol';
  return 'signal-failed';
}
export function directRetry(reason, attempt = 0, random = Math.random) {
  if (['auth', 'target', 'protocol', 'disabled', 'unsupported'].includes(reason)) return { stop: true, delay: 0 };
  const count = Math.max(0, Math.min(8, Number.isInteger(attempt) ? attempt : 0));
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * (reason === 'busy' ? 250 : 1000));
  return { stop: false, delay: Math.min(reason === 'busy' ? 5000 : 60000, (reason === 'busy' ? 500 : 15000) * 2 ** Math.min(count, reason === 'busy' ? 4 : 2) + jitter) };
}

// One bounded deadline, shared by browser and native WebRTC adapters.
export function disconnectGrace(failed, { delay = DISCONNECT_GRACE, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  return {
    state(state) {
      if (state === 'disconnected') timer ??= schedule(() => { timer = undefined; failed(); }, delay);
      else { clear(); if (state === 'failed' || state === 'closed') failed(); }
    },
    close: clear,
  };
}
export function routePolicy(now = () => performance.now()) {
  let until = 0, nextNetworkProbe = 0;
  return { remaining: () => Math.max(0, until - now()), changed: () => { until = now() + ROUTE_COOLDOWN; },
    networkWait: () => Math.max(0, nextNetworkProbe - now()), networkProbeStarted: () => { nextNetworkProbe = now() + NETWORK_PROBE_INTERVAL; } };
}
