import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, lstat, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { settings } from './config.mjs';

const config = settings();
const children = new Set();
const lock = join(config.runtime, 'desktop.pid');
let stopping = false, ownsLock = false, vncServer, viewerProcess;
let logWindow = Date.now(), logBytes = 0;
function output(bytes) {
  if (Date.now() - logWindow > 30_000) { logWindow = Date.now(); logBytes = 0; }
  const remaining = 32 * 1024 - logBytes;
  if (remaining <= 0) return;
  const chunk = bytes.subarray(0, remaining);
  logBytes += chunk.length;
  process.stderr.write(chunk);
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vncServer?.close();
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 700));
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  if (ownsLock) {
    await unlink(lock).catch(() => {});
    await unlink(config.socket).catch(() => {});
  }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
function start(command, args, env, critical = true, socket) {
  const child = spawn(command, args, { env, stdio: socket ? [socket, socket, 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: true });
  if (child.stdout) child.stdout.on('data', output);
  child.stderr.on('data', output);
  children.add(child);
  child.once('error', error => { console.error(`无法启动 ${command}: ${error.message}`); void stop(1); });
  child.once('exit', (code, signal) => {
    if (socket) children.delete(child);
    if (!stopping && critical) { console.error(`${command} 已退出 (${code ?? signal})，停止本次桌面。`); void stop(1); }
  });
  return child;
}
async function waitFor(probe, description) {
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${description} 启动超时`);
}
try {
  if (process.getuid() === 0) throw new Error('请以普通用户运行桌面，不要使用 sudo');
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  const info = await lstat(config.runtime);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('运行目录必须是当前用户拥有的真实目录');
  await chmod(config.runtime, 0o700);
  try {
    const pid = Number(await readFile(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 1) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new Error('已有桌面进程，请使用 npm run native:status 查看');
    }
    await unlink(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const displayNumber = config.display.slice(1);
  for (const file of [`/tmp/.X${displayNumber}-lock`, `/tmp/.X11-unix/X${displayNumber}`]) {
    try { await access(file); throw new Error(`显示 ${config.display} 已被占用，请修改 DISPLAY_NUMBER；不会接管或删除已有会话`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  ownsLock = true;
  await unlink(config.socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await mkdir(config.transfer, { recursive: true });
  const desktopData = join(config.root, 'data', 'desktop');
  for (const folder of ['config', 'cache', 'share']) await mkdir(join(desktopData, folder), { recursive: true, mode: 0o700 });
  const channelDir = join(desktopData, 'config', 'xfce4', 'xfconf', 'xfce-perchannel-xml');
  await mkdir(channelDir, { recursive: true, mode: 0o700 });
  try { await writeFile(join(channelDir, 'xfce4-panel.xml'), await readFile(join(config.root, 'native', 'panel.xml')), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const fontConfig = join(desktopData, 'fonts.conf');
  await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include>/etc/fonts/fonts.conf</include><dir>${escapeXml(join(config.root, 'data', 'host-tools', 'usr', 'share', 'fonts'))}</dir><cachedir>${escapeXml(join(desktopData, 'cache', 'fontconfig'))}</cachedir></fontconfig>`, { mode: 0o600 });
  const xauthority = join(config.runtime, 'Xauthority');
  await writeFile(xauthority, '', { mode: 0o600 });
  await chmod(xauthority, 0o600);
  const env = {
    ...config.env, DISPLAY: config.display, XAUTHORITY: xauthority,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', FONTCONFIG_FILE: fontConfig,
    PATH: `${join(config.root, 'data', 'host-tools', 'usr', 'bin')}:${config.env.PATH}`,
    WORKSPACE_DIR: config.workspace, TRANSFER_DIR: config.transfer,
    TMUX_SOCKET: join(config.runtime, 'tmux.sock'),
    AGENT_PORT: String(config.agentPort), AGENT_SECRET_FILE: join(config.root, 'secrets', 'agent_secret'),
    XDG_CONFIG_HOME: join(desktopData, 'config'), XDG_CACHE_HOME: join(desktopData, 'cache'), XDG_DATA_HOME: join(desktopData, 'share'),
    XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE',
  };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.SESSION_MANAGER;
  const auth = spawnSync('xauth', ['-f', xauthority, 'add', config.display, '.', randomBytes(16).toString('hex')], { env, stdio: 'inherit' });
  if (auth.status !== 0) throw new Error('无法生成独立 Xauthority');
  start('Xvfb', [config.display, '-screen', '0', `${config.size}x24`, '-nolisten', 'tcp', '-auth', xauthority, '-noreset'], env);
  await waitFor(() => spawnSync('xdpyinfo', [], { env, stdio: 'ignore', timeout: 1000 }).status === 0, '独立显示');
  start('dbus-run-session', ['--', 'bash', join(config.root, 'native', 'xfce-session.sh')], env);
  // Node owns the private Unix listener. x11vnc's inetd mode receives an already
  // accepted socket and opens no TCP listener, including on old Ubuntu builds
  // whose help advertises -unixsockonly without implementing it.
  vncServer = net.createServer(socket => {
    if (viewerProcess && viewerProcess.exitCode === null && viewerProcess.signalCode === null) { try { process.kill(-viewerProcess.pid, 'SIGTERM'); } catch {} }
    socket.pause();
    viewerProcess = start('x11vnc', ['-inetd', '-display', config.display, '-auth', xauthority,
      '-no6', '-noipv6', '-rfbport', '0', '-nopw', '-noremote', '-nolookup', '-noxrecord', '-quiet'], env, false, socket);
    socket.on('error', () => {});
    socket.destroy(); // Child holds its own references to the accepted descriptor.
  });
  vncServer.on('error', error => { console.error(`VNC socket: ${error.message}`); void stop(1); });
  await new Promise((resolve, reject) => { vncServer.once('error', reject); vncServer.listen(config.socket, resolve); });
  await chmod(config.socket, 0o600);
  start('python3', [join(config.root, 'desktop', 'agent.py')], { ...env, VNC_SOCKET: config.socket });
  // This opens a shell attached to a private tmux server. It never starts or replays a Codex task.
  start(join(config.root, 'desktop', 'open-codex-terminal'), [], env, false);
  console.log(`独立桌面已启动：${config.display}；工作目录：${config.workspace}`);
  // Child process handles keep the supervisor alive until explicit stop or a component failure.
} catch (error) {
  console.error(`桌面启动失败：${error.message}`);
  await stop(1);
}
