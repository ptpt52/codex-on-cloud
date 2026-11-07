import { privateIPv4, globalIPv6 } from './rtc-network.mjs';

export { rtcHints } from './public/rtc-hints.js';
export const RTC_HINT_CANDIDATES = 4;

// Preserve every automatic candidate and all ICE credentials. An address hint
// supplies only another destination for a port actually gathered this round;
// it never opens a listener, performs a port scan or becomes a bind address.
export function withHintCandidates(description, address, { ipv6 = false } = {}) {
  const v4 = privateIPv4(address), v6 = ipv6 && globalIPv6(address);
  if (!v4 && !v6) return description;
  const lines = description.sdp.split(/\r?\n/), seen = new Set(), sources = [];
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const [, component, transport, priority, host, port, typ, kind] = line.slice(12).split(/ +/);
    seen.add(`${globalIPv6(host) ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host}:${Number(port)}`);
    // mDNS intentionally hides the family; either permitted IP hint may try
    // that gathered host port, while explicit addresses stay family-matched.
    const family = /^[a-zA-Z0-9-]{1,63}\.local$/.test(host || '') || (v4 ? privateIPv4(host) : globalIPv6(host));
    if (component === '1' && transport?.toLowerCase() === 'udp' && /^\d+$/.test(priority) && Number(priority) > 0 && Number(priority) <= 0xffffffff &&
        /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535 && typ === 'typ' && kind === 'host' && family) sources.push({ port: Number(port), priority: Number(priority) });
  }
  const extra = [], ports = new Set();
  for (const { port, priority } of sources) {
    if (ports.has(port)) continue;
    if (ports.size >= RTC_HINT_CANDIDATES) break;
    ports.add(port);
    const key = `${address}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(`a=candidate:hint${extra.length + 1} 1 udp ${Math.max(1, Math.min(priority - 1, 1694498815))} ${address} ${port} typ host`);
  }
  if (!extra.length) return description;
  let at = lines.indexOf('a=end-of-candidates');
  if (at < 0) at = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  lines.splice(at, 0, ...extra);
  return { ...description, sdp: lines.join('\r\n') };
}
