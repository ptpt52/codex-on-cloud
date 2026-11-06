import { constants, openSync, closeSync, readSync, fstatSync, fsyncSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { forwardTargetHost, forwardDeviceName } from './forward.mjs';

export const DEVICE_LIMIT = 16, DEVICE_FILE_LIMIT = 16384;
const fail = (status, message) => Object.assign(Error(message), { status, outcome: 'rejected' });
function validate(value, stored = false) {
  const allowed = ['name', 'targetHost', 'targetPort', 'localPort', 'protocol', 'id'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, '设备资料格式无效');
  if ((stored || value.id !== undefined) && (typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id))) throw fail(400, '设备标识无效');
  if (!Number.isInteger(value.targetPort) || value.targetPort < 1 || value.targetPort > 65535 || !Number.isInteger(value.localPort) || value.localPort < 1024 || value.localPort > 65535 || !['ssh', 'telnet', 'tcp'].includes(value.protocol)) throw fail(400, '设备端口或协议无效');
  return { id: value.id, name: forwardDeviceName(value.name), targetHost: forwardTargetHost(value.targetHost), targetPort: value.targetPort, localPort: value.localPort, protocol: value.protocol };
}
// One 16 KiB file plus one fixed atomic temporary file; synchronous mutations
// admit no queue. Only addresses and labels are stored, never authorizations.
export function createDeviceDirectory(directory) {
  const file = join(directory, 'devices.json'), temporary = file + '.tmp';
  let devices = [], fd;
  const owned = info => info.uid === process.getuid();
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || !owned(parent)) throw Error('设备目录必须是当前用户拥有的真实目录');
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.size > DEVICE_FILE_LIMIT) throw Error('设备目录文件无效');
    const bytes = Buffer.alloc(DEVICE_FILE_LIMIT + 1), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > DEVICE_FILE_LIMIT) throw Error('设备目录文件过大');
    const saved = JSON.parse(bytes.subarray(0, size).toString());
    if (saved.version !== 1 || !Array.isArray(saved.devices) || saved.devices.length > DEVICE_LIMIT) throw Error('设备目录格式无效');
    devices = saved.devices.map(value => validate(value, true));
    if (new Set(devices.map(value => value.id)).size !== devices.length) throw Error('设备标识重复');
  } catch (error) { if (error.code !== 'ENOENT') throw Error('设备目录无法读取，请检查 data/panel/devices.json', { cause: error }); }
  finally { if (fd !== undefined) closeSync(fd); }
  function persist(next) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, devices: next }) + '\n');
    if (bytes.length > DEVICE_FILE_LIMIT) throw fail(409, '设备目录容量已满');
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || !owned(parent)) throw Error('设备目录无效');
    try {
      const old = lstatSync(temporary);
      if (!old.isFile() || !owned(old)) throw Error('设备目录临时文件无效');
      unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let created = false;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); created = true;
      const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file); devices = next;
    } finally { if (created) { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
  }
  return {
    list: () => ({ devices: devices.map(value => ({ ...value })), limit: DEVICE_LIMIT }),
    find: id => devices.find(value => value.id === id),
    save(body) {
      const value = validate(body), existing = devices.find(item => item.id === value.id);
      if (value.id && !existing) throw fail(404, '设备条目不存在，请刷新目录');
      if (!existing && devices.length >= DEVICE_LIMIT) throw fail(409, '最多保存 16 个设备');
      const next = { ...value, id: existing?.id || randomBytes(16).toString('hex') };
      persist(existing ? devices.map(item => item.id === next.id ? next : item) : [...devices, next]);
      return { ...next };
    },
    remove(body) {
      if (!body || Object.keys(body).join(',') !== 'id' || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) throw fail(400, '设备标识无效');
      persist(devices.filter(value => value.id !== body.id)); return { ok: true };
    },
  };
}
