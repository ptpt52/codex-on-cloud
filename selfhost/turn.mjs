import { createHmac } from 'node:crypto';

export const TURN_TTL_MS = 60 * 60 * 1000;

export function turnCredentials({ secret, slug, realm, now = Date.now(), ttlMs = TURN_TTL_MS } = {}) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /[\r\n\0]/.test(secret)) throw Error('TURN shared secret 无效');
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,48}$/.test(slug)) throw Error('TURN 节点路径无效');
  if (typeof realm !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(realm)) throw Error('TURN realm 无效');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > TURN_TTL_MS) throw Error('TURN 凭据有效期无效');
  const expiresAt = Math.floor((now + ttlMs) / 1000), username = `${expiresAt}:${slug}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return {
    expiresAt: expiresAt * 1000,
    ttlMs,
    iceServers: [
      { urls: [`stun:${realm}:3478`] },
      { urls: [`turn:${realm}:3478?transport=udp`, `turn:${realm}:3478?transport=tcp`, `turns:${realm}:5349?transport=tcp`], username, credential },
    ],
  };
}
