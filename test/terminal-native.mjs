// Opt-in real X11 test in a temporary display, HOME and tmux server. Never starts Codex.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createDesktopControls, desktopEnvironment, RESUME_COMMAND } from '../native/desktop-controls.mjs';

const exec = promisify(execFile), source = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'codex-display-'));
const children = [];
const config = { root, runtime: join(root, 'runtime'), workspace: join(root, 'workspace'), transfer: join(root, 'workspace', 'transfer'),
  preferencesFile: join(root, 'data', 'desktop-settings.json'), defaultPreferences: { width: 1280, height: 1280, fontSize: 15 },
  env: { ...process.env, HOME: join(root, 'home'), PATH: `${join(root, 'bin')}:${join(source, 'data/host-tools/usr/bin')}:${process.env.PATH}` } };
for (const part of ['runtime', 'workspace/transfer', 'home', 'bin', 'desktop', 'data/desktop/config', 'data/desktop/cache', 'data/desktop/share']) await mkdir(join(root, part), { recursive: true, mode: 0o700 });
for (const file of ['open-codex-terminal', 'terminal-display.py', 'codex-workbench', 'codex-session', 'terminal.bashrc', 'tmux.conf']) await copyFile(join(source, 'desktop', file), join(root, 'desktop', file));
await writeFile(join(root, 'data/desktop/fonts.conf'), '<fontconfig><include>/etc/fonts/fonts.conf</include></fontconfig>');
for (let number = 94; number < 200; number++) {
  const paths = [`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`];
  const exists = await Promise.all(paths.map(path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })));
  if (!exists.some(Boolean)) { config.display = `:${number}`; break; }
}
assert.ok(config.display, 'no free temporary display');
const env = desktopEnvironment(config);
const run = async (command, args) => (await exec(command, args, { env, timeout: 3000, maxBuffer: 16384 })).stdout.trim();
const start = (command, args) => {
  const child = spawn(command, args, { env, stdio: 'ignore', detached: true });
  child.on('error', () => {}); children.push(child); return child;
};
async function eventually(probe) {
  for (let i = 0; i < 100; i++) { try { if (await probe()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('isolated X11 check timed out');
}
async function finish(controls) {
  let view;
  await eventually(async () => { view = await controls.get(); return !view.busy; });
  assert.equal(view.job.status, 'complete', view.job.message);
}
try {
  await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
  await run('xauth', ['-f', env.XAUTHORITY, 'add', config.display, '.', randomBytes(16).toString('hex')]);
  start('Xvfb', [config.display, '-screen', '0', '1280x1280x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY, '-noreset']);
  await eventually(async () => (await run('xdotool', ['getdisplaygeometry'])) === '1280 1280');
  start('dbus-run-session', ['--', 'xfwm4', '--compositor=off']);
  await eventually(async () => (await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])).includes('window id'));
  const controls = createDesktopControls(config, { launch: () => start(join(root, 'desktop/open-codex-terminal'), []) });
  start(join(root, 'desktop/open-codex-terminal'), []);
  await eventually(async () => !!(await controls.get()).session);
  const first = await controls.get(), pid = first.session.pid;
  const window = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']);
  controls.terminal({ action: 'maximize' }); await finish(controls);
  await eventually(async () => (await run('xprop', ['-id', window, '_NET_WM_STATE'])).includes('_NET_WM_STATE_MAXIMIZED_VERT'));
  controls.terminal({ action: 'restore' }); await finish(controls);
  await eventually(async () => !(await run('xprop', ['-id', window, '_NET_WM_STATE'])).includes('_NET_WM_STATE_MAXIMIZED_VERT'));
  const saved = controls.save({ ...first.saved, fontSize: 20, revision: first.revision });
  for (let i = 0; i < 2; i++) {
    controls.terminal({ action: 'font', revision: saved.revision }); await finish(controls);
    assert.equal((await controls.get()).session.pid, pid, 'font replacement must preserve the tmux task');
    const id = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']);
    assert.match(id, /^\d+$/);
    const terminalPid = await run('xdotool', ['getwindowpid', id]);
    const args = (await readFile(`/proc/${terminalPid}/cmdline`, 'utf8')).split('\0');
    assert.equal(args[args.indexOf('-fs') + 1], '20');
  }
  // Exercise the real tmux/shell boundary with a dummy executable, never the host Codex.
  const cwd = join(config.workspace, "a'b $(never) `never`"), resumeId = '11111111-1111-4111-8111-111111111111';
  await mkdir(cwd);
  await writeFile(join(root, 'bin/codex'), '#!/usr/bin/env python3\nimport json, os, sys, time\nwith open(os.path.join(os.environ["WORKSPACE_DIR"], "resume-args.json"), "w") as f: json.dump({"args":sys.argv[1:], "cwd":os.getcwd()}, f)\ntime.sleep(30)\n', { mode: 0o700 });
  await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID', resumeId]);
  try { await run('tmux', ['-S', env.TMUX_SOCKET, 'respawn-pane', '-k', '-t', 'codex:0.0', '-c', cwd, RESUME_COMMAND]); }
  finally { await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-u', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID']); }
  const result = join(config.workspace, 'resume-args.json');
  await eventually(async () => !!(await readFile(result, 'utf8')));
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['resume', '--cd', cwd, resumeId], cwd });
  console.log('✓ isolated real Xvfb / xfwm4 / xterm: maximize, restore and repeated font changes preserve the private tmux PID; real tmux passes hostile cwd and exact resume ID literally to a dummy executable, without starting Codex');
} finally {
  await run('tmux', ['-S', env.TMUX_SOCKET, 'kill-server']).catch(() => {});
  for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await rm(root, { recursive: true, force: true });
}
