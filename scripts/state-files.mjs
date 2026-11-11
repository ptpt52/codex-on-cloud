import { constants, openSync, closeSync, readSync, fstatSync, writeFileSync, fsyncSync, lstatSync, mkdirSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileLock } from '../native/file-lock.mjs';
export async function readStateFile(path, limit = 65536, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > limit || (privateFile && (stat.mode & 0o077))) throw Error('配置文件权限或大小不符合要求');
    const bytes = Buffer.alloc(limit + 1), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > limit || result.bytesRead !== stat.size) throw Error('配置文件超过限制或正在修改');
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally { await file.close(); }
}
const regular = (path, maximum) => {
  try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > maximum) throw Error('配置目标或临时文件不是当前用户的有界普通文件'); return info; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
const conflict = () => Object.assign(Error('配置内容或身份已变化，本次未修改'), { status: 409, outcome: 'rejected' });
function expectation(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 262144) throw Error('预期配置超过256 KiB或类型无效');
  return Buffer.from(value);
}
function compare(path, expected) {
  if (expected === undefined) return;
  if (expected === null) { if (regular(path, 262144)) throw conflict(); return; }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.uid !== BigInt(process.getuid()) || info.size !== BigInt(expected.length)) throw conflict();
    const bytes = Buffer.alloc(expected.length + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (count !== expected.length || !bytes.subarray(0, count).equals(expected) || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs || current.ino !== info.ino || current.dev !== info.dev) throw conflict();
  } catch (error) { if (error.code === 'ENOENT') throw conflict(); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function syncDirectory(path) {
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
async function withLease(path, valid, action) {
  valid(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw Error('配置目录必须由当前用户拥有，且不能是链接');
  regular(path, 262144);
  let lease;
  try { lease = await acquireFileLock(path + '.portal-lock', { legacy: true }); }
  catch (error) { if (error.status === 409) error.message = '已有配置写入，请稍后再试'; throw error; }
  const guard = () => {
    lease.check(); const current = lstatSync(dirname(path));
    if (current.ino !== parent.ino || current.dev !== parent.dev || !current.isDirectory() || current.isSymbolicLink()) throw Error('配置目录已变化');
  };
  try {
    guard(); return action(guard);
  } finally { await lease.release(); }
}

// Retain the legacy on-disk lock and temporary names so existing writers and
// interrupted deployments keep sharing the same leases during upgrades.
// One <=256 KiB temporary and a persistent empty lease inode. Compare inside
// the lease and immediately before committing, with no intervening await.
// Notify committed state before fallible temporary cleanup or directory sync.
export async function writeStateFile(path, text, { exclusive = false, expected, valid = () => {}, committed = () => {} } = {}) {
  if (Buffer.byteLength(text) > 262144) throw Error('输出文件超过 256 KiB');
  const prior = expectation(expected);
  return withLease(path, valid, guard => {
    const target = path + '.portal-next-v2'; let fd, created = false;
    try {
      valid(); compare(path, prior); regular(path, 262144);
      if (regular(target, 262144)) unlinkSync(target);
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
      valid(); guard(); compare(path, prior);
      if (exclusive || prior === null) {
        try { linkSync(target, path); } catch (error) { if (prior === null && error.code === 'EEXIST') throw conflict(); throw error; }
        committed();
        unlinkSync(target);
      }
      else { renameSync(target, path); created = false; committed(); }
      created = false; syncDirectory(path);
    } finally { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(target); }
  });
}
export async function removeStateFile(path, { expected, valid = () => {} } = {}) {
  if (expected === undefined) throw Error('删除配置必须指定预期内容');
  const prior = expectation(expected);
  return withLease(path, valid, guard => {
    valid(); compare(path, prior); valid(); guard(); compare(path, prior);
    if (prior === null) return false;
    unlinkSync(path); syncDirectory(path); return true;
  });
}
