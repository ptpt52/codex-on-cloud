// Isolated real Xvfb/RandR/x11vnc check. No host display or Codex input.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, lstat, mkdir, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { createViewportResizer } from '../native/viewport.mjs';

const directory = await mkdtemp(join(tmpdir(), 'codex-viewport-'));
const env = { ...process.env, HOME: directory, XAUTHORITY: join(directory, 'Xauthority'),
  XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'share'),
  PATH: `${resolve('data/host-tools/usr/bin')}:${process.env.PATH}` };
delete env.DBUS_SESSION_BUS_ADDRESS;
delete env.SESSION_MANAGER;
const exec = promisify(execFile), children = [];
const run = async (command, args, options = {}) => (await exec(command, args, { env, timeout: 3000, maxBuffer: 16384, ...options })).stdout.trim();
let server, socket, viewer;
const start = (command, args, stdio = 'ignore') => { const child = spawn(command, args, { env, stdio, detached: true }); children.push(child); return child; };
try {
  for (let number = 94; number < 200; number++) {
    const occupied = await Promise.all([`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`].map(path => lstat(path).then(() => true, () => false)));
    if (!occupied.some(Boolean)) { env.DISPLAY = `:${number}`; break; }
  }
  assert.ok(env.DISPLAY);
  await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
  await run('xauth', ['-f', env.XAUTHORITY, 'add', env.DISPLAY, '.', randomBytes(16).toString('hex')]);
  const display = start('Xvfb', [env.DISPLAY, '-screen', '0', '1600x1600x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY, '-noreset']);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await run('xdotool', ['getdisplaygeometry']) === '1600 1600') break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const tmux = ['-S', join(directory, 'tmux.sock'), '-f', '/dev/null'];
  await run('tmux', [...tmux, 'new-session', '-d', '-s', 'viewport', '-x', '100', '-y', '30', '/bin/sleep 120']);
  const pid = await run('tmux', [...tmux, 'list-panes', '-F', '#{pane_pid}']);
  async function eventually(probe) {
    for (let attempt = 0; attempt < 100; attempt++) { try { if (await probe()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('isolated window check timed out');
  }
  const channels = join(env.XDG_CONFIG_HOME, 'xfce4/xfconf/xfce-perchannel-xml');
  await mkdir(channels, { recursive: true });
  await copyFile(resolve('native/panel.xml'), join(channels, 'xfce4-panel.xml'));
  const session = start('dbus-run-session', ['--', 'bash', resolve('native/xfce-session.sh')]);
  await eventually(async () => (await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])).includes('window id'));
  async function components() {
    const found = {};
    async function visit(pid, depth) {
      if (depth > 4) return;
      const ids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).slice(0, 16);
      for (const id of ids) {
        const comm = (await readFile(`/proc/${id}/comm`, 'utf8')).trim();
        if (['xfwm4', 'xfdesktop', 'xfce4-panel'].includes(comm)) found[comm] = Number(id);
        await visit(id, depth + 1);
      }
    }
    await visit(session.pid, 0);
    return found;
  }
  let originalComponents;
  await eventually(async () => { originalComponents = await components(); return Object.keys(originalComponents).length === 3; });
  const terminal = start('xterm', ['-class', 'codex-viewport-test', '-e', 'tmux', ...tmux, 'attach-session', '-t', 'viewport']);
  let window;
  await eventually(async () => { window = await run('xdotool', ['search', '--class', '^codex-viewport-test$']); return /^\d+$/.test(window); });
  await run('python3', [resolve('desktop/terminal-display.py'), 'maximize', window]);
  const path = join(directory, 'vnc.sock');
  server = net.createServer(client => {
    client.pause();
    viewer = start('x11vnc', ['-inetd', '-display', env.DISPLAY, '-auth', env.XAUTHORITY, '-no6', '-noipv6', '-rfbport', '0', '-nopw', '-noremote', '-nolookup', '-noxrecord', '-quiet'], [client, client, 'ignore']);
    client.on('error', () => {}); client.destroy();
  });
  server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
  socket = net.createConnection(path); await once(socket, 'connect');
  let bytes = Buffer.alloc(0), wake, closed = false;
  socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 16 * 1024 * 1024) socket.destroy(); wake?.(); });
  socket.on('close', () => { closed = true; wake?.(); }); socket.on('error', () => {});
  async function read(size) {
    assert.ok(size <= 16 * 1024 * 1024);
    while (bytes.length < size) {
      if (closed) throw new Error('RFB closed during live resize');
      await new Promise((resolve, reject) => { const timer = setTimeout(() => { wake = null; reject(new Error('RFB response timed out')); }, 5000); wake = () => { clearTimeout(timer); wake = null; resolve(); }; });
    }
    const result = bytes.subarray(0, size); bytes = bytes.subarray(size); return result;
  }
  assert.match((await read(12)).toString(), /^RFB 003\./); socket.write('RFB 003.008\n');
  const count = (await read(1))[0]; assert.ok((await read(count)).includes(1)); socket.write(Buffer.from([1]));
  assert.equal((await read(4)).readUInt32BE(), 0); socket.write(Buffer.from([1]));
  const init = await read(24); await read(init.readUInt32BE(20));
  assert.equal(init[4], 32);
  const encodings = Buffer.alloc(12); encodings[0] = 2; encodings.writeUInt16BE(2, 2); encodings.writeInt32BE(-223, 4); socket.write(encodings);
  let width = init.readUInt16BE(0), height = init.readUInt16BE(2);
  function request() { const value = Buffer.alloc(10); value[0] = 3; value.writeUInt16BE(width, 6); value.writeUInt16BE(height, 8); socket.write(value); }
  async function update() {
    assert.equal((await read(1))[0], 0);
    const header = await read(3), count = header.readUInt16BE(1); assert.ok(count <= 4096);
    let resized = false;
    for (let i = 0; i < count; i++) {
      const rect = await read(12), w = rect.readUInt16BE(4), h = rect.readUInt16BE(6), encoding = rect.readInt32BE(8);
      if (encoding === -223) { width = w; height = h; resized = true; }
      else { assert.equal(encoding, 0); await read(w * h * 4); }
    }
    return resized;
  }
  request(); await update();
  const resizer = createViewportResizer(run); assert.equal((await resizer.refresh()).supported, true);
  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 800 }, { width: 900, height: 1200 }, { width: 1600, height: 240 }, { width: 1600, height: 1600 }]) {
    const result = await resizer.resize(size);
    request();
    let changed = false;
    for (let i = 0; i < 40 && !changed; i++) { changed = await update(); if (!changed) { await new Promise(resolve => setTimeout(resolve, 100)); request(); } }
    assert.equal(changed, true); assert.deepEqual({ width, height }, result.actual);
    assert.equal(await run('tmux', [...tmux, 'list-panes', '-F', '#{pane_pid}']), pid);
    assert.equal(display.exitCode, null); assert.equal(viewer.exitCode, null);
    assert.equal(terminal.exitCode, null);
    assert.equal(session.exitCode, null);
    assert.deepEqual(await components(), originalComponents, 'all real XFCE components survive short and wide screens');
    await eventually(async () => {
      const geometry = await run('xdotool', ['getwindowgeometry', '--shell', window]);
      const w = Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1]), h = Number(geometry.match(/^HEIGHT=(\d+)$/m)?.[1]);
      return w <= width && w > width - 32 && h <= height && h > height - 96;
    });
  }
  assert.ok(((await run('xrandr', ['--query'])).match(/^\s+codex-viewport-[ab]\s/gm) || []).length <= 2);
  assert.ok(!(await run('ss', ['-lntp'])).includes(`pid=${viewer.pid},`));
  process.kill(originalComponents.xfdesktop, 'SIGTERM');
  await eventually(async () => !Object.hasOwn(await components(), 'xfdesktop'));
  assert.equal(session.exitCode, null, 'wallpaper exit must not tear down the desktop');
  assert.equal(display.exitCode, null); assert.equal(terminal.exitCode, null);
  assert.equal(await run('tmux', [...tmux, 'list-panes', '-F', '#{pane_pid}']), pid);
  console.log('✓ isolated real Xvfb + x11vnc + full XFCE/xterm: live resize fills the maximized terminal and emits DesktopSize on one private RFB connection; X server, all XFCE components, viewer, terminal and tmux task survive short screens; at most two custom modes and no VNC TCP listener');
} finally {
  socket?.destroy(); server?.close();
  await run('tmux', ['-S', join(directory, 'tmux.sock'), 'kill-server']).catch(() => {});
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
