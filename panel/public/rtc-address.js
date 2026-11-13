// Shared browser/node policy. VPN ranges require an explicit per-peer hint;
// they never broaden the automatic remote-candidate policy.
const special4 = [[0, 8], [0x64400000, 10], [0xa9fe0000, 16], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24],
  [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 3]];
export function hintIP(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  const text = value.trim(); if (!text) return '';
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) {
    const parts = text.split('.').map(Number); if (parts.some(n => n > 255)) return null;
    const number = parts.reduce((sum, n) => sum * 256 + n, 0);
    if (vpnIP(text)) return text;
    return special4.some(([base, bits]) => Math.floor(number / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits))) ? null : text;
  }
  if (!/^[a-fA-F0-9:]+$/.test(text) || !text.includes(':')) return null;
  try {
    const address = new URL(`http://[${text}]/`).hostname.slice(1, -1);
    if (vpnIP(address)) return address;
    const [first, second] = address.split(':'); const a = parseInt(first || '0', 16), b = parseInt(second || '0', 16);
    if (a < 0x2000 || a > 0x3fff || a === 0x2001 && (b < 0x200 || b === 0xdb8) || a === 0x2002 || a === 0x3fff && b < 0x1000) return null;
    return address;
  } catch { return null; }
}
export function vpnIP(address) {
  if (typeof address !== 'string') return false;
  return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^f[cd][a-f0-9]{2}:/i.test(address);
}
export function hintedAddress(address, hints = [], ipv6 = true) {
  const ip = hintIP(address);
  return !!ip && (ipv6 || !ip.includes(':')) && (Array.isArray(hints) ? hints : [hints]).slice(0, 4).some(value => hintIP(value) === ip);
}
