export const DISCONNECT_GRACE = 1500;
export const STABLE_ROUTE = 1500;
export const ROUTE_COOLDOWN = 30000;
export const RTC_SIGNAL_TIMEOUT = 12000;
export const RTC_CONNECT_TIMEOUT = 12000;

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
  let until = 0;
  return { remaining: () => Math.max(0, until - now()), changed: () => { until = now() + ROUTE_COOLDOWN; } };
}
