import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SELFHOST_LIMITS = Object.freeze({
  keys: 512,
  nodes: 64,
  audit: 512,
  sessions: 64,
  stateBytes: 256 * 1024,
  graceMs: 60_000,
  connectMs: 120_000,
  heartbeatMs: 120_000,
  name: 80,
});

export const SLUG = /^[a-z0-9-]{1,48}$/;
export const NODE_ID = /^[a-f0-9]{32}$/;
export const KEY = /^coc_[A-Za-z0-9_-]{43}$/;
export const CREDENTIAL = /^cocn_[A-Za-z0-9_-]{43}$/;

export function selfhostError(status, message, code = '') {
  return Object.assign(Error(message), { status, code, outcome: 'rejected' });
}

export function slug(value) {
  if (typeof value !== 'string' || !SLUG.test(value)) throw selfhostError(400, '节点路径必须是 1–48 位小写字母、数字或连字符');
  return value;
}

export function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > SELFHOST_LIMITS.name || /[\u0000-\u001f\u007f]/.test(value)) {
    throw selfhostError(400, '显示名称需为 1–80 个可打印字符');
  }
  return value.trim();
}

export function nodeIdentity(value) {
  if (typeof value !== 'string' || !NODE_ID.test(value)) throw selfhostError(400, '节点身份无效');
  return value;
}

export function expiration(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isSafeInteger(value) || value <= now || value > 8_640_000_000_000_000) throw selfhostError(400, '到期时间无效');
  return value;
}

export const entryBasePath = value => '/node/' + slug(value) + '/';
export const proxyName = value => 'node-' + slug(value);
export const randomToken = prefix => prefix + randomBytes(32).toString('base64url');
export const tokenHash = value => createHash('sha256').update(value).digest('hex');

export function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function publicKey(item, session, now = Date.now()) {
  const status = item.revokedAt ? 'revoked' : item.expiresAt !== null && item.expiresAt <= now ? 'expired' : session?.status || 'offline';
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    path: entryBasePath(item.slug),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    revokedAt: item.revokedAt,
    status,
    session: session ? {
      status: session.status,
      nodeId: session.nodeId,
      mode: session.mode,
      source: session.source,
      connectedAt: session.connectedAt,
      authenticatedAt: session.authenticatedAt,
      onlineAt: session.onlineAt,
      lastSeenAt: session.lastSeenAt,
      graceUntil: session.graceUntil,
    } : null,
  };
}
