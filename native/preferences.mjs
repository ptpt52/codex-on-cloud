import { constants, openSync, closeSync, readSync, fstatSync, fsyncSync, mkdirSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function validatePreferences(value, stored = false) {
  const keys = stored ? ['version', 'width', 'height', 'fontSize'] : ['width', 'height', 'fontSize'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || (stored && value.version !== 1)) throw new Error('桌面设置格式无效');
  for (const key of ['width', 'height']) if (!Number.isInteger(value[key]) || value[key] < 320 || value[key] > 4096) throw new Error('桌面宽高必须为 320–4096 的整数');
  if (!Number.isInteger(value.fontSize) || value.fontSize < 10 || value.fontSize > 28) throw new Error('终端字号必须为 10–28 的整数');
  return { width: value.width, height: value.height, fontSize: value.fontSize };
}
export const preferenceRevision = value => createHash('sha256').update(JSON.stringify(validatePreferences(value))).digest('hex');
export function readPreferences(file, fallback) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) throw new Error('桌面设置文件必须是小于 1 KiB 的普通文件');
    const bytes = Buffer.alloc(1025);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 1024) throw new Error('桌面设置文件过大');
    return validatePreferences(JSON.parse(bytes.subarray(0, count).toString('utf8')), true);
  } catch (error) {
    if (error.code === 'ENOENT') return validatePreferences(fallback);
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function writePreferences(file, value) {
  const preferences = validatePreferences(value);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('桌面设置目录必须由当前用户拥有');
  const temp = `${file}.tmp`;
  try {
    try {
      const old = lstatSync(temp);
      if (!old.isFile() || old.isSymbolicLink() || (process.getuid && old.uid !== process.getuid())) throw new Error('桌面设置临时文件无效');
      unlinkSync(temp);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeFileSync(temp, JSON.stringify({ version: 1, ...preferences }) + '\n', { flag: 'wx', mode: 0o600 });
    const fd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return preferences;
}
