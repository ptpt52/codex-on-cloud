import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, chmod, unlink, open, readFile } from 'node:fs/promises';
import { constants, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { settings } from './config.mjs';
import { terminalEnvironment } from './deployment-mode.mjs';
import { acquireTerminalLease } from './terminal-lease.mjs';

// This service owns tmux. Browsers, panels, file helpers and managers own
// only clients; restarting them cannot terminate a shell or replay its input.
const config = settings(), exec = promisify(execFile), env = terminalEnvironment(config);
const socket = env.TMUX_SOCKET, lock = join(config.runtime, 'terminal.pid');
let lease, serverOwned = false, serverSocket, serverProcess, stopping = false;
let starting = true, stopRequested = false;
let monitor, probing = false;
const tmux = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 16384 });
async function stop(code = 0, cleanup = true) {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  if (cleanup && serverOwned && serverSocket) {
    try {
      const current = await lstat(socket, { bigint: true });
      // tmux changes socket permission bits as clients attach/detach. Those
      // changes update ctime without replacing the owned listening socket.
      if (current.ino === serverSocket.ino && current.dev === serverSocket.dev) await tmux(['kill-server']);
    } catch {}
  }
  await lease?.release();
  process.exit(code);
}
async function processIdentity(pid) {
  const value = await readFile('/proc/' + pid + '/stat', 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
  if (!/^[0-9]+$/.test(fields[19])) throw Error('无法确认 tmux 进程身份');
  return { started: fields[19], state: fields[0] };
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (starting) stopRequested = true; else void stop(); });
try {
  if (config.mode !== 'terminal' || process.getuid() === 0) throw Error('纯终端服务需要普通用户及 DEPLOY_MODE=terminal');
  process.umask(0o077);
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.runtime);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) throw Error('运行目录无效');
  await chmod(config.runtime, 0o700);
  lease = await acquireTerminalLease(join(config.runtime, 'terminal.lock'));
  let legacy;
  try {
    const file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let pid;
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.size > 32n || info.uid !== BigInt(process.getuid()) || info.nlink !== 1n) throw Error('终端服务锁文件无效');
      const bytes = Buffer.alloc(33), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32 || BigInt(bytesRead) !== info.size) throw Error('终端服务锁文件过大或正在修改');
      const value = bytes.subarray(0, bytesRead).toString('utf8');
      if (value && !/^[1-9]\d{0,9}\n?$/.test(value)) throw Error('终端服务锁文件无效');
      pid = value ? Number(value) : undefined; legacy = info;
    } finally { await file.close(); }
    if (pid !== undefined) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw Error('已有终端服务，不会接管');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const info = await lstat(socket);
    if (!info.isSocket() || info.uid !== process.getuid()) throw Error('已有无效的 tmux socket');
    const active = await new Promise(resolve => {
      const probe = net.createConnection(socket);
      probe.setTimeout(500);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('timeout', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
    });
    if (active) throw Error('已有私有 tmux 服务，不会接管');
    await unlink(socket);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lease.check();
  if (legacy) {
    const current = lstatSync(lock, { bigint: true });
    if (!['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => current[key] === legacy[key])) throw Error('旧终端锁已变化，不会接管');
    unlinkSync(lock);
  }
  await mkdir(config.workspace, { recursive: true }); await mkdir(config.transfer, { recursive: true });
  // systemd-enabled tmux otherwise moves panes into independent scopes. Block
  // the bus only in the server process, and remove the override from tmux's
  // shell environment before spawning any task (including the keeper).
  const serverEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' };
  lease.check();
  // One hidden fixed keeper session keeps the server in this service's cgroup
  // even when all eight user terminals have exited. It accepts no browser input.
  const started = await exec('tmux', ['-f', join(config.root, 'desktop', 'tmux.conf'), '-S', socket,
    'start-server', ';', 'set-environment', '-gu', 'DBUS_SESSION_BUS_ADDRESS', ';',
    'new-session', '-d', '-s', 'codex-host', '-c', config.workspace, 'sleep', 'infinity', ';',
    'display-message', '-p', '-t', '=codex-host:0.0', '#{pid}'], { env: serverEnv, timeout: 5000, maxBuffer: 16384 });
  serverOwned = true; await chmod(socket, 0o600);
  serverSocket = await lstat(socket, { bigint: true });
  const pid = started.stdout.trim();
  if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid))) throw Error('无法确认 tmux 服务身份');
  serverProcess = { pid: Number(pid), ...await processIdentity(pid) };
  await tmux(['new-session', '-d', '-s', 'codex', '-c', config.workspace, 'bash', join(config.root, 'desktop', 'codex-session')]);
  starting = false;
  if (stopRequested) await stop();
  monitor = setInterval(async () => {
    if (probing || stopping) return;
    probing = true;
    // A failed tmux query (or a missing keeper) says nothing about task
    // lifetime. Only the owned process exiting can end this service. Never
    // kill a server as a side effect of a health/readiness observation.
    try {
      const current = await processIdentity(serverProcess.pid);
      if (current.started !== serverProcess.started || ['Z', 'X'].includes(current.state)) await stop(1, false);
    } catch (error) {
      if (!stopping && ['ENOENT', 'ESRCH'].includes(error.code)) await stop(1, false);
    }
    finally { probing = false; }
  }, 3000);
  console.log('纯网页终端后台已启动，不启动图形桌面或 Codex 任务。');
} catch (error) { starting = false; console.error(error.message); await stop(1); }
