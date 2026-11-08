// Real private tmux/bash/PTY, Python helper, manager and browser gateway. No X11,
// production credentials, actual Codex or device commands. An explicit test
// option uses only uniquely named transient systemd units, never project units.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, access, rm, lstat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createTerminalManager } from '../native/terminals.mjs';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-terminal-only-'));
const root = join(directory, 'app'), home = join(directory, 'home'), bin = join(directory, 'bin'), runtime = join(directory, 'run');
const children = [], sockets = new Set(); let host, files, panel, manager, agentSecret, env, deadline, tmuxOwner;
const taskOwners = new Map();
const systemd = process.env.TERMINAL_TEST_SYSTEMD === '1';
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
async function until(probe, message) { for (let n = 0; n < 200; n++) { if (await probe()) return; await new Promise(r => setTimeout(r, 50)); } throw Error(message); }
async function processState(pid) {
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], started: fields[19] };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function rememberTask(pid) {
  const state = await processState(pid);
  assert.ok(state, 'test task must exist');
  taskOwners.set(pid, state.started);
}
async function taskAlive(pid) {
  const state = await processState(pid);
  return state && state.started === taskOwners.get(pid) && state.state !== 'Z';
}
function launch(script) {
  const unit = 'codex-terminal-only-test-' + directory.split('-').at(-1) + '-' + children.length + '.service';
  const variables = ['HOME','PATH','RUNTIME_DIR','WORKSPACE_DIR','DEPLOY_MODE','PUBLIC_ORIGIN','PANEL_PORT','AGENT_PORT','WEBRTC_ENABLED','HISTFILE'];
  const command = systemd ? 'systemd-run' : process.execPath;
  const args = systemd ? ['--user','--wait','--pipe','--collect','--quiet','--unit='+unit,'--property=WorkingDirectory='+root,'--property=KillMode=control-group','--property=TimeoutStopSec=3','--property=UMask=0077',...variables.map(key=>'--setenv='+key+'='+env[key]),process.execPath,join(root,script)] : [join(root,script)];
  const child = spawn(command, args, { env: systemd ? { ...env, PATH: process.env.PATH } : env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  child.on('error', error => { child.spawnFailure = error; });
  if(systemd)child.unit=unit;
  child.output = ''; const collect = bytes => { child.output = (child.output + bytes.toString()).slice(-32768); };
  child.stdout.on('data', collect); child.stderr.on('data', collect); return child;
}
async function stop(child) {
  if (!child || child.spawnFailure || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  if(child.unit)await exec('systemctl',['--user','stop',child.unit],{timeout:20000,maxBuffer:4096}).catch(()=>{});else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000); await done; clearTimeout(timer);
}
try {
  await Promise.race([(async () => {
    for (const path of [root, home, bin]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(home, '.bashrc'), 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/user-shell-bus\n', { mode: 0o600 });
    for (const folder of ['native', 'desktop', 'panel', 'scripts']) await cp(resolve(folder), join(root, folder), { recursive: true, filter: file => !file.includes('__pycache__') });
    for (const file of ['package.json', 'package-lock.json']) await cp(resolve(file), join(root, file));
    // Force a missing-executable error even on development hosts with Codex.
    await writeFile(join(bin, 'codex'), '#!/no-such-codex-test-interpreter\n', { mode: 0o700 });
    for (const name of ['Xvfb', 'x11vnc', 'xterm', 'xdotool', 'xclip', 'xdpyinfo', 'dbus-run-session']) {
      await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$HOME/unexpected-x11"\nexit 99\n', { mode: 0o700 });
    }
    const port = await freePort(), agentPort = await freePort(), origin = 'http://127.0.0.1:' + port;
    env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, RUNTIME_DIR: runtime, WORKSPACE_DIR: join(root, 'workspaces'), DEPLOY_MODE: 'terminal', MAX_TERMINALS: '8', PUBLIC_ORIGIN: origin,
      PANEL_PORT: String(port), AGENT_PORT: String(agentPort), WEBRTC_ENABLED: '0', HISTFILE: '/dev/null', DISPLAY: ':199', XAUTHORITY: '/must-not-use-xauthority' };
    for(const key of ['TMUX','TMUX_PANE','BASH_ENV','ENV'])delete env[key];
    console.log('Terminal-only: install locked production dependencies without noVNC or browser tests');
    await exec('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: root, env, timeout: 180000, maxBuffer: 16384 });
    await assert.rejects(access(join(root, 'node_modules', '@novnc', 'novnc')), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'node_modules', '@playwright', 'test')), { code: 'ENOENT' });
    await exec(process.execPath, [join(root, 'scripts', 'setup.mjs'), '--mode', 'terminal', '--origin', origin], { env, maxBuffer: 8192 });
    await exec(process.execPath, [join(root, 'scripts', 'native.mjs'), 'doctor'], { env, maxBuffer: 8192 });
    await writeFile(join(root, '.env'), (await readFile(join(root, '.env'), 'utf8')).replace('MAX_TERMINALS=4', 'MAX_TERMINALS=8'));
    const configuration = await readFile(join(root, '.env'), 'utf8'); assert.match(configuration, /DEPLOY_MODE=terminal/); assert.doesNotMatch(configuration, /DISPLAY_NUMBER|DESKTOP_SIZE/);
    agentSecret = (await readFile(join(root, 'secrets', 'agent_secret'), 'utf8')).trim();
    host = launch('native/terminal-host.mjs'); files = launch('native/file-agent.mjs');
    await until(async () => { try { return (await (await fetch('http://127.0.0.1:' + agentPort + '/health', { headers: { authorization: 'Bearer ' + agentSecret }, signal: AbortSignal.timeout(1000) })).json()).ready === true; } catch { return false; } }, 'terminal host did not start');
    assert.equal((await lstat(join(runtime, 'tmux.sock'))).mode & 0o777, 0o600);
    manager = launch('native/manager.mjs'); panel = launch('panel/main.mjs');
    await until(async () => { try { return (await fetch(origin + '/healthz')).ok; } catch { return false; } }, 'panel did not start');
    await until(async () => { try { return (await fetch(origin + '/readyz')).ok; } catch { return false; } }, 'task host or files did not become ready');
    let cookie = '', csrf = ''; const viewer = randomUUID();
    async function api(path, body) {
      const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'x-viewer-id': viewer, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
      if (path === '/api/login') cookie = response.headers.get('set-cookie').split(';')[0];
      const value = await response.json(); if (!response.ok) throw Error(path + ' status ' + response.status + ': ' + value.error); return value;
    }
    const login = await api('/api/login', { username: 'admin', password: (await readFile(join(root, 'secrets', 'panel_password'), 'utf8')).trim() }); csrf = login.csrf; assert.equal(login.mode, 'terminal');
    await api('/api/desktop/claim', { viewer });
    const initial = (await api('/api/terminals')).terminals[0]; assert.equal(initial.id, 'main'); assert.equal(initial.command, 'bash');
    const tmux = args => exec('tmux', ['-S', join(runtime, 'tmux.sock'), ...args], { env, maxBuffer: 16384, timeout: 3000 });
    const serverIdentity = (await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pid}'])).stdout.trim();
    const stat = await readFile('/proc/' + serverIdentity + '/stat', 'utf8');
    tmuxOwner = { pid: Number(serverIdentity), started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    async function attach(terminal) {
      const query = new URLSearchParams({ viewer, terminalId: terminal.id, terminalToken: terminal.token });
      const ws = new WebSocket(origin.replace('http', 'ws') + '/terminal/connect?' + query, { headers: { origin, cookie } }); sockets.add(ws);
      const result = { ws, ready: false, output: '' };
      ws.on('error', () => {}); ws.once('close', () => sockets.delete(ws));
      ws.on('message', bytes => { const record = JSON.parse(bytes); if (record.type === 'ready') result.ready = true; if (record.type === 'output') { const data = Buffer.from(record.data, 'base64'); result.output = (result.output + data.toString()).slice(-131072); ws.send(JSON.stringify({ type: 'ack', bytes: data.length })); } });
      await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', csrf })); await until(() => result.ready, 'PTY did not attach');
      ws.send(JSON.stringify({ type: 'resize', id: 1, cols: 100, rows: 30, viewport: true })); return result;
    }
    const first = await attach(initial);
    first.ws.send(JSON.stringify({ type: 'input', id: 2, data: "export TERMINAL_LIFETIME=preserved; printf '\\n\\x45XPORT-READY-%s\\n' \"$DBUS_SESSION_BUS_ADDRESS\"\r" }));
    await until(() => first.output.includes('EXPORT-READY-unix:path=/user-shell-bus'), 'shell input or user bus environment missing').catch(error=>{throw Error(error.message+': '+JSON.stringify(first.output.slice(-4096)));}); first.ws.terminate();
    const created = await api('/api/terminals', { action: 'create', name: '隔离辅助终端', view: 'terminal' }); assert.equal(created.created, 'aux1');
    for (let number = 2; number <= 7; number++) {
      const result = await api('/api/terminals', { action: 'create', name: `隔离辅助 ${number}`, view: 'terminal' });
      assert.equal(result.created, `aux${number}`);
    }
    const full = await api('/api/terminals'); assert.equal(full.limit, 8); assert.equal(full.terminals.length, 8);
    await assert.rejects(api('/api/terminals', { action: 'create', name: '第九个', view: 'terminal' }), /最多保留/);
    const last = full.terminals.find(item => item.id === 'aux7');
    await rememberTask(Number(last.token.split(':')[1]));
    const lastViewer = await attach(last);
    lastViewer.ws.send(JSON.stringify({ type: 'input', id: 2, data: "printf '\\n\\x45IGHTH-SLOT-READY\\n'\r" }));
    await until(() => lastViewer.output.includes('EIGHTH-SLOT-READY'), 'eighth terminal PTY did not attach'); lastViewer.ws.terminate();
    if(systemd){
      const serverGroup=await readFile('/proc/'+tmuxOwner.pid+'/cgroup','utf8');assert.ok(serverGroup.includes(host.unit));
      for(const terminal of full.terminals)assert.equal(await readFile('/proc/'+terminal.token.split(':')[1]+'/cgroup','utf8'),serverGroup);
    }
    assert.equal((await api('/api/terminals')).terminals.length,8);
    for (const terminal of (await api('/api/terminals')).terminals) await rememberTask(Number(terminal.token.split(':')[1]));
    const fileText='headless transfer 中文';
    const upload=await fetch(origin+'/api/files/terminal-test.txt',{method:'PUT',headers:{origin,cookie,'x-viewer-id':viewer,'x-csrf-token':csrf,'content-type':'application/octet-stream'},body:fileText});
    assert.equal(upload.status,200);assert.equal(await(await fetch(origin+'/api/files/terminal-test.txt',{headers:{cookie}})).text(),fileText);
    assert.equal((await api('/api/forward')).limit, 4);
    if (!systemd) {
      const helper = Number((await readFile('/proc/' + files.pid + '/task/' + files.pid + '/children', 'utf8')).trim());
      assert.ok(Number.isInteger(helper) && helper > 1);
      const exited = once(files, 'exit'); files.kill('SIGKILL'); await exited;
      await until(async () => { const state = await processState(helper); return !state || state.state === 'Z'; }, 'file wrapper crash must release its Python helper through EOF');
      assert.equal(host.exitCode, null);
      files = launch('native/file-agent.mjs');
      await until(async () => { try { return (await fetch(origin + '/api/files', {headers:{cookie}})).ok; } catch { return false; } }, 'file service did not recover after wrapper crash');
    }
    await stop(files);
    assert.equal(host.exitCode, null); assert.equal(host.signalCode, null);
    for (const terminal of full.terminals) assert.ok(await taskAlive(Number(terminal.token.split(':')[1])), 'file service stop must preserve tasks');
    assert.equal((await api('/api/state')).desktop.ready, true);
    files = launch('native/file-agent.mjs');
    await until(async () => { try { return (await fetch(origin + '/api/files', {headers:{cookie}})).ok; } catch { return false; } }, 'file service did not recover');
    await stop(panel); await stop(manager);
    assert.equal(host.exitCode, null); assert.equal(host.signalCode, null);
    assert.equal((await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pid}'])).stdout.trim(), serverIdentity);
    manager = launch('native/manager.mjs'); panel = launch('panel/main.mjs');
    await until(async () => { try { return (await api('/api/me')).mode === 'terminal'; } catch { return false; } }, 'gateway restart did not preserve login');
    await api('/api/desktop/claim', { viewer });
    const resumed = (await api('/api/terminals')).terminals; assert.equal(resumed.find(t => t.id === 'main').token, initial.token); assert.equal(resumed.find(t => t.id === 'aux1').token, created.terminals.find(t => t.id === 'aux1').token);
    for (const terminal of resumed) assert.ok(await taskAlive(Number(terminal.token.split(':')[1])), 'panel/manager restart must preserve each task');
    const second = await attach(initial); second.ws.send(JSON.stringify({ type: 'input', id: 2, data: "printf '\\nLIFETIME-%s\\n' \"$TERMINAL_LIFETIME\"\r" }));
    await until(() => second.output.includes('LIFETIME-preserved'), 'original shell environment did not survive'); second.ws.terminate();
    const destination = terminal => ({ terminalId: terminal.id, terminalToken: terminal.token });
    await tmux(['send-keys', '-t', initial.token.split(':')[0], '-l', 'sleep 600']);
    await tmux(['send-keys', '-t', initial.token.split(':')[0], 'Enter']);
    await until(async () => (await tmux(['display-message', '-p', '-t', initial.token.split(':')[0], '#{pane_current_command}'])).stdout.trim() === 'sleep', 'foreground test task did not start');
    const foreground = Number((await readFile('/proc/' + initial.token.split(':')[1] + '/task/' + initial.token.split(':')[1] + '/children', 'utf8')).trim());
    assert.ok(Number.isInteger(foreground) && foreground > 1); await rememberTask(foreground);
    await assert.rejects(api('/api/terminals', { action: 'close', ...destination(initial) }), /需要确认/);
    const closed = await api('/api/terminals', { action: 'close', ...destination(initial), confirm: true, view: 'terminal' });
    assert.equal(closed.closed, 'main'); assert.equal(closed.terminals.length, 7);
    await until(async () => !await taskAlive(Number(initial.token.split(':')[1])), 'closing must end the selected shell');
    await until(async () => !await taskAlive(foreground), 'closing must end its foreground task');
    for (const terminal of closed.terminals) assert.ok(await taskAlive(Number(terminal.token.split(':')[1])), 'closing must preserve other shells');
    const reopened = await api('/api/terminals', { action: 'create', terminalId: 'main', name: '重新打开主终端', view: 'terminal' }); assert.equal(reopened.created, 'main'); assert.notEqual(reopened.terminals.find(t => t.id === 'main').token, initial.token);
    await assert.rejects(api('/api/terminals', { action: 'close', ...destination(initial), confirm: true, view: 'terminal' }), /终端已结束或布局已变化/);
    await rememberTask(Number(reopened.terminals.find(t => t.id === 'main').token.split(':')[1]));
    assert.equal((await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pid}'])).stdout.trim(), serverIdentity);
    const state = await api('/api/state'); assert.equal(state.desktop.ready, true); assert.equal(state.controls.terminalOnly, true);
    await assert.rejects(access(join(home, 'unexpected-x11')), { code: 'ENOENT' }); await assert.rejects(access(join(runtime, 'vnc.sock')), { code: 'ENOENT' }); await assert.rejects(access(join(runtime, 'Xauthority')), { code: 'ENOENT' });
    if (systemd) {
      const serverGroup = await readFile('/proc/' + tmuxOwner.pid + '/cgroup', 'utf8');
      const keeper = Number((await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pane_pid}'])).stdout.trim());
      await rememberTask(keeper);
      for (const terminal of reopened.terminals) {
        const pid = Number(terminal.token.split(':')[1]);
        assert.equal(await readFile('/proc/' + pid + '/cgroup', 'utf8'), serverGroup);
        assert.ok(!(await readFile('/proc/' + pid + '/environ', 'utf8')).split('\0').includes('DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null'), 'server bus override must not reach user tasks');
      }
      assert.equal(await readFile('/proc/' + keeper + '/cgroup', 'utf8'), serverGroup);
      const stubborn = created.terminals.find(t => t.id === 'aux1');
      const pid = Number(stubborn.token.split(':')[1]);
      await tmux(['send-keys', '-t', stubborn.token.split(':')[0], '-l', 'trap "" HUP TERM; exec sleep infinity']);
      await tmux(['send-keys', '-t', stubborn.token.split(':')[0], 'Enter']);
      await until(async () => (await readFile('/proc/' + pid + '/comm', 'utf8')).trim() === 'sleep', 'stubborn test task did not start');
      const ignored = /^SigIgn:\s*([a-f0-9]+)$/im.exec(await readFile('/proc/' + pid + '/status', 'utf8'));
      assert.ok(ignored && (BigInt('0x' + ignored[1]) & 0x4001n) === 0x4001n, 'test task must ignore HUP and TERM');
    }
    // Exercise migration of an older desktop server with no keeper, using the
    // same real private tmux. No X11 or production service is involved.
    const remaining = (await api('/api/terminals')).terminals;
    for (const terminal of remaining.slice(0, -1)) await api('/api/terminals', { action: 'close', ...destination(terminal), confirm: true, view: 'terminal' });
    const final = remaining.at(-1);
    await tmux(['kill-session', '-t', '=codex-host']);
    const desktopManager = createTerminalManager({ mode: 'desktop', root, runtime, workspace: join(root, 'workspaces'), maxTerminals: 8 }, {
      run: async (command, args) => (await exec(command, args, { env, timeout: 3000, maxBuffer: 16384 })).stdout.trim(),
    });
    assert.deepEqual((await desktopManager.manage({ action: 'close', ...destination(final), confirm: true, view: 'terminal' })).terminals, []);
    assert.equal((await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pid}'])).stdout.trim(), serverIdentity);
    const afterEmpty = await api('/api/terminals', { action: 'create', terminalId: 'aux7', name: '全部关闭后新开', view: 'terminal' });
    assert.equal(afterEmpty.created, 'aux7'); assert.equal(afterEmpty.terminals.length, 1);
    await rememberTask(Number(afterEmpty.terminals[0].token.split(':')[1]));
    assert.equal((await tmux(['display-message', '-p', '-t', 'codex-host:0.0', '#{pid}'])).stdout.trim(), serverIdentity);
    await stop(panel); await stop(manager); await stop(host);
    await until(async()=>{try{await tmux(['list-sessions']);return false;}catch{return true;}},'terminal host did not release its tmux server');
    if (systemd) {
      for (const pid of taskOwners.keys()) await until(async () => !await taskAlive(pid), 'stopping host must kill task ' + pid);
      host = launch('native/terminal-host.mjs');
      await until(async () => { try { return (await tmux(['list-panes', '-t', '=codex', '-F', '#{pane_pid}'])).stdout.trim().length > 0; } catch { return false; } }, 'second terminal host did not start');
      const pid = Number((await tmux(['display-message', '-p', '-t', 'codex:0.0', '#{pane_pid}'])).stdout.trim());
      await rememberTask(pid);
      const hostGroup = await readFile('/proc/' + pid + '/cgroup', 'utf8'); assert.ok(hostGroup.includes(host.unit));
      await exec('systemctl', ['--user', 'kill', '--kill-who=main', '--signal=KILL', host.unit], { timeout: 3000, maxBuffer: 4096 });
      await until(async () => !await taskAlive(pid), 'host SIGKILL must clean its task group');
      await until(() => host.exitCode !== null || host.signalCode !== null, 'killed host unit did not finish');
    }
    for(const [name,path]of Object.entries({tmux:'/usr/bin/tmux',bash:'/bin/bash',sleep:'/bin/sleep',dirname:'/usr/bin/dirname'}))await symlink(path,join(bin,name));
    await writeFile(join(bin,'python3'),'#!/no-such-codex-test-interpreter\n',{mode:0o700});
    const originalPath=env.PATH;env.PATH=bin;files=launch('native/file-agent.mjs');host=launch('native/terminal-host.mjs');env.PATH=originalPath;
    await until(()=>files.exitCode!==null,'failed file helper did not exit');assert.notEqual(files.exitCode,0);
    await until(async () => { try { return (await tmux(['list-panes','-t','=codex','-F','#{pane_pid}'])).stdout.trim().length > 0; } catch { return false; } }, 'file helper failure must not prevent task host startup');
    assert.equal(host.exitCode,null); await stop(host);
    await assert.rejects(tmux(['list-sessions']));await assert.rejects(access(join(runtime,'terminal.pid')),{code:'ENOENT'});
    console.log('✓ real terminal-only install without an executable Codex, no noVNC/X11/display, loopback helper, private tmux, real PTY input and ACK, eight-slot manager, panel/manager restarts preserve tasks, confirmed close ends only its shell, stale close rejected, closing all slots and migrating a desktop keeper preserve the server, explicit reopening, fixed host lifetime and shutdown');
    if(systemd)console.log('✓ real transient systemd control groups: all tasks and the keeper remain in the host, user bus settings are preserved, panel/manager stops preserve tasks, host stop kills HUP/TERM-ignoring tasks, host SIGKILL cleans its group; only unique test units were created');
  })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('terminal-only native test exceeded four minutes')), 240000); })]);
} catch (error) { for (const child of children) if (child.output) console.error(child.output.slice(-8192)); throw error; }
finally {
  clearTimeout(deadline); for (const socket of sockets) socket.terminate();
  for (const child of [panel, manager, host, ...children]) await stop(child);
  await exec('tmux',['-S',join(runtime,'tmux.sock'),'kill-server'],{env,timeout:3000,maxBuffer:4096}).catch(()=>{});
  if (tmuxOwner) {
    try { const stat=await readFile('/proc/'+tmuxOwner.pid+'/stat','utf8'); if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]===tmuxOwner.started)process.kill(tmuxOwner.pid,'SIGTERM'); } catch {}
  }
  for (const pid of taskOwners.keys()) { try { if (await taskAlive(pid)) process.kill(pid, 'SIGKILL'); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
