import { isIP } from 'node:net';

export function loginClient(req, trusted = false) {
  const canonical = ip => isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
  const valid = ip => typeof ip === 'string' && !ip.includes('%') && isIP(ip);
  if (trusted) {
    const address = req.headers['cf-connecting-ip'], ipv6 = req.headers['cf-connecting-ipv6'];
    // Missing, duplicated or malformed edge headers share a fixed fallback.
    if (!valid(address)) return 'tunnel:unknown';
    return 'tunnel:' + canonical(valid(ipv6) === 6 ? ipv6 : address);
  }
  return 'socket:' + (req.socket.remoteAddress || 'unknown');
}
