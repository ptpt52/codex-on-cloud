import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { open, mkdir, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireFileLock } from '../native/file-lock.mjs';

const MAX_CONFIG = 65536;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const profileCommand = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("UserProfile")';
const restartNotice = '配置需重启 WSL 后生效：保存任务后，在 Windows PowerShell 执行 wsl --shutdown，再启动原发行版。此操作会结束所有 WSL 终端和 Codex 任务；部署程序不会执行它。';
const changed = () => Object.assign(Error('WSL 配置在部署期间发生变化，未覆盖；请核对后重新运行部署'), { status: 409, outcome: 'rejected' });

// Raw bytes preserve UTF-16/BOMs. Re-read after every asynchronous close, then
// compare and publish synchronously; an absent target uses an exclusive link.
function commitConfig(file, temporary, original, valid = () => {}) {
  valid();
  let fd, current = null;
  try {
    try { fd = openSync(file, READ); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (fd !== undefined) {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_CONFIG)) throw Error('WSL 配置必须是最多 64 KiB 的普通文件');
      const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
      const after = fstatSync(fd, { bigint: true }), path = lstatSync(file, { bigint: true });
      if (count !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== path.ino || before.dev !== path.dev) throw changed();
      current = bytes.subarray(0, count);
    }
  } finally { if (fd !== undefined) closeSync(fd); }
  if (original === null ? current !== null : current === null || !current.equals(original)) throw changed();
  if (original !== null) renameSync(temporary, file);
  else {
    try { linkSync(temporary, file); } catch (error) { if (error.code === 'EEXIST') throw changed(); throw error; }
    unlinkSync(temporary);
  }
}

// The one per-user lease lives on Linux, not DrvFS/NTFS, so Windows filesystem
// lock support is not required. Tests may provide their own private directory.
async function configurationLease(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('WSL 租约目录必须是当前用户的私有 Linux 目录');
  try { return await acquireFileLock(join(directory, '.codex-cloud-wsl.lock')); }
  catch (error) { if (error.status === 409) error.message = '已有 WSL 配置更新正在执行，请稍后重试'; throw error; }
}
function removeTemporary(path, published) {
  let info; try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || info.size > MAX_CONFIG) throw Error('WSL 暂存文件类型、归属或大小无效，已保留');
  if (info.nlink !== 1) {
    let target; try { target = lstatSync(published); } catch {}
    // A crash after exclusive link publication can leave exactly these two
    // names for the same file. Never remove a link to unrelated user data.
    if (info.nlink !== 2 || !target?.isFile() || target.ino !== info.ino || target.dev !== info.dev) throw Error('WSL 暂存文件存在其他硬链接，已保留');
  }
  unlinkSync(path);
}

async function readConfig(file, optional = false) {
  let handle;
  try {
    handle = await open(file, READ);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG) throw Error('WSL 配置及备份必须是最多 64 KiB 的普通文件');
    const bytes = Buffer.alloc(MAX_CONFIG + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_CONFIG) throw Error('WSL 配置超过 64 KiB');
    return bytes.subarray(0, bytesRead);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

export function planWSLConfig(original) {
  const bytes = original || Buffer.alloc(0);
  if (bytes.length > MAX_CONFIG) throw Error('WSL 配置超过 64 KiB');
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bom = utf16 ? bytes.subarray(0, 2) : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? bytes.subarray(0, 3) : Buffer.alloc(0);
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes.subarray(bom.length));
  if (text.includes('\0')) throw Error('WSL 配置包含 NUL');
  const newline = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
  let section = '', start = -1, end = lines.length, key = -1;
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (header) {
      if (section === 'experimental') end = index;
      section = header[1].trim().toLowerCase();
      if (section === 'experimental') {
        if (start !== -1) throw Error('WSL 配置存在重复的 [experimental]，请先合并');
        start = index;
      }
    } else if (section === 'experimental' && /^\s*hostAddressLoopback\s*=/i.test(lines[index])) {
      if (key !== -1) throw Error('WSL 配置存在重复的 hostAddressLoopback，请先合并');
      key = index;
    }
  }
  if (key !== -1) {
    const match = lines[key].match(/^(\s*hostAddressLoopback\s*=\s*)([^#;]*?)(\s*(?:[#;].*)?)$/i);
    if (match[2].trim().toLowerCase() === 'true') return { changed: false, bytes };
    lines[key] = match[1] + 'true' + match[3];
  } else if (start !== -1) lines.splice(end, 0, 'hostAddressLoopback=true');
  else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push('[experimental]', 'hostAddressLoopback=true');
  }
  if (lines.at(-1) !== '') lines.push('');
  const updated = Buffer.concat([bom, Buffer.from(lines.join(newline), utf16 ? 'utf16le' : 'utf8')]);
  if (updated.length > MAX_CONFIG) throw Error('更新后的 WSL 配置超过 64 KiB');
  return { changed: true, bytes: updated };
}

export async function updateWSLConfig(file, { check = false, leaseDirectory = '/tmp/codex-cloud-wsl-' + process.getuid() } = {}) {
  let original = await readConfig(file, true), plan = planWSLConfig(original);
  if (!plan.changed || check) return { changed: false, needsConfiguration: plan.changed };
  const backup = file + '.codex-cloud.before-loopback', temporary = file + '.codex-cloud.tmp', backupNext = backup + '.next';
  const lease = await configurationLease(leaseDirectory); let handle, saved;
  const clean = () => { lease.check(); removeTemporary(temporary, file); removeTemporary(backupNext, backup); };
  try {
    // Re-read under the lease; a previous updater may already have finished.
    original = await readConfig(file, true); plan = planWSLConfig(original); lease.check();
    clean();
    if (!plan.changed) return { changed: false, needsConfiguration: false };
    if (original !== null && await readConfig(backup, true) === null) {
      saved = await open(backupNext, CREATE, 0o600);
      await saved.writeFile(original); await saved.sync(); await saved.close(); saved = undefined;
      commitConfig(backup, backupNext, null, lease.check);
    }
    lease.check(); handle = await open(temporary, CREATE, 0o600);
    await handle.writeFile(plan.bytes); await handle.sync();
    await handle.close();
    commitConfig(file, temporary, original, lease.check);
    return { changed: true, needsConfiguration: false, backup: original === null ? null : backup };
  } finally {
    await saved?.close().catch(() => {}); await handle?.close().catch(() => {});
    let owned = false; try { lease.check(); owned = true; } catch {}
    try { if (owned) clean(); } finally { await lease.release(); }
  }
}

async function execute(command, args) {
  try {
    const result = await promisify(execFile)(command, args, { timeout: 10000, maxBuffer: 4096 });
    return { status: 0, stdout: result.stdout };
  } catch { return { status: 1, stdout: '' }; }
}

export async function configureWSLNetwork({ check = false, kernel = release(), run = execute, log = console.log, leaseDirectory } = {}) {
  if (!/microsoft|wsl/i.test(kernel)) return { status: 'not-wsl' };
  async function first(commands, args) {
    for (const command of commands) {
      const result = await run(command, args);
      if (result.status === 0 && result.stdout?.trim()) return result.stdout.trim();
    }
    return '';
  }
  const mode = (await first(['wslinfo', '/usr/lib/wsl/lib/wslinfo'], ['--networking-mode'])).toLowerCase();
  if (mode !== 'mirrored') {
    log(mode ? `WSL 网络模式：${mode}；无需镜像网络回环配置。` : '无法识别 WSL 网络模式；未修改 Windows 配置，排查方法见 docs/wsl.md。');
    return { status: mode || 'unavailable' };
  }
  const windowsProfile = await first(['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'], ['-NoProfile', '-NonInteractive', '-Command', profileCommand]);
  if (!/^[a-z]:\\/i.test(windowsProfile) || windowsProfile.length > 1024 || /[\r\n\0]/.test(windowsProfile)) throw Error('无法识别 Windows 用户目录；请检查 WSL interop，或使用 --skip-wsl-network 并按 docs/wsl.md 手动配置');
  const translated = await run('wslpath', ['-u', windowsProfile]);
  const profile = translated.stdout?.trim();
  if (translated.status !== 0 || !profile || !isAbsolute(profile) || profile.length > 4096 || /[\r\n\0]/.test(profile)) throw Error('无法转换 Windows 用户目录；请检查 wslpath，或使用 --skip-wsl-network');
  const file = join(profile, '.wslconfig'), result = await updateWSLConfig(file, { check, leaseDirectory });
  if (result.needsConfiguration) log(`WSL 镜像网络缺少 hostAddressLoopback=true：${file}；正常部署会自动配置并保留一份原文件备份。`);
  else if (result.changed) {
    log(`已自动配置 WSL 镜像网络 hostAddressLoopback=true：${file}${result.backup ? `；原文件备份：${result.backup}` : ''}`);
    log(restartNotice);
  } else log('WSL 镜像网络已配置 hostAddressLoopback=true；若在本次 WSL 启动后修改，仍需重启 WSL 才会生效。');
  return { ...result, status: 'mirrored', restartRequired: result.changed };
}
