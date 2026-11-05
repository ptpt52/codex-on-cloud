// Opt-in real X11 test in a temporary display, HOME and tmux server. Never starts Codex.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createDesktopControls, desktopEnvironment, RESUME_COMMAND } from '../native/desktop-controls.mjs';
import { runInputCommand } from '../native/input.mjs';

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
  const launch = (id = 'main') => start(join(root, 'desktop/open-codex-terminal'), id === 'main' ? [] : [id]);
  const controls = createDesktopControls(config, { launch });
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
    assert.equal(args[args.indexOf('-tn') + 1], 'xterm-256color');
  }
  await controls.input({ action: 'terminal' });
  // Reproduce the submitted Codex prompt's black-on-colour8 row in real pixels.
  // The same pane stays alive while an 8-colour viewer loses its contrast.
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'show-options', '-sv', 'default-terminal']), 'screen-256color');
  const colorScript = join(root, 'color-proof.py'), colorReady = join(root, 'color-ready'), colorRelease = join(root, 'color-release');
  await writeFile(colorScript, `import os, sys, time\nos.write(1, b'\\x1b[2J\\x1b[H\\x1b[0;30;48;5;8mMMMM Submitted prompt text MMMM' + b' ' * 30 + b'\\x1b[0m')\nwith open(sys.argv[1], 'w') as f: f.write(os.environ['TERM'])\ndeadline = time.monotonic() + 20\nwhile not os.path.exists(sys.argv[2]) and time.monotonic() < deadline: time.sleep(0.05)\n`);
  await controls.input({ action: 'paste', target: 'terminal', text: `python3 '${colorScript}' '${colorReady}' '${colorRelease}'` });
  await controls.input({ action: 'key', key: 'Enter' });
  await eventually(async () => (await readFile(colorReady, 'utf8')) === 'screen-256color');
  start('xterm', ['-tn', 'xterm', '-class', 'codex-color-legacy', '-fa', 'DejaVu Sans Mono', '-fs', '20', '-e', 'tmux', '-S', env.TMUX_SOCKET, 'attach-session', '-t', '=codex']);
  let legacyWindow;
  await eventually(async () => !!(legacyWindow = await run('xdotool', ['search', '--class', '^codex-color-legacy$'])));
  await eventually(async () => (await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-F', '#{client_termname}'])).split('\n').length === 2);
  async function promptPixels(id, name) {
    const file = join(root, `${name}.png`);
    await run('import', ['-display', config.display, '-window', id, file]);
    const { stdout } = await exec('convert', [file, '-crop', '240x30+4+4', '+repage', '-depth', '8', 'rgb:-'], { env, timeout: 3000, maxBuffer: 65536, encoding: 'buffer' });
    let grey = 0, black = 0;
    for (let i = 0; i < stdout.length; i += 3) {
      const [r, g, b] = stdout.subarray(i, i + 3);
      if (r >= 60 && r <= 200 && Math.abs(r - g) < 3 && Math.abs(r - b) < 3) grey++;
      if (Math.max(r, g, b) < 10) black++;
    }
    return { grey, black };
  }
  const colorWindow = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']);
  let fixedPixels;
  await eventually(async () => { fixedPixels = await promptPixels(colorWindow, 'prompt-256color'); return fixedPixels.grey > 500 && fixedPixels.black > 30; });
  const legacyPixels = await promptPixels(legacyWindow, 'prompt-8color');
  assert.equal(legacyPixels.grey, 0, 'the old 8-colour viewer reproduces the invisible black row');
  assert.ok(legacyPixels.black > 500);
  await run('xdotool', ['windowclose', legacyWindow]);
  await writeFile(colorRelease, 'continue');
  await eventually(async () => await run('tmux', ['-S', env.TMUX_SOCKET, 'display-message', '-p', '-t', 'codex', '#{pane_current_command}']) === 'bash');
  assert.equal((await controls.get()).session.pid, pid);
  console.log(`✓ real X11 prompt contrast: 256-colour viewer ${fixedPixels.grey} grey / ${fixedPixels.black} black pixels; legacy viewer ${legacyPixels.grey} grey`);
  // Capture real xterm/tmux bytes in this temporary display, never in the user's Codex.
  const keyCases = [
    ['Ctrl+J', '0a'], ['Enter', '0d'], ['Ctrl+R', '12'], ['Ctrl+G', '07'], ['Ctrl+O', '0f'], ['Ctrl+L', '0c'],
    ['Ctrl+A', '01'], ['Ctrl+E', '05'], ['Ctrl+U', '15'], ['Ctrl+K', '0b'], ['Ctrl+W', '17'], ['Ctrl+Y', '19'],
    ['Ctrl+ArrowLeft', '1b5b313b3544'], ['Ctrl+ArrowRight', '1b5b313b3543'], ['Alt+B', '1b62'], ['Alt+F', '1b66'],
    ['Alt+D', '1b64'], ['Alt+Backspace', '1b7f'], ['Delete', '1b5b337e'], ['Shift+Tab', '1b5b5a'],
    ['Ctrl+C', '03'], ['Ctrl+D', '04'], ['Ctrl+Z', '1a'], ['Escape Escape', '1b1b'],
  ];
  const keyBytes = Buffer.from(keyCases.map(([, hex]) => hex).join(''), 'hex');
  const keyScript = join(root, 'key-receiver.py'), keyReady = join(root, 'key-ready'), keyProof = join(root, 'key-proof.json');
  await writeFile(keyScript, `import json, os, select, sys, termios, time, tty\nfd = sys.stdin.fileno()\nprevious = termios.tcgetattr(fd)\ndata = b''\ntry:\n tty.setraw(fd)\n with open(sys.argv[1], 'w') as f: f.write('ready')\n deadline = time.monotonic() + 10\n while len(data) < ${keyBytes.length} and time.monotonic() < deadline:\n  if select.select([fd], [], [], 0.1)[0]: data += os.read(fd, min(4096 - len(data), 1024))\n  if len(data) >= 4096: break\nfinally:\n termios.tcsetattr(fd, termios.TCSANOW, previous)\n with open(sys.argv[2], 'w') as f: json.dump({'hex': data.hex()}, f)\n`);
  await controls.input({ action: 'paste', target: 'terminal', text: `python3 '${keyScript}' '${keyReady}' '${keyProof}'` });
  await controls.input({ action: 'key', key: 'Enter' });
  await eventually(async () => (await readFile(keyReady, 'utf8')) === 'ready');
  for (const [key] of keyCases) await controls.input({ action: 'key', key });
  await eventually(async () => !!(await readFile(keyProof, 'utf8')));
  assert.equal(JSON.parse(await readFile(keyProof, 'utf8')).hex, keyBytes.toString('hex'), 'real terminal bytes must distinguish Ctrl+J from Enter and preserve modifiers');
  assert.equal((await controls.get()).session.pid, pid);
  const literal = '中文原样 $(never) `never`';
  await controls.input({ action: 'paste', target: 'terminal', text: `printf '%s\\n' '${literal}' > "$WORKSPACE_DIR/input-proof"` });
  await assert.rejects(readFile(join(config.workspace, 'input-proof')), { code: 'ENOENT' });
  await controls.input({ action: 'key', key: 'Enter' });
  await eventually(async () => (await readFile(join(config.workspace, 'input-proof'), 'utf8')) === literal + '\n');
  assert.equal((await controls.get()).session.pid, pid);
  const clipboardText = '\ufeff  中文😀\r\n`$(never)`\t\n ', primaryText = '鼠标选区\n独立文字';
  await runInputCommand('xclip', ['-selection', 'clipboard', '-in'], { env, input: clipboardText });
  await runInputCommand('xclip', ['-selection', 'primary', '-in'], { env, input: primaryText });
  assert.deepEqual(await controls.clipboard({ source: 'clipboard' }), { source: 'clipboard', text: clipboardText, bytes: Buffer.byteLength(clipboardText) });
  assert.deepEqual(await controls.clipboard({ source: 'primary' }), { source: 'primary', text: primaryText, bytes: Buffer.byteLength(primaryText) });
  await runInputCommand('xclip', ['-selection', 'clipboard', '-in'], { env, input: '' });
  assert.equal((await controls.clipboard({ source: 'clipboard' })).text, '');
  await runInputCommand('xclip', ['-selection', 'clipboard', '-in'], { env, input: 'x'.repeat(32769) });
  await assert.rejects(controls.clipboard({ source: 'clipboard' }), { status: 413 });
  await runInputCommand('xclip', ['-selection', 'clipboard', '-target', 'image/png', '-in'], { env, input: Buffer.from([137, 80, 78, 71]) });
  // Some older selection owners return raw bytes despite the requested text target.
  await assert.rejects(controls.clipboard({ source: 'clipboard' }), error => [404, 422].includes(error.status));
  assert.equal((await controls.get()).session.pid, pid);
  // Exercise the real tmux/shell boundary with a dummy executable, never the host Codex.
  const created = await controls.manageTerminals({ action: 'create', name: '辅助测试' });
  const auxiliary = created.terminals.find(item => item.id === created.created);
  assert.ok(auxiliary?.supported); assert.equal(created.terminals.length, 2);
  assert.ok((await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-t', '=codex-aux1', '-F', '#{client_termname}'])).split('\n').every(name => name === 'xterm-256color'));
  const destination = { terminalId: auxiliary.id, terminalToken: auxiliary.token };
  await controls.input({ action: 'paste', target: 'terminal', text: 'printf "辅助终端中文\\n" > "$WORKSPACE_DIR/aux-proof"', ...destination });
  await assert.rejects(readFile(join(config.workspace, 'aux-proof')), { code: 'ENOENT' });
  await controls.input({ action: 'key', key: 'Enter', ...destination });
  await eventually(async () => (await readFile(join(config.workspace, 'aux-proof'), 'utf8')) === '辅助终端中文\n');
  await controls.input({ action: 'paste', target: 'terminal', text: 'sleep 30', ...destination });
  await controls.input({ action: 'key', key: 'Enter', ...destination });
  await eventually(async () => (await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex-aux1', '-F', '#{pane_current_command}'])) === 'sleep');
  const auxClient = (await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-F', '#{client_tty}\t#{session_name}'])).split('\n').find(line => line.endsWith('\tcodex-aux1')).split('\t')[0];
  await run('tmux', ['-S', env.TMUX_SOCKET, 'switch-client', '-c', auxClient, '-t', 'codex']);
  await assert.rejects(controls.input({ action: 'key', key: 'Enter', ...destination }), { status: 409, outcome: 'rejected' });
  await controls.manageTerminals({ action: 'open', ...destination });
  assert.equal((await run('tmux', ['-S', env.TMUX_SOCKET, 'display-message', '-p', '-c', auxClient, '#{session_name}'])), 'codex-aux1');
  const auxWindow = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal-aux1$']);
  await run('xdotool', ['windowclose', auxWindow]);
  await eventually(async () => !(await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal-aux1$']).catch(() => '')));
  await assert.rejects(controls.input({ action: 'key', key: 'Enter', ...destination }), { status: 409, outcome: 'rejected' });
  const recovered = createDesktopControls(config, { launch });
  assert.deepEqual((await recovered.listTerminals()).terminals.map(({ id, name, token }) => ({ id, name, token })), created.terminals.map(({ id, name, token }) => ({ id, name, token })));
  await recovered.manageTerminals({ action: 'open', ...destination });
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex-aux1', '-F', '#{pane_current_command}']), 'sleep');
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex', '-F', '#{pane_pid}']), String(pid));
  await assert.rejects(recovered.input({ action: 'key', key: 'Enter', ...destination, terminalToken: '%999:12345' }), { status: 409, outcome: 'rejected' });
  await recovered.manageTerminals({ action: 'rename', ...destination, name: "日志 ' $(never) `never`" });
  assert.equal((await recovered.listTerminals()).terminals[1].name, "日志 ' $(never) `never`");
  await recovered.manageTerminals({ action: 'create', name: '辅助 2' });
  await recovered.manageTerminals({ action: 'create', name: '辅助 3' });
  await assert.rejects(recovered.manageTerminals({ action: 'create', name: '超额' }), { status: 409 });
  assert.equal((await recovered.get()).session, null, 'additional tasks must block destructive desktop recovery');
  // Real PTY attachment is independent of the X window and never owns the shell.
  const mainTarget = (await recovered.listTerminals()).terminals.find(item => item.id === 'main');
  async function webClient() {
    const child = spawn('python3', [join(source, 'desktop/web-terminal.py'), env.TMUX_SOCKET, 'main', mainTarget.token, '--geometry'], { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child); const records = []; let pending = '';
    child.stdout.on('data', bytes => {
      pending += bytes.toString(); assert.ok(pending.length <= 128 * 1024);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { const value = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); if (value.type !== 'output') records.push(value); }
    });
    await eventually(() => records.some(item => item.type === 'ready'));
    return { child, records };
  }
  let client = await webClient();
  client.child.stdin.write(JSON.stringify({ id: 1, action: 'resize', cols: 72, rows: 18 }) + '\n');
  await eventually(() => client.records.some(item => item.id === 1 && item.ok));
  const webText = '\x1b[200~printf "网页终端中文\\n" >> "$WORKSPACE_DIR/web-proof"\x1b[201~';
  client.child.stdin.write(JSON.stringify({ id: 2, action: 'input', data: Buffer.from(webText).toString('base64') }) + '\n');
  await eventually(() => client.records.some(item => item.id === 2 && item.ok));
  await assert.rejects(readFile(join(config.workspace, 'web-proof')), { code: 'ENOENT' });
  client.child.stdin.write(JSON.stringify({ id: 3, action: 'input', data: Buffer.from('\r').toString('base64') }) + '\n');
  await eventually(async () => (await readFile(join(config.workspace, 'web-proof'), 'utf8')) === '网页终端中文\n');
  let ended = once(client.child, 'close'); client.child.stdin.end(); assert.equal((await ended)[0], 0);
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex', '-F', '#{pane_pid}']), String(pid));
  client = await webClient(); ended = once(client.child, 'close'); client.child.kill('SIGTERM'); await ended;
  assert.equal(await readFile(join(config.workspace, 'web-proof'), 'utf8'), '网页终端中文\n', 'attaching again cannot replay a command');
  const desktopClients = await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-t', '=codex', '-F', '#{client_pid}']);
  client = await webClient();
  client.child.stdin.write(JSON.stringify({ id: 1, action: 'resize', cols: 233, rows: 40, viewport: true }) + '\n');
  await eventually(() => client.records.some(item => item.id === 1 && item.ok));
  await eventually(async () => await run('tmux', ['-S', env.TMUX_SOCKET, 'display-message', '-p', '-t', 'codex', '#{pane_width}']) === '233');
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-t', '=codex-view-main', '-F', '#{client_pid}']), desktopClients);
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex', '-F', '#{pane_pid}']), String(pid));
  const overlapping = await webClient();
  overlapping.child.stdin.write(JSON.stringify({ id: 1, action: 'resize', cols: 233, rows: 40, viewport: true }) + '\n');
  await eventually(() => overlapping.records.some(item => item.id === 1 && item.ok));
  ended = once(client.child, 'close'); client.child.kill('SIGKILL'); await ended;
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-t', '=codex-view-main', '-F', '#{client_pid}']), desktopClients);
  ended = once(overlapping.child, 'close'); overlapping.child.kill('SIGKILL'); await ended;
  await eventually(async () => await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-t', '=codex', '-F', '#{client_pid}']) === desktopClients);
  await eventually(async () => await run('tmux', ['-S', env.TMUX_SOCKET, 'has-session', '-t', '=codex-view-main']).then(() => false, () => true));
  const viewerLock = await lstat(join(config.runtime, 'view-main.lock')); assert.equal(viewerLock.size, 0); assert.equal(viewerLock.mode & 0o777, 0o600);
  assert.equal(await readFile(join(config.workspace, 'web-proof'), 'utf8'), '网页终端中文\n');
  client = await webClient();
  const webTTY = (await run('tmux', ['-S', env.TMUX_SOCKET, 'list-clients', '-F', '#{client_pid}\t#{client_tty}'])).split('\n');
  let targetTTY;
  for (const line of webTTY) {
    const [clientPid, clientTTY] = line.split('\t');
    if ((await readFile(`/proc/${clientPid}/status`, 'utf8')).match(/^PPid:\s*(\d+)$/m)?.[1] === String(client.child.pid)) targetTTY = clientTTY;
  }
  assert.ok(targetTTY);
  await run('tmux', ['-S', env.TMUX_SOCKET, 'switch-client', '-c', targetTTY, '-t', 'codex-aux1']);
  ended = once(client.child, 'close');
  client.child.stdin.write(JSON.stringify({ id: 1, action: 'input', data: Buffer.from('\r').toString('base64') }) + '\n');
  await ended; assert.equal(client.records.find(item => item.id === 1)?.outcome, 'rejected');
  assert.equal(await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-t', 'codex', '-F', '#{pane_pid}']), String(pid));
  const cwd = join(config.workspace, "a'b $(never) `never`"), resumeId = '11111111-1111-4111-8111-111111111111';
  await mkdir(cwd);
  await writeFile(join(root, 'bin/codex'), '#!/usr/bin/env python3\nimport json, os, sys, time\nwith open(os.path.join(os.environ["WORKSPACE_DIR"], "resume-args.json"), "w") as f: json.dump({"args":sys.argv[1:], "cwd":os.getcwd()}, f)\ntime.sleep(30)\n', { mode: 0o700 });
  await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID', resumeId]);
  try { await run('tmux', ['-S', env.TMUX_SOCKET, 'respawn-pane', '-k', '-t', 'codex:0.0', '-c', cwd, RESUME_COMMAND]); }
  finally { await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-u', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID']); }
  const result = join(config.workspace, 'resume-args.json');
  await eventually(async () => !!(await readFile(result, 'utf8')));
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { args: ['resume', '--cd', cwd, resumeId], cwd });
  console.log('✓ isolated real X11 and PTY: browser-terminal resize, literal Chinese paste, separate Enter and reconnect preserve the original shell without replay; four terminals, target guards, 24 key encodings, font/clipboard and dummy resume passed without starting Codex');
} finally {
  await run('tmux', ['-S', env.TMUX_SOCKET, 'kill-server']).catch(() => {});
  for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await rm(root, { recursive: true, force: true });
}
