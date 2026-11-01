import { createHash, randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(rawScrypt);
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function equal(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createAuth(config) {
  const salt = randomBytes(32);
  const passwordHash = await scrypt(config.password, salt, 64);
  const revision = tokenHash(config.password);
  const sessions = new Map();
  const file = join(config.dataDir, 'sessions.json');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'));
    if (stored.revision === revision && Array.isArray(stored.sessions)) {
      for (const item of stored.sessions.slice(-8)) {
        if (/^[a-f0-9]{64}$/.test(item.hash) && typeof item.csrf === 'string' && item.expires > Date.now()) sessions.set(item.hash, item);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('登录状态文件无法读取，请检查 data/panel/sessions.json', { cause: error });
  }
  let saving = Promise.resolve();
  function save() {
    saving = saving.catch(() => {}).then(async () => {
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({ revision, sessions: [...sessions.values()] }), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, file);
    });
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
      return session && session.expires > Date.now() ? session : null;
    },
    async create() {
      const token = randomBytes(32).toString('hex');
      const session = { hash: tokenHash(token), csrf: randomBytes(24).toString('hex'), expires: Date.now() + config.sessionMs };
      for (const [hash, value] of sessions) if (value.expires <= Date.now()) sessions.delete(hash);
      while (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
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
