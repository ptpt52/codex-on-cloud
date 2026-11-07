import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
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
export async function portalWrite(path, text, { exclusive = false } = {}) {
  if (Buffer.byteLength(text) > 262144) throw Error('输出文件超过 256 KiB');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw Error('配置目录必须由当前用户拥有，且不能是链接');
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('配置目标不是当前用户拥有的普通文件'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = exclusive ? path : path + '.portal-next';
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  if (!exclusive) { try { await rename(target, path); } finally { await unlink(target).catch(() => {}); } }
}
