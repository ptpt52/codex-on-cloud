export const DISCONNECT_GRACE = 1500;
export const STABLE_ROUTE = 1500;
export const ROUTE_COOLDOWN = 30000;
export const NETWORK_PROBE_INTERVAL = 5000;
export const RTC_SIGNAL_TIMEOUT = 12000;
export const RTC_CONNECT_TIMEOUT = 12000;
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
