// Coordinate only SDP HTTP admission. No SDP, credentials or user actions are
// stored here. One lease and three waiters cover the two viewers and service.
export const OFFER_LIMITS = Object.freeze({ requests: 4, waitMs: 12000, leaseMs: 13000 });
const aborted = () => Object.assign(new Error('连接协商已取消'), { name: 'AbortError' });
const busy = () => Object.assign(new Error('连接协商正在排队'), { reason: 'busy' });
const queueTimeout = () => Object.assign(new Error('等待连接协商名额超时'), { reason: 'queue-timeout' });
export function createOfferQueue({ waitMs = OFFER_LIMITS.waitMs, leaseMs = OFFER_LIMITS.leaseMs } = {}) {
  const waiting = []; let active;
  function pump() {
    if (active || !waiting.length) return;
    let next = 0;
    for (let n = 1; n < waiting.length; n++) if (waiting[n].priority() < waiting[next].priority()) next = n;
    const item = waiting.splice(next, 1)[0]; active = item; clearTimeout(item.timer);
    item.timer = setTimeout(() => { try { item.expired(); } finally { item.finish(); } }, leaseMs);
    item.resolve(item.finish);
  }
  return { acquire({ signal, priority = () => 1, expired = () => {} } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (waiting.length + Number(!!active) >= OFFER_LIMITS.requests) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      let done = false;
      const item = { priority, expired, resolve, timer: undefined, finish() {
        if (done) return; done = true; clearTimeout(item.timer); signal?.removeEventListener('abort', cancel);
        if (active === item) active = undefined;
        else { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(aborted()); }
        pump();
      } };
      const cancel = () => item.finish();
      signal?.addEventListener('abort', cancel, { once: true });
      item.timer = setTimeout(() => { reject(queueTimeout()); item.finish(); }, waitMs);
      waiting.push(item); pump();
    });
  }, get size() { return waiting.length + Number(!!active); } };
}
const queue = createOfferQueue();
let sequence = 0;
export function requestRTCOffer({ signal, priority = 1, expired = () => {} } = {}) {
  const frame = new URLSearchParams(location.search).get('frame');
  if (parent === window || !frame) return queue.acquire({ signal, priority: () => priority, expired });
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    let granted = false, done = false;
    const post = type => parent.postMessage({ type, frame, id }, location.origin);
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', cancel);
      post(granted ? 'codex-rtc-offer-release' : 'codex-rtc-offer-cancel');
      if (!granted) reject(aborted());
    };
    const cancel = () => finish();
    const receive = event => {
      const value = event.data;
      if (event.origin !== location.origin || event.source !== parent || value?.type !== 'codex-rtc-offer-result' || value.frame !== frame || value.id !== id || done) return;
      if (value.ok === true && !granted) { granted = true; clearTimeout(timer); resolve(finish); }
      else if (value.ok !== true) { if (granted) expired(); else reject(value.reason === 'queue-timeout' ? queueTimeout() : busy()); finish(); }
    };
    const timer = setTimeout(() => { reject(queueTimeout()); finish(); }, OFFER_LIMITS.waitMs);
    window.addEventListener('message', receive); signal?.addEventListener('abort', cancel, { once: true });
    post('codex-rtc-offer-request');
  });
}
// The application authenticates origin, current WindowProxy and frame epoch
// before calling this bridge. Each live viewer owns at most one request.
export function createOfferBridge({ priority = () => 2, allowed = () => true, reply } = {}) {
  const entries = new Map();
  const cancel = (entry, notify = true) => {
    const item = entries.get(entry); if (!item) return;
    entries.delete(entry);
    if (notify) reply(entry, { type: 'codex-rtc-offer-result', frame: String(entry.epoch), id: item.id, ok: false });
    item.controller.abort(); item.release?.();
  };
  return { cancel, clear() { for (const entry of entries.keys()) cancel(entry); }, message(entry, value) {
    if (!['codex-rtc-offer-request', 'codex-rtc-offer-release', 'codex-rtc-offer-cancel'].includes(value?.type)) return false;
    if (!Number.isSafeInteger(value.id) || value.id < 1) return true;
    const existing = entries.get(entry);
    if (value.type !== 'codex-rtc-offer-request') { if (existing?.id === value.id) cancel(entry, false); return true; }
    const respond = (ok, reason) => reply(entry, { type: 'codex-rtc-offer-result', frame: String(entry.epoch), id: value.id, ok, ...(reason === 'queue-timeout' ? { reason } : {}) });
    if (!allowed(entry) || existing || entries.size >= 2) { respond(false); return true; }
    const item = { id: value.id, controller: new AbortController() }; entries.set(entry, item);
    queue.acquire({ signal: item.controller.signal, priority: () => priority(entry), expired: () => cancel(entry) }).then(release => {
      item.release = release;
      if (entries.get(entry) !== item) { release(); return; }
      if (!allowed(entry)) { cancel(entry); return; }
      respond(true);
    }, error => { if (entries.get(entry) === item) { entries.delete(entry); respond(false, error?.reason); } });
    return true;
  } };
}
