import { constants, openSync, closeSync, writeFileSync, fsyncSync, lstatSync, mkdirSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileLock } from '../native/file-lock.mjs';
export async function portalRead(path, limit = 65536, privateFile = false) {
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
// One <=256 KiB temporary and one persistent empty, private lock inode. The
// kernel lease survives parent pauses and is released by EOF after parent death.
export async function portalWrite(path, text, { exclusive = false, valid = () => {} } = {}) {
  if (Buffer.byteLength(text) > 262144) throw Error('输出文件超过 256 KiB');
  valid(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw Error('配置目录必须由当前用户拥有，且不能是链接');
  regular(path, 262144);
  let lease;
  try { lease = await acquireFileLock(path + '.portal-lock', { legacy: true }); }
  catch (error) { if (error.status === 409) error.message = '已有门户配置写入，请稍后再试'; throw error; }
  const target = path + '.portal-next-v2';
  let fd, created = false;
  try {
    lease.check();
    const currentParent = lstatSync(dirname(path));
    if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev || !currentParent.isDirectory() || currentParent.isSymbolicLink()) throw Error('配置目录已变化');
    regular(path, 262144);
    if (regular(target, 262144)) unlinkSync(target);
    valid();
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    valid(); lease.check();
    if (exclusive) { linkSync(target, path); unlinkSync(target); }
    else renameSync(target, path);
    created = false;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(target); } finally { await lease.release(); } }
}
