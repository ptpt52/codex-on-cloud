import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, chmod, lstat, unlink, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import net from 'node:net';
import http from 'node:http';
import { createAccessControl } from '../panel/access-control.mjs';
import { acquireFileLock } from './file-lock.mjs';

const exec = promisify(execFile), UNIT = 'codex-cloud-panel.service';
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const cancelled = signal => { if (signal?.aborted) throw signal.reason || Error('操作已取消'); };

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('重置目录必须是当前部署用户拥有的普通目录');
  await chmod(path, 0o700);
}
async function boundedFile(path, maximum, optional = false) {
  let file;
  try {
    file = await open(path, FLAGS); const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.size > maximum) throw Error('重置文件不是当前用户的普通文件，或超过大小限制');
    const bytes = Buffer.alloc(maximum + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw Error('重置文件超过大小限制');
    return { text: bytes.subarray(0, bytesRead).toString('utf8'), info };
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}
async function regularTarget(path, maximum = Infinity) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > maximum) throw Error('重置目标或临时文件无效，不会覆盖链接、特殊文件或其他用户文件'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function atomicWrite(path, text, maximum, valid) {
  valid();
  const bytes = Buffer.from(text), temporary = path + '.reset.tmp';
  if (bytes.length > maximum) throw Error('重置内容超过大小限制');
  await regularTarget(path); await regularTarget(temporary, maximum);
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  let file, committed = false;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    valid(); await rename(temporary, path); committed = true;
    const directory = await open(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    if (!committed) await unlink(temporary).catch(() => {});
  }
}
async function execute(args) {
  try { const result = await exec('systemctl', ['--user', ...args], { timeout: 20000, maxBuffer: 4096 }); return { status: 0, stdout: result.stdout }; }
  catch { return { status: 1, stdout: '' }; }
}
async function serviceState(run, root) {
  const result = await run(['show', UNIT, '--property=LoadState,ActiveState,WorkingDirectory']);
  if (result.status !== 0) throw Error('无法访问 systemd 用户服务，请使用部署用户执行，不要 sudo');
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.LoadState === 'not-found') return { active: false };
  if (fields.LoadState !== 'loaded' || !['active', 'inactive', 'failed'].includes(fields.ActiveState)) throw Error('网页面板正在切换状态或服务配置无效，请稍后重试');
  if (!fields.WorkingDirectory || await realpath(fields.WorkingDirectory) !== await realpath(root)) throw Error('网页面板属于其他项目目录，不会停止或修改它');
  return { active: fields.ActiveState === 'active' };
}
async function portFree(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const fail = () => { socket.destroy(); reject(Error('面板端口仍在使用或无法确认已停止，请先停止手动运行的面板')); };
    socket.setTimeout(1000); socket.once('connect', fail); socket.once('timeout', fail);
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(Error('无法确认面板端口已空闲')); });
  });
}
async function health({ port, origin }) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ready = await new Promise(resolve => {
      let timer;
      const finish = value => { clearTimeout(timer); resolve(value); };
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { host: new URL(origin).host }, timeout: 500 }, res => {
        let size = 0; const chunks = [];
        res.on('data', bytes => { size += bytes.length; if (size > 4096) res.destroy(); else chunks.push(bytes); });
        res.on('end', () => { try { finish(res.statusCode === 200 && JSON.parse(Buffer.concat(chunks)).ok === true); } catch { finish(false); } });
        res.on('error', () => finish(false)); res.on('close', () => finish(false));
      });
      timer = setTimeout(() => { req.destroy(); finish(false); }, 500);
      req.on('timeout', () => req.destroy()); req.on('error', () => finish(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('网页面板未恢复健康，请运行 systemctl --user status codex-cloud-panel.service 检查');
}
export function validatePassword(value, target) {
  const minimum = target === 'admin' ? 16 : 4, maximum = target === 'admin' ? 512 : 128;
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\r\n\0]/.test(value) || target === 'admin' && value !== value.trim()) throw Error(`密码需为 ${minimum}–${maximum} 个字符的单行文本${target === 'admin' ? '，首尾不能有空白' : ''}`);
}

// Host-user maintenance only. No HTTP route, password argument, or secret log.
export async function resetPassword(options, { root, platform = process.platform, uid = process.getuid?.(),
  run = execute, ensureStopped = portFree, checkHealth = health, prompt, signal, log = console.log } = {}) {
  if (platform !== 'linux' || uid === 0 || uid === undefined) throw Error('请在 Linux 服务器上使用普通部署用户执行，不要 sudo');
  if (!['admin', 'screen', 'unlock'].includes(options.target) || options.generate && options.target !== 'admin') throw Error('重置目标无效；自动生成仅支持管理员密码');
  const file = await boundedFile(join(root, '.env'), 16384), config = parseEnv(file.text);
  const username = config.ADMIN_USER || 'admin', origin = new URL(config.PUBLIC_ORIGIN || 'http://localhost:36080'), port = Number(config.PORT ?? config.PANEL_PORT ?? 36080);
  if (username.length > 100 || /[\r\n\0]/.test(username) || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin.length > 2048 || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('部署配置无效，请先检查 .env 的账号、入口和端口');
  const initial = await serviceState(run, root);
  log('此操作只更新登录或屏幕锁。运行中的网页面板将短暂停止，现有端口映射需重新配对；桌面和 Codex 任务继续运行。');
  const password = options.target === 'unlock' ? undefined : options.generate ? randomBytes(32).toString('base64url') : await prompt(options.target);
  if (options.target !== 'unlock') validatePassword(password, options.target);
  cancelled(signal);
  const dataDir = join(root, 'data', 'panel'), secrets = join(root, 'secrets');
  await privateDirectory(dataDir);
  let lease;
  try { lease = await acquireFileLock(join(dataDir, 'password-reset.lock'), { legacy: true }); }
  catch (error) { if (error.status === 409) error.message = '已有密码重置正在执行，请稍后再试'; throw error; }
  const valid = () => { cancelled(signal); lease.check(); };
  let stopped = false, attempted = false, failure;
  try {
    if (options.target === 'admin') {
      await privateDirectory(secrets);
      for (const name of ['panel_password', 'credentials.txt']) { await regularTarget(join(secrets, name)); await regularTarget(join(secrets, name) + '.reset.tmp', 4096); }
    } else await createAccessControl({ dataDir, username }); // Validate before interrupting a live panel; reload after it stops.
    const current = await serviceState(run, root);
    if (current.active !== initial.active) throw Error('网页面板状态已变化，请重新执行重置');
    valid();
    if (initial.active) {
      stopped = true;
      if ((await run(['stop', UNIT])).status !== 0) throw Error('无法停止网页面板，本次不会写入密码');
      if ((await serviceState(run, root)).active) throw Error('网页面板仍在运行，本次不会写入密码');
    }
    await ensureStopped(port); valid(); attempted = true;
    if (options.target === 'admin') {
      await atomicWrite(join(secrets, 'panel_password'), password + '\n', 2048, valid);
      await atomicWrite(join(secrets, 'credentials.txt'), `工作台：${origin.origin}\n用户名：${username}\n密码：${password}\n\n实际入口以 .env 为准。请妥善保管，不要提交到 Git。\n`, 4096, valid);
    } else {
      const access = await createAccessControl({ dataDir, username });
      await access.saveScreen(options.target === 'unlock' ? { enabled: false } : { enabled: true, password }, valid);
    }
  } catch (error) {
    failure = attempted ? Error(options.target === 'admin' ? '重置未完成，密码可能已更新；请以 secrets/panel_password 为准，并检查凭据文件和磁盘状态。' : '重置未完成，请检查访问设置和磁盘状态后再确认结果。', { cause: error }) : error;
  } finally {
    try {
      if (stopped) {
        lease.check();
        if ((await run(['start', UNIT])).status !== 0) throw Error('网页面板未能恢复，请运行 systemctl --user start codex-cloud-panel.service');
        await checkHealth({ port, origin: origin.origin });
      }
    } catch (error) { failure = Error(`${failure ? failure.message + '\n' : attempted ? '密码设置可能已更新；' : ''}${error.message}`, { cause: error }); }
    finally { await lease.release(); }
  }
  if (failure) throw failure;
  log(options.target === 'admin' ? '管理员密码已重置，登录信息已同步到 secrets/credentials.txt；旧登录失效。' : options.target === 'screen' ? '屏幕锁密码已重设并开启。使用新密码解锁。' : '屏幕锁已关闭。登录后可重新设置密码并开启。');
  if (!initial.active) log('网页面板原本未运行，保持停止状态。需要时执行 systemctl --user start codex-cloud-panel.service。');
  return { target: options.target, panelRestarted: stopped };
}
