import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, chmod, unlink, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { settings } from './config.mjs';
import { terminalEnvironment } from './deployment-mode.mjs';

// This service owns tmux and the file helper. Browsers, panels and managers own
// only clients; restarting them cannot terminate a shell or replay its input.
const config = settings(), exec = promisify(execFile), env = terminalEnvironment(config);
const socket = env.TMUX_SOCKET, lock = join(config.runtime, 'terminal.pid');
let owned = false, serverOwned = false, serverSocket, agent, agentDone, stopping = false;
let starting = true, stopRequested = false;
const tmux = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 16384 });
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (serverOwned && serverSocket) {
    try {
      const current = await lstat(socket, { bigint: true });
      // tmux changes socket permission bits as clients attach/detach. Those
      // changes update ctime without replacing the owned listening socket.
      if (current.ino === serverSocket.ino && current.dev === serverSocket.dev) await tmux(['kill-server']);
    } catch {}
  }
  agent?.kill('SIGTERM');
  const deadline = setTimeout(() => agent?.kill('SIGKILL'), 1500).unref();
  if (agentDone) await agentDone;
  clearTimeout(deadline);
  if (owned) await unlink(lock).catch(() => {});
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (starting) stopRequested = true; else void stop(); });
try {
  if (config.mode !== 'terminal' || process.getuid() === 0) throw Error('纯终端服务需要普通用户及 DEPLOY_MODE=terminal');
  process.umask(0o077);
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.runtime);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) throw Error('运行目录无效');
  await chmod(config.runtime, 0o700);
  try {
    const file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let pid;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 32 || info.uid !== process.getuid()) throw Error('终端服务锁文件无效');
      const bytes = Buffer.alloc(33), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32) throw Error('终端服务锁文件过大');
      const value = bytes.subarray(0, bytesRead).toString('utf8');
      if (!/^[1-9]\d{0,9}\n?$/.test(value)) throw Error('终端服务锁文件无效');
      pid = Number(value);
    } finally { await file.close(); }
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw Error('已有终端服务，不会接管');
    await unlink(lock);
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
  await writeFile(lock, String(process.pid) + '\n', { flag: 'wx', mode: 0o600 }); owned = true;
  await mkdir(config.workspace, { recursive: true }); await mkdir(config.transfer, { recursive: true });
  // One hidden fixed keeper session keeps the server in this service's cgroup
  // even when all four user terminals have exited. It accepts no browser input.
  await exec('tmux', ['-f', join(config.root, 'desktop', 'tmux.conf'), '-S', socket, 'new-session', '-d', '-s', 'codex-host', '-c', config.workspace, 'sleep', 'infinity'], { env, timeout: 5000, maxBuffer: 16384 });
  serverOwned = true; await chmod(socket, 0o600);
  serverSocket = await lstat(socket, { bigint: true });
  await tmux(['new-session', '-d', '-s', 'codex', '-c', config.workspace, 'bash', join(config.root, 'desktop', 'codex-session')]);
  agent = spawn('python3', [join(config.root, 'desktop', 'agent.py')], { env: { ...env, AGENT_PORT: String(config.agentPort), AGENT_SECRET_FILE: join(config.root, 'secrets', 'agent_secret') }, stdio: ['ignore', 'pipe', 'pipe'] });
  agentDone = new Promise(resolve => agent.once('close', resolve));
  let window = Date.now(), bytes = 0;
  const output = chunk => {
    if (Date.now() - window >= 30000) { window = Date.now(); bytes = 0; }
    const part = chunk.subarray(0, Math.max(0, 32768 - bytes)); bytes += part.length; process.stderr.write(part);
  };
  agent.stdout.on('data', output); agent.stderr.on('data', output);
  agent.once('error', () => void stop(1)); agent.once('exit', () => { if (!stopping) void stop(1); });
  starting = false;
  if (stopRequested) await stop();
  console.log('纯网页终端后台已启动，不启动图形桌面或 Codex 任务。');
} catch (error) { starting = false; console.error(error.message); await stop(1); }
