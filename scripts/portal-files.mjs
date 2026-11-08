import { constants, openSync, closeSync, readSync, writeFileSync, fsyncSync, fstatSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
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
const regular = (path, maximum) => {
  try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > maximum) throw Error('配置目标或临时文件不是当前用户的有界普通文件'); return info; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
function processStart(pid) {
  let fd;
  try { fd = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW); const bytes = Buffer.alloc(8193), size = readSync(fd, bytes, 0, bytes.length, 0); if (size > 8192) throw Error('进程身份超过限制'); const text = bytes.subarray(0, size).toString(); return text.slice(text.lastIndexOf(')') + 2).split(' ')[19]; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function writerLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = regular(path, 256); if (!old) continue;
      const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let record;
      try { const bytes = Buffer.alloc(257), size = readSync(input, bytes, 0, bytes.length, 0); if (size > 256) throw Error('门户写入锁过大'); record = JSON.parse(bytes.subarray(0, size)); } finally { closeSync(input); }
      if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !/^\d{1,24}$/.test(record.started || '')) throw Error('门户写入锁损坏，请检查');
      if (processStart(record.pid) === record.started) throw Object.assign(Error('已有门户配置写入，请稍后再试'), { status: 409, outcome: 'rejected' });
      const current = lstatSync(path); if (current.ino !== old.ino || current.dev !== old.dev) throw Error('门户写入锁已变化');
      unlinkSync(path); continue;
    }
    const info = fstatSync(fd);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: processStart(process.pid) })); fsyncSync(fd); }
    catch (error) { unlinkSync(path); throw error; }
    finally { closeSync(fd); }
    return () => { const current = regular(path, 256); if (current?.ino === info.ino && current.dev === info.dev) unlinkSync(path); };
  }
  throw Error('门户写入锁正在变化，请重试');
}

// One <=256 KiB v2 temporary file and one <=256-byte PID/start-time lock per
// fixed configuration path. A legacy .portal-next is left intact and ignored.
export async function portalWrite(path, text, { exclusive = false, valid = () => {} } = {}) {
  if (Buffer.byteLength(text) > 262144) throw Error('输出文件超过 256 KiB');
  valid(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw Error('配置目录必须由当前用户拥有，且不能是链接');
  regular(path, 262144);
  const release = writerLock(path + '.portal-lock'), target = exclusive ? path : path + '.portal-next-v2';
  let fd, created = false;
  try {
    if (!exclusive && regular(target, 262144)) unlinkSync(target);
    valid();
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    valid(); if (!exclusive) { renameSync(target, path); created = false; }
    else created = false;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(target); } finally { release(); } }
}
