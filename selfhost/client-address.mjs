import net from 'node:net';

export const loopbackAddress = address => /^(?:::ffff:)?127\.0\.0\.1$/.test(address || '') || address === '::1';

function canonical(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  const bracketed = text.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracketed) text = bracketed[1];
  return net.isIP(text) ? text : '';
}

export function clientAddress(req) {
  const direct = canonical(req.socket?.remoteAddress);
  if (!loopbackAddress(req.socket?.remoteAddress)) return direct;
  const header = req.headers?.['x-forwarded-for'];
  if (typeof header === 'string') for (const value of header.split(',')) {
    const address = canonical(value);
    if (address) return address;
  }
  return direct;
}
