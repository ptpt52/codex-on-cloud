import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { openSync, readSync, closeSync } from 'node:fs';

const global = new net.BlockList();
global.addSubnet('2000::', 3, 'ipv6');
const special = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) special.addSubnet(address, prefix, 'ipv6');
const canonical = address => new URL(`http://[${address}]/`).hostname.slice(1, -1);

export function privateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function globalIPv6(address) {
  return typeof address === 'string' && !address.includes('%') && net.isIP(address) === 6 && global.check(address, 'ipv6') && !special.check(address, 'ipv6');
}
export function peerAddress(address, ipv6) { return privateIPv4(address) || (ipv6 && globalIPv6(address)); }

function defaultRoutes() {
  // Linux native deployment. Bound the read even if the routing table is large;
  // other platforms and unavailable procfs retain interface-order selection.
  let file;
  try {
    file = openSync('/proc/net/route', 'r');
    const bytes = Buffer.alloc(65536), count = readSync(file, bytes);
    return bytes.toString('utf8', 0, count).split('\n').slice(1, count === bytes.length ? -1 : undefined);
  } catch { return []; }
  finally { if (file !== undefined) closeSync(file); }
}

export function rtcAddress(explicit, interfaces = networkInterfaces(), routes = defaultRoutes()) {
  const entries = Object.entries(interfaces), addresses = entries.flatMap(([, rows]) => rows.map(row => row.address));
  if (explicit) {
    if (!privateIPv4(explicit) || !addresses.includes(explicit)) throw new Error('WEBRTC_LAN_ADDRESS 必须是本机已分配的私有 IPv4 地址');
    return explicit;
  }
  const usable = rows => rows.find(row => !row.internal && privateIPv4(row.address) && !row.address.startsWith('127.'))?.address;
  const defaults = routes.map(line => line.trim().split(/\s+/)).filter(row => row.length >= 8 && row[1] === '00000000' && row[7] === '00000000' &&
    /^[0-9a-f]+$/i.test(row[3]) && (parseInt(row[3], 16) & 1) && !(parseInt(row[3], 16) & 0x200) && /^\d+$/.test(row[6]));
  defaults.sort((a, b) => Number(a[6]) - Number(b[6]));
  for (const [name] of defaults) { const address = interfaces[name] && usable(interfaces[name]); if (address) return address; }
  return entries.map(([, rows]) => usable(rows)).find(Boolean) || '127.0.0.1';
}

export function rtcIPv6Address(explicit, ipv4, interfaces = networkInterfaces()) {
  const entries = Object.entries(interfaces);
  const preferred = entries.find(([, rows]) => rows.some(row => row.address === ipv4));
  const ordered = preferred ? [preferred, ...entries.filter(entry => entry !== preferred)] : entries;
  const addresses = ordered.flatMap(([, rows]) => rows.filter(row => !row.internal && globalIPv6(row.address)).map(row => canonical(row.address)));
  if (explicit) {
    if (!globalIPv6(explicit) || !addresses.includes(canonical(explicit))) throw new Error('WEBRTC_IPV6_ADDRESS 必须是本机已分配的公网 IPv6 地址');
    return canonical(explicit);
  }
  return addresses[0];
}

export function stunURL(value = 'stun:stun.cloudflare.com:3478') {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 256) throw new Error('WEBRTC_STUN_URL 无效');
  const match = /^stun:(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match || Number(match[2] || 3478) < 1 || Number(match[2] || 3478) > 65535 || (match[1].startsWith('[') && net.isIP(match[1].slice(1, -1)) !== 6)) throw new Error('WEBRTC_STUN_URL 仅允许一个 UDP STUN 地址，不允许 TURN、凭据或查询参数');
  return value;
}

// At most eight candidates, reserving room for both address families. mDNS is
// checked again after resolution; public IPv4 and relay candidates stay disabled.
export function rtcOffer(body, { ipv6 = false, allowRelay = false } = {}) {
  if (body.type !== 'offer' || typeof body.sdp !== 'string' || Buffer.byteLength(body.sdp) > 32768 || /\0/.test(body.sdp)) throw new Error('连接协商内容无效');
  const lines = body.sdp.split(/\r?\n/);
  const media = lines.filter(line => line.startsWith('m='));
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]) ||
      !lines.some(line => /^a=fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(line))) throw new Error('仅支持加密桌面数据通道');
  const v4 = [], v6 = [], seen = new Set();
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const [, component, transport, , host, port, typ, kind] = line.slice(12).split(/ +/);
    const public6 = ipv6 && globalIPv6(host);
    const mdns = /^[a-zA-Z0-9-]{1,63}\.local$/.test(host || '');
    if (component !== '1' || transport?.toLowerCase() !== 'udp' || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || typ !== 'typ' ||
        !(kind === 'host' && (privateIPv4(host) || mdns || public6) || kind === 'srflx' && public6 || allowRelay && kind === 'relay' && (net.isIP(host) === 4 && !privateIPv4(host) || public6))) continue;
    const list = public6 ? v6 : v4, key = `${public6 ? canonical(host) : host}:${Number(port)}`;
    if (list.length >= 8 || seen.has(key)) continue;
    seen.add(key); list.push(line);
  }
  const selected = new Set([...v4.slice(0, v6.length ? 4 : 8), ...v6.slice(0, v4.length ? 4 : 8)]);
  const filtered = lines.filter(line => !line.startsWith('a=remote-candidates:') && (!line.startsWith('a=candidate:') || selected.delete(line)));
  if (!filtered.includes('a=end-of-candidates')) filtered.push('a=end-of-candidates');
  return { type: 'offer', sdp: filtered.join('\r\n') };
}
