import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, chmod } from 'node:fs/promises';
import { constants, openSync, readSync, fstatSync, closeSync, lstatSync, unlinkSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const scrypt = promisify(rawScrypt);
export const ACCESS_FILE_LIMIT = 8192;
export const TEMPORARY_MAX_MS = 7 * 86400000;
const revision = () => randomBytes(16).toString('hex');
const fail = (status, message) => Object.assign(Error(message), { status, outcome: 'rejected' });
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const password = (value, minimum) => typeof value === 'string' && value.length >= minimum && value.length <= 128 && !value.includes('\0');
const validHash = value => value && /^[a-f0-9]{64}$/.test(value.salt) && /^[a-f0-9]{128}$/.test(value.hash);
async function digest(value) { const salt = randomBytes(32).toString('hex'); return { salt, hash: (await scrypt(value, salt, 64)).toString('hex') }; }
async function verify(value, record) {
  if (typeof value !== 'string' || value.length > 128 || !validHash(record)) return false;
  const actual = await scrypt(value, record.salt, 64);
  return timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}

// One 8 KiB private file and one fixed temporary file. Hashing admits one
// configuration write, with no queue. The bounded commit is synchronous so a
// revoked page cannot commit a setting after an asynchronous password hash.
export async function createAccessControl(config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const parent = () => {
    const info = lstatSync(config.dataDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('访问设置目录无效');
  };
  parent();
  await chmod(config.dataDir, 0o700);
  const file = join(config.dataDir, 'access.json'), temporary = file + '.tmp';
  let state = { version: 1, screen: { enabled: false, revision: revision(), salt: null, hash: null }, temporary: null }, busy = false, fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.size > ACCESS_FILE_LIMIT || (info.mode & 0o077)) throw Error();
    const bytes = Buffer.alloc(ACCESS_FILE_LIMIT + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > ACCESS_FILE_LIMIT) throw Error();
    const value = JSON.parse(bytes.subarray(0, length).toString());
    const screen = value?.screen, guest = value?.temporary;
    if (!fields(value, ['version', 'screen', 'temporary']) || value.version !== 1 || !fields(screen, ['enabled', 'revision', 'salt', 'hash']) || typeof screen.enabled !== 'boolean' || !/^[a-f0-9]{32}$/.test(screen.revision) || (!validHash(screen) && !(screen.salt === null && screen.hash === null && !screen.enabled))) throw Error();
    if (guest !== null && (!fields(guest, ['username', 'revision', 'salt', 'hash', 'expires']) || !/^[A-Za-z0-9_-]{1,64}$/.test(guest.username) || guest.username === config.username || !/^[a-f0-9]{32}$/.test(guest.revision) || !validHash(guest) || !Number.isSafeInteger(guest.expires) || guest.expires < 1)) throw Error();
    state = value;
  } catch (error) { if (error.code !== 'ENOENT') throw Error('访问设置无法读取，请检查 data/panel/access.json', { cause: error }); }
  finally { if (fd !== undefined) closeSync(fd); }
  function persist(next, valid) {
    parent(); valid();
    const bytes = Buffer.from(JSON.stringify(next) + '\n');
    if (bytes.length > ACCESS_FILE_LIMIT) throw fail(409, '访问设置超过大小限制');
    try {
      const info = lstatSync(temporary);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('访问设置临时文件无效');
      unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let created = false;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); created = true;
      const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, file); created = false; state = next;
      const directory = openSync(config.dataDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (created) unlinkSync(temporary); }
  }
  const status = () => ({ screen: { enabled: state.screen.enabled, configured: validHash(state.screen) === true },
    temporary: { enabled: !!state.temporary, active: !!state.temporary && state.temporary.expires > Date.now(), username: state.temporary?.username || '', expires: state.temporary?.expires || null } });
  return {
    status,
    get screenEnabled() { return state.screen.enabled; },
    get screenRevision() { return state.screen.revision; },
    async verifyScreen(value) { const current = state.screen; return current.enabled && await verify(value, current) && state.screen === current; },
    temporaryValid(session) { return !!state.temporary && session.credentialRevision === state.temporary.revision && session.username === state.temporary.username && state.temporary.expires > Date.now(); },
    async verifyTemporary(username, value) {
      const current = state.temporary;
      if (!current || current.username !== username || current.expires <= Date.now()) return null;
      if (!await verify(value, current) || state.temporary !== current || current.expires <= Date.now()) return null;
      return { role: 'temporary', username: current.username, credentialRevision: current.revision, expires: current.expires };
    },
    async saveScreen(body, valid = () => {}) {
      if (!fields(body, ['enabled', 'password']) || typeof body.enabled !== 'boolean' || (body.password !== undefined && typeof body.password !== 'string')) throw fail(400, '屏幕锁设置格式无效');
      if (busy) throw fail(409, '访问设置正在保存，请稍后重试');
      busy = true;
      try {
        const value = body.password || '';
        if (value && !password(value, 4)) throw fail(400, '屏幕锁密码需为 4–128 个字符');
        const hash = value ? await digest(value) : { salt: state.screen.salt, hash: state.screen.hash };
        if (body.enabled && !validHash(hash)) throw fail(400, '请先设置屏幕锁密码');
        valid();
        if (!value && body.enabled === state.screen.enabled) return status();
        persist({ ...state, screen: { enabled: body.enabled, revision: revision(), ...hash } }, valid);
        return status();
      } finally { busy = false; }
    },
    async saveTemporary(body, valid = () => {}) {
      if (!fields(body, ['enabled', 'username', 'password', 'durationMs']) || typeof body.enabled !== 'boolean') throw fail(400, '临时账号设置格式无效');
      if (busy) throw fail(409, '访问设置正在保存，请稍后重试');
      busy = true;
      try {
        if (!body.enabled) { persist({ ...state, temporary: null }, valid); return status(); }
        if (typeof body.username !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.username) || body.username === config.username) throw fail(400, '临时用户名需为 1–64 位字母、数字、下划线或短横线，并与管理员不同');
        if (body.password !== undefined && typeof body.password !== 'string') throw fail(400, '临时密码格式无效');
        const value = body.password || '', duration = body.durationMs ?? 86400000;
        if (!Number.isSafeInteger(duration) || duration < 300000 || duration > TEMPORARY_MAX_MS) throw fail(400, '临时账号有效期需在五分钟至七天之间');
        if (value && !password(value, 8)) throw fail(400, '临时密码需为 8–128 个字符');
        const hash = value ? await digest(value) : state.temporary?.username === body.username ? { salt: state.temporary.salt, hash: state.temporary.hash } : null;
        if (!validHash(hash)) throw fail(400, '请先设置至少 8 位的临时密码');
        persist({ ...state, temporary: { username: body.username, ...hash, expires: Date.now() + duration, revision: revision() } }, valid);
        return status();
      } finally { busy = false; }
    },
  };
}
