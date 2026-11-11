import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// One private backup, at most 32 regular files / 8 MiB plus a 32 KiB manifest.
// Backups survive failed restoration; recovery never runs commands from disk.
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_MANIFEST = 32768;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function info(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function bounded(path, limit) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await fd.stat(); if (!stat.isFile() || stat.size > limit) throw Error('更新备份文件类型或大小无效');
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const { bytesRead } = await fd.read(bytes, count, bytes.length - count, count); if (!bytesRead) break; count += bytesRead; }
    const after = await fd.stat();
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('更新备份文件正在修改');
    return bytes.subarray(0, count);
  } finally { await fd.close(); }
}

export async function serverUpdate({ directory, files, application, services, run, recover = false }) {
  if (files.length > 32 || new Set(files).size !== files.length) throw Error('更新备份路径无效');
  const manifestFile = join(directory, 'manifest.json'); let state;
  const save = async () => {
    const bytes = JSON.stringify(state); if (Buffer.byteLength(bytes) > MAX_MANIFEST) throw Error('更新恢复记录过大');
    const next = manifestFile + '.next'; await writeFile(next, bytes, { mode: 0o600 }); await rename(next, manifestFile);
  };
  if (recover) {
    const stat = await info(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('更新备份目录无效');
    state = JSON.parse(await bounded(manifestFile, MAX_MANIFEST));
    if (typeof state.committed !== 'boolean') throw Error('更新提交状态无效');
    if (state.version !== 1 || !Array.isArray(state.files) || state.files.length !== files.length || state.files.some((entry, index) => entry.path !== files[index] || typeof entry.exists !== 'boolean' || entry.exists && (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isInteger(entry.uid) || entry.uid < 0 || !Number.isInteger(entry.gid) || entry.gid < 0)) || state.files.reduce((sum, entry) => sum + (entry.size || 0), 0) > MAX_TOTAL || typeof state.applicationChanged !== 'boolean' || state.applicationBefore !== null && (!Number.isSafeInteger(state.applicationBefore?.dev) || !Number.isSafeInteger(state.applicationBefore?.ino)) || !Array.isArray(state.services) || state.services.length !== services.length || state.services.some((entry, index) => entry.name !== services[index] || typeof entry.active !== 'boolean' || typeof entry.enabled !== 'boolean')) throw Error('更新恢复记录无效');
  } else {
    if (await info(directory)) throw Error('存在未完成的服务器更新，请先运行 selfhost-server.sh recover');
    await mkdir(directory, { mode: 0o700 });
    try {
      const app = await info(application.current);
      if (app && (!app.isDirectory() || app.isSymbolicLink())) throw Error('应用目录无效');
      state = { version: 1, files: [], services: [], committed: false, applicationChanged: false, applicationBefore: app ? { dev: app.dev, ino: app.ino } : null };
      let total = 0;
      for (const [index, path] of files.entries()) {
        const stat = await info(path);
        if (!stat) { state.files.push({ path, exists: false }); continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('拒绝备份非普通配置文件：' + path);
        const bytes = await bounded(path, MAX_FILE); total += bytes.length;
        if (total > MAX_TOTAL) throw Error('更新配置备份超过 8 MiB');
        await writeFile(join(directory, String(index)), bytes, { flag: 'wx', mode: 0o600 });
        state.files.push({ path, exists: true, hash: hash(bytes), size: bytes.length, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid });
      }
      for (const name of services) {
        const active = await run('systemctl', ['is-active', name]), enabled = await run('systemctl', ['is-enabled', name]);
        state.services.push({ name, active: active.ok && active.stdout === 'active', enabled: enabled.ok && ['enabled', 'enabled-runtime'].includes(enabled.stdout) });
      }
      await save();
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  const required = async args => { const value = await run('systemctl', args); if (!value.ok) throw Error('恢复服务失败：systemctl ' + args.join(' ')); };
  return {
    get committed() { return state.committed === true; },
    async applicationChanging() { state.applicationChanged = true; await save(); },
    async commit() {
      state.committed = true;
      try { await save(); } catch (error) { state.committed = false; throw error; }
      await rm(directory, { recursive: true, force: true });
    },
    async rollback() {
      if (state.committed) { await rm(directory, { recursive: true, force: true }); return { committed: true }; }
      const stopped = await run('systemctl', ['stop', ...services]);
      if (!stopped.ok) for (const name of services) {
        const active = await run('systemctl', ['is-active', name]);
        if (!['inactive', 'failed', 'unknown'].includes(active.stdout)) throw Error('无法确认服务已停止：' + name);
      }
      for (const service of state.services) if (!service.enabled) {
        const disabled = await run('systemctl', ['disable', service.name]);
        if (!disabled.ok) { const loaded = await run('systemctl', ['show', service.name, '--property=LoadState', '--value']); if (!loaded.ok || loaded.stdout !== 'not-found') throw Error('无法恢复服务自启动状态：' + service.name); }
      }
      for (const [index, entry] of state.files.entries()) {
        const path = entry.path, current = await info(path);
        if (current && (!current.isFile() || current.isSymbolicLink())) throw Error('恢复目标不是普通文件：' + path);
        if (!entry.exists) { if (current) await unlink(path); continue; }
        const backup = join(directory, String(index));
        if (await info(backup)) { const bytes = await bounded(backup, MAX_FILE); if (bytes.length !== entry.size || hash(bytes) !== entry.hash) throw Error('配置备份校验失败'); await rename(backup, path); }
        else if (!current || hash(await bounded(path, MAX_FILE)) !== entry.hash) throw Error('配置备份缺失，保留现场：' + path);
        await chmod(path, entry.mode); await chown(path, entry.uid, entry.gid);
      }
      if (state.applicationChanged) {
        const current = await info(application.current), previous = await info(application.previous), before = state.applicationBefore;
        const original = stat => before && stat?.isDirectory() && !stat.isSymbolicLink() && stat.dev === before.dev && stat.ino === before.ino;
        if (before && !original(current)) {
          if (!original(previous)) throw Error('原应用目录已变化，保留更新备份');
          if (current) { await rm(application.failed, { recursive: true, force: true }); await rename(application.current, application.failed); }
          await rename(application.previous, application.current);
        } else if (!before && current) await rm(application.current, { recursive: true, force: true });
      }
      await required(['daemon-reload']);
      for (const service of state.services) if (service.enabled) await required(['enable', service.name]);
      const active = state.services.filter(service => service.active).map(service => service.name);
      if (active.length) await required(['restart', ...active]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
