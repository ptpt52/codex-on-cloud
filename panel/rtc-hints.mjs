import { privateIPv4, globalIPv6 } from './rtc-network.mjs';

export { rtcHints } from './public/rtc-hints.js';
export const RTC_HINT_CANDIDATES = 4;

// Preserve every automatic candidate and all ICE credentials. An address hint
// supplies only another destination for a port actually gathered this round;
// it never opens a listener, performs a port scan or becomes a bind address.
export function withHintCandidates(description, value, { ipv6 = false } = {}) {
  const addresses = [...new Set((Array.isArray(value) ? value : [value]).filter(address => privateIPv4(address) || ipv6 && globalIPv6(address)))].slice(0, RTC_HINT_CANDIDATES);
  if (!addresses.length) return description;
  const lines = description.sdp.split(/\r?\n/), seen = new Set(), sources = [], foundations = new Set();
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const [foundation, component, transport, priority, host, port, typ, kind] = line.slice(12).split(/ +/);
    foundations.add(foundation);
    seen.add(`${globalIPv6(host) ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host}:${Number(port)}`);
    // mDNS intentionally hides the family; either permitted IP hint may try
    // that gathered host port, while explicit addresses stay family-matched.
    const family = /^[a-zA-Z0-9-]{1,63}\.local$/.test(host || '') ? 0 : privateIPv4(host) ? 4 : globalIPv6(host) ? 6 : -1;
    if (component === '1' && transport?.toLowerCase() === 'udp' && /^\d+$/.test(priority) && Number(priority) > 0 && Number(priority) <= 0xffffffff &&
        /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535 && typ === 'typ' && kind === 'host' && family >= 0) sources.push({ port: Number(port), priority: Number(priority), family });
  }
  const budget = RTC_HINT_CANDIDATES - lines.filter(line => line.startsWith('a=candidate:hint')).length;
  if (budget <= 0) return description;
  const choices = addresses.map(address => {
    const family = privateIPv4(address) ? 4 : 6, ports = new Set();
    return sources.filter(source => (!source.family || source.family === family) && !ports.has(source.port) && ports.add(source.port))
      .map(source => ({ ...source, address })).filter(source => !seen.has(`${source.address}:${source.port}`));
  });
  const extra = [];
  // Allocate one port per address per round. A multihomed peer must not let
  // its first hint exhaust the shared four-candidate budget.
  for (let round = 0; round < RTC_HINT_CANDIDATES; round++) for (const list of choices) {
    const source = list[round]; if (!source || extra.length >= budget) continue;
    const { address, port, priority } = source;
    let id = extra.length + 1; while (foundations.has(`hint${id}`)) id++;
    foundations.add(`hint${id}`);
    extra.push(`a=candidate:hint${id} 1 udp ${Math.max(1, Math.min(priority - 1, 1694498815))} ${address} ${port} typ host`);
  }
  if (!extra.length) return description;
  let at = lines.indexOf('a=end-of-candidates');
  if (at < 0) at = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  lines.splice(at, 0, ...extra);
  return { ...description, sdp: lines.join('\r\n') };
}
