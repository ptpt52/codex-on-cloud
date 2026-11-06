import { createHash, randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, chmod, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(rawScrypt);
export const SESSION_FILE_LIMIT = 16 * 1024;
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function equal(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createAuth(config, { validSession = () => true } = {}) {
  const salt = randomBytes(32);
  const passwordHash = await scrypt(config.password, salt, 64);
  // Older panels do not understand roles. A separate revision domain makes
  // them discard these cookies on rollback instead of promoting guests.
  const legacyRevision = tokenHash(config.password);
  const revision = tokenHash('codex-cloud-role-sessions-v1\0' + config.password);
  const sessions = new Map();
  const file = join(config.dataDir, 'sessions.json');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) throw new Error('登录状态目录必须由当前用户拥有');
  await chmod(config.dataDir, 0o700);
  let source;
  try {
    source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await source.stat();
    if (!info.isFile() || info.size > SESSION_FILE_LIMIT || info.uid !== process.getuid()) throw new Error('Invalid session file');
    const bytes = Buffer.alloc(SESSION_FILE_LIMIT + 1), { bytesRead } = await source.read(bytes, 0, bytes.length, 0);
    if (bytesRead > SESSION_FILE_LIMIT) throw new Error('Oversized session file');
    const stored = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    const legacy = stored.revision === legacyRevision;
    if ((stored.revision === revision || legacy) && Array.isArray(stored.sessions)) {
      for (const item of stored.sessions.slice(-12)) {
        if (item && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash) && typeof item.csrf === 'string' && /^[a-f0-9]{48}$/.test(item.csrf) && Number.isSafeInteger(item.expires) && item.expires > Date.now()) {
          if (legacy && item.role !== undefined) continue;
          const role = item.role ?? 'admin';
          if (!['admin', 'temporary'].includes(role)) continue;
          const value = { hash: item.hash, csrf: item.csrf, expires: item.expires, role,
            ...(role === 'temporary' ? { username: item.username, credentialRevision: item.credentialRevision } : {}) };
          if (role === 'temporary' && (!/^[A-Za-z0-9_-]{1,64}$/.test(value.username || '') || !/^[a-f0-9]{32}$/.test(value.credentialRevision || ''))) continue;
          if (validSession(value)) sessions.set(item.hash, value);
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('登录状态文件无法读取，请检查 data/panel/sessions.json', { cause: error });
  } finally { await source?.close(); }
  for (const role of ['admin', 'temporary']) {
    const maximum = role === 'admin' ? 8 : 4;
    while ([...sessions.values()].filter(value => value.role === role).length > maximum) sessions.delete([...sessions.values()].find(value => value.role === role).hash);
  }
  let saving = Promise.resolve(), writing = false, dirty = false;
  async function persist() {
    const temp = `${file}.tmp`;
    let target, created = false;
    try {
      try {
        const old = await lstat(temp);
        if (!old.isFile() || old.isSymbolicLink() || old.uid !== process.getuid()) throw new Error('Invalid session temporary file');
        await unlink(temp);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      target = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      await target.writeFile(JSON.stringify({ revision, sessions: [...sessions.values()] }));
      await target.sync(); await target.close(); target = undefined;
      await rename(temp, file); created = false;
    } finally { await target?.close(); if (created) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  function save() {
    // One writer and one dirty bit, rather than one queued write per request.
    dirty = true;
    if (writing) return saving;
    writing = true;
    saving = (async () => {
      try { while (dirty) { dirty = false; await persist(); } }
      finally { writing = false; }
    })();
    return saving;
  }
  await save();
  return {
    async verify(username, password) {
      if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || password.length > 512) return false;
      const actual = await scrypt(password, salt, 64);
      return timingSafeEqual(actual, passwordHash) && equal(username, config.username);
    },
    get(token) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
      const session = sessions.get(tokenHash(token));
      return session && session.expires > Date.now() && validSession(session) ? session : null;
    },
    async create(identity = { role: 'admin' }) {
      if (!['admin', 'temporary'].includes(identity.role)) throw Error('登录权限无效');
      if (identity.role === 'temporary' && (!/^[A-Za-z0-9_-]{1,64}$/.test(identity.username || '') || !/^[a-f0-9]{32}$/.test(identity.credentialRevision || '') || !Number.isSafeInteger(identity.expires))) throw Error('临时登录授权无效');
      const token = randomBytes(32).toString('hex');
      const session = { hash: tokenHash(token), csrf: randomBytes(24).toString('hex'), expires: Math.min(Date.now() + config.sessionMs, identity.expires ?? Infinity), role: identity.role,
        ...(identity.role === 'temporary' ? { username: identity.username, credentialRevision: identity.credentialRevision } : {}) };
      for (const [hash, value] of sessions) if (value.expires <= Date.now() || !validSession(value)) sessions.delete(hash);
      const maximum = identity.role === 'temporary' ? 4 : 8;
      while ([...sessions.values()].filter(value => value.role === identity.role).length >= maximum) {
        const oldest = [...sessions.values()].find(value => value.role === identity.role); sessions.delete(oldest.hash);
      }
      sessions.set(session.hash, session);
      await save();
      return { token, session };
    },
    async revoke(token) {
      if (token) sessions.delete(tokenHash(token));
      await save();
    },
    close: () => saving,
  };
}

export function cookieToken(header = '') {
  return header.split(';').map(part => part.trim()).find(part => part.startsWith('coc_session='))?.slice(12);
}

export function sessionCookie(token, config, expired = false) {
  return `coc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : Math.floor(config.sessionMs / 1000)}${config.secureCookies ? '; Secure' : ''}`;
}
