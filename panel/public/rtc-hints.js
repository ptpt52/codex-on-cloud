export const RTC_HINTS_KEY = 'codex-cloud.rtc-hints.v1';
export const RTC_HINTS_LIMIT = 256;

// Match the existing direct-connect address policy without accepting URLs,
// hostnames, ports, scope IDs or IPv4-mapped IPv6 addresses.
export function hintIP(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  const text = value.trim();
  if (!text) return '';
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) {
    const [a, b, c, d] = text.split('.').map(Number);
    return [a, b, c, d].every(n => n <= 255) && (a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) ? text : null;
  }
  if (!/^[a-fA-F0-9:]+$/.test(text) || !text.includes(':')) return null;
  try {
    const address = new URL(`http://[${text}]/`).hostname.slice(1, -1);
    const [first, second = '0'] = address.split(':').map(part => part || '0');
    const a = parseInt(first, 16), b = parseInt(second, 16);
    if (a < 0x2000 || a > 0x3fff || a === 0x2001 && (b < 0x200 || b === 0xdb8) || a === 0x2002 || a === 0x3fff && b < 0x1000) return null;
    return address;
  } catch { return null; }
}

export function rtcHints(value) {
  if (value === undefined) return { server: '', browser: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['server', 'browser'].includes(key))) throw Error('直连地址提示格式无效');
  const hints = {};
  for (const [key, label] of [['server', '服务器'], ['browser', '浏览器端']]) {
    hints[key] = hintIP(value[key] ?? '');
    if (hints[key] === null) throw Error(`${label} IP 需为私有 IPv4 或普通公网 IPv6，不含端口`);
  }
  return hints;
}

// One bounded, origin-scoped entry; hints are sent only with RTC signaling.
export function createRTCHints(storage) {
  let value = rtcHints(), persisted = !!storage;
  try {
    const text = storage?.getItem(RTC_HINTS_KEY);
    if (text && text.length <= RTC_HINTS_LIMIT) value = rtcHints(JSON.parse(text));
  } catch { persisted = false; }
  return { get value() { return { ...value }; }, get persisted() { return persisted; }, save(next) {
    value = rtcHints(next);
    try {
      if (!storage) throw Error('browser storage unavailable');
      const text = JSON.stringify(value);
      if (text.length > RTC_HINTS_LIMIT) throw Error('RTC hints exceed bound');
      storage.setItem(RTC_HINTS_KEY, text); persisted = true;
    } catch { persisted = false; }
  } };
}
