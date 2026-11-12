// Separate real process groups model stopping all manager descendants. Actual
// desktop/worker/manager entrypoints, private X11, xterm, tmux and selection.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rename, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { managerRequest } from '../panel/manager-client.mjs';
import { desktopActionClient } from '../native/desktop-actions.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-lifetime-')), source = resolve(import.meta.dirname, '..'), children = [];
const env = { ...process.env, XAUTHORITY: join(root, 'Xauthority'), PATH: `${join(source, 'data/host-tools/usr/bin')}:${process.env.PATH}` };
delete env.DBUS_SESSION_BUS_ADDRESS; delete env.SESSION_MANAGER;
const exec = promisify(execFile), run = async (file, args) => (await exec(file, args, { env, timeout: 3000, maxBuffer: 8192 })).stdout.trim();
const start = (file, args) => {
  assert.ok(children.length < 8, 'isolated child process bound');
  const child = spawn(file, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.diagnostic = ''; child.stderr.on('data', bytes => { child.diagnostic = (child.diagnostic + bytes.toString()).slice(-4096); });
  children.push(child); return child;
};
async function eventually(probe, label = 'isolated lifecycle condition') {
  const deadline = performance.now() + 20000; let lastError;
  while (performance.now() < deadline) {
    try { if (await probe()) return; } catch (error) { lastError = error.message; }
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error(label + ' timed out' + (lastError ? '\n' + lastError : '') + '\n' + children.map(child => `pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}\n${child.diagnostic}`).join('\n'));
}
const secret = 'synthetic_lifecycle_secret', runtime = join(root, 'run'), socket = join(runtime, 'tmux.sock');
const clientConfig = { managerSocket: join(runtime, 'manager.sock'), agentSecret: secret };
try {
  for (const part of ['run', 'secrets', 'workspace', 'data/desktop']) await mkdir(join(root, part), { recursive: true });
  for (const part of ['native', 'desktop']) await cp(join(source, part), join(root, part), { recursive: true });
  // Keep the worker's child alive briefly after its X window closes, as can
  // happen while a loaded CI host reaps xterm. Only the isolated copy is used.
  const terminalHelper = join(root, 'desktop/open-codex-terminal');
  await rename(terminalHelper, terminalHelper + '-real');
  await writeFile(terminalHelper, '#!/usr/bin/env bash\nset -u\n"$(dirname -- "$0")/open-codex-terminal-real" "$@"\nresult=$?\nsleep 0.8\nexit "$result"\n', { mode: 0o700 });
  await mkdir(join(root, 'panel/public'), { recursive: true });
  await cp(join(source, 'panel/public/terminal-slots.js'), join(root, 'panel/public/terminal-slots.js'));
  await writeFile(join(root, 'data/desktop/fonts.conf'), '<fontconfig><include>/etc/fonts/fonts.conf</include></fontconfig>');
  await writeFile(join(root, 'secrets/agent_secret'), secret, { mode: 0o600 });
  for (let number = 94; number < 200; number++) { const busy = await Promise.all([`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`].map(p => lstat(p).then(() => true, () => false))); if (!busy.some(Boolean)) { env.DISPLAY = ':' + number; break; } }
  assert.ok(env.DISPLAY); await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
  // Entrypoints merge process.env over .env; inherited deployment variables
  // must never redirect an isolated worker to the running desktop/workspace.
  Object.assign(env, { DISPLAY_NUMBER: env.DISPLAY.slice(1), RUNTIME_DIR: runtime, WORKSPACE_DIR: join(root, 'workspace'), DESKTOP_SIZE: '1280x1280', DEPLOY_MODE: 'desktop', MAX_TERMINALS: '8',
    XDG_CONFIG_HOME: join(root, 'data/desktop/config'), XDG_CACHE_HOME: join(root, 'data/desktop/cache'), XDG_DATA_HOME: join(root, 'data/desktop/share') });
  await writeFile(join(root, '.env'), `DISPLAY_NUMBER=${env.DISPLAY.slice(1)}\nRUNTIME_DIR=${runtime}\nDESKTOP_SIZE=1280x1280\nWORKSPACE_DIR=${join(root, 'workspace')}\n`);
  // Native controllers use the desktop's authority path.
  await run('xauth', ['-f', env.XAUTHORITY, 'add', env.DISPLAY, '.', randomBytes(16).toString('hex')]);
  await cp(env.XAUTHORITY, join(runtime, 'Xauthority'));
  start('Xvfb', [env.DISPLAY, '-screen', '0', '1280x1280x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY, '-noreset']);
  await eventually(async () => (await run('xdotool', ['getdisplaygeometry'])) === '1280 1280');
  start('dbus-run-session', ['--', 'xfwm4', '--compositor=off']);
  await eventually(async () => (await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])).includes('window id'), 'window manager publication');
  await run('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'codex', 'sleep', '120']);
  const pane = await run('tmux', ['-S', socket, 'list-panes', '-F', '#{pane_pid}']);
  const worker = start(process.execPath, [join(root, 'native/desktop-worker.mjs')]);
  let manager = start(process.execPath, [join(root, 'native/manager.mjs')]);
  await eventually(async () => (await managerRequest(clientConfig, '/status')).available);
  assert.equal((await managerRequest(clientConfig, '/health')).ready, true);
  const action = desktopActionClient(join(runtime, 'actions.sock'), secret);
  await action('/terminal', { id: 'main' });
  let window, windowPid; await eventually(async () => { window = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']); windowPid = await run('xdotool', ['getwindowpid', window]); return /^\d+$/.test(windowPid); });
  const text = '中文剪贴板 $(literal) `literal`'; await action('/clipboard', { text });
  assert.equal(await run('xclip', ['-selection', 'clipboard', '-out']), text);
  await assert.rejects(action('/terminal', { id: 'main; arbitrary shell' }));
  await assert.rejects(action('/clipboard', { text: 'x'.repeat(32769) }));
  process.kill(-manager.pid, 'SIGKILL'); await eventually(() => manager.signalCode !== null);
  assert.equal(await run('xdotool', ['getwindowpid', window]), windowPid);
  assert.equal(await run('xclip', ['-selection', 'clipboard', '-out']), text);
  assert.equal(await run('tmux', ['-S', socket, 'list-panes', '-F', '#{pane_pid}']), pane);
  manager = start(process.execPath, [join(root, 'native/manager.mjs')]);
  await eventually(async () => (await managerRequest(clientConfig, '/status')).available);
  await action('/terminal', { id: 'main' });
  assert.equal(await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']), window);
  assert.equal((await lstat(join(runtime, 'actions.sock'))).mode & 0o777, 0o600);
  assert.equal(worker.exitCode, null);
  const settings = await managerRequest(clientConfig, '/settings');
  const saved = await managerRequest(clientConfig, '/settings', { ...settings.saved, fontSize: 16, revision: settings.revision });
  await managerRequest(clientConfig, '/terminal', { action: 'font', revision: saved.revision });
  await eventually(async () => { const value = await managerRequest(clientConfig, '/settings'); if (value.busy) return false; assert.equal(value.job.status, 'complete'); return true; });
  assert.equal(await run('tmux', ['-S', socket, 'list-panes', '-F', '#{pane_pid}']), pane);
  // Replacing a selection has one foreground owner, including repeated text.
  for (const next of [text, '下一份', '最后一份']) { await action('/clipboard', { text: next }); assert.equal(await run('xclip', ['-selection', 'clipboard', '-out']), next); }
  const ids = (await readFile(`/proc/${worker.pid}/task/${worker.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  const names = await Promise.all(ids.map(pid => readFile(`/proc/${pid}/comm`, 'utf8'))); assert.equal(names.filter(n => n.trim() === 'xclip').length, 1);
  const original = (await managerRequest(clientConfig, '/terminals')).terminals[0];
  const serverPid = await run('tmux', ['-S', socket, 'display-message', '-p', '-t', original.token.split(':')[0], '#{pid}']);
  const closed = await managerRequest(clientConfig, '/terminals', { action: 'close', terminalId: original.id, terminalToken: original.token, confirm: true });
  assert.equal(closed.closed, 'main'); assert.deepEqual(closed.terminals, []);
  await eventually(async () => { try { await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']); return false; } catch { return true; } });
  assert.equal(await run('tmux', ['-S', socket, 'display-message', '-p', '-t', 'codex-host:0.0', '#{pid}']), serverPid);
  await assert.rejects(action('/terminal', { id: 'main' }));
  const reopened = await managerRequest(clientConfig, '/terminals', { action: 'create', terminalId: 'main', name: '显式重开' });
  assert.equal(reopened.opened, 'main'); assert.notEqual(reopened.terminals[0].token, original.token);
  assert.equal(await run('tmux', ['-S', socket, 'display-message', '-p', '-t', 'codex-host:0.0', '#{pid}']), serverPid);
  assert.equal(await run('xclip', ['-selection', 'clipboard', '-out']), '最后一份'); assert.equal(worker.exitCode, null);
  console.log('PASS: real isolated X11/xterm/tmux/clipboard survive manager process-group replacement; confirmed close ends its window, empty slots preserve the server, attach cannot create a task, explicit reopen creates a fresh shell/window, fixed-action authentication and selection owner verified. No Codex or production input.');
} catch (error) {
  console.error(children.map(child => child.diagnostic).join('\n'));
  throw error;
} finally {
  await run('tmux', ['-S', socket, 'kill-server']).catch(() => {});
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await rm(root, { recursive: true, force: true });
}
