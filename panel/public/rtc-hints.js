import { hintIP } from './rtc-address.js';
export { hintIP } from './rtc-address.js';
export const RTC_HINTS_KEY = 'codex-cloud.rtc-hints.v2';
export const RTC_HINTS_LEGACY_KEY = 'codex-cloud.rtc-hints.v1';
export const RTC_HINTS_LIMIT = 64 * 1024;
export const RTC_HINTS_MAX_AGE = 90 * 86400000;

export function rtcHints(value) {
  if (value === undefined) return { server: '', browser: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['server', 'browser'].includes(key))) throw Error('直连地址提示格式无效');
  const hints = {};
  for (const [key, label] of [['server', '节点主机'], ['browser', '浏览器端']]) {
    hints[key] = hintIP(value[key] ?? '');
    if (hints[key] === null) throw Error(`${label} IP 需为有效 IPv4、普通公网 IPv6 或 VPN 地址，不含端口`);
  }
  return hints;
}

// One byte-bounded cache per origin, isolated by immutable node identity (or
// entry path for standalone fixtures). Stale tabs merge only their own entry.
export function createRTCHints(storage, { nodeId = '', basePath = '/', now = Date.now } = {}) {
  if (nodeId && !/^[a-f0-9]{32}$/.test(nodeId) || !/^\/(?:node\/[a-z0-9-]{1,48}\/)?$/.test(basePath)) throw Error('直连提示节点标识无效');
  const scope = nodeId ? 'node:' + nodeId : 'path:' + basePath;
  let value = rtcHints(), persisted = !!storage, legacy;
  const read = () => {
    const text = storage?.getItem(RTC_HINTS_KEY);
    if (!text || text.length > RTC_HINTS_LIMIT) return new Map();
    let cache; try { cache = JSON.parse(text); } catch { return new Map(); }
    const entries = new Map();
    if (cache?.version !== 2 || !Array.isArray(cache.entries)) return entries;
    for (const item of cache.entries) {
      if (!item || typeof item.scope !== 'string' || !/^(?:node:[a-f0-9]{32}|path:\/(?:node\/[a-z0-9-]{1,48}\/)?)$/.test(item.scope) ||
          !Number.isSafeInteger(item.at) || item.at < now() - RTC_HINTS_MAX_AGE || item.at > now() + 86400000) continue;
      try { entries.set(item.scope, { scope: item.scope, at: item.at, hints: rtcHints(item.hints) }); } catch {}
    }
    return entries;
  };
  try {
    const current = read().get(scope); if (current) value = current.hints;
    const old = storage?.getItem(RTC_HINTS_LEGACY_KEY);
    if (!current && old && old.length <= 256) { const hints = rtcHints(JSON.parse(old)); if (hints.server || hints.browser) legacy = hints; }
  } catch { persisted = false; }
  function save(next) {
    value = rtcHints(next); legacy = undefined;
    try {
      if (!storage) throw Error('browser storage unavailable');
      const entries = read(); entries.delete(scope); entries.set(scope, { scope, at: now(), hints: value });
      const ordered = [...entries.values()].sort((a, b) => a.at - b.at);
      let text = JSON.stringify({ version: 2, entries: ordered });
      while (text.length > RTC_HINTS_LIMIT && ordered.length > 1) { ordered.shift(); text = JSON.stringify({ version: 2, entries: ordered }); }
      if (text.length > RTC_HINTS_LIMIT) throw Error('RTC hints exceed bound');
      storage.setItem(RTC_HINTS_KEY, text); persisted = true;
    } catch { persisted = false; }
  }
  return { get value() { return { ...value }; }, get legacy() { return legacy && { ...legacy }; }, get persisted() { return persisted; }, save };
}
