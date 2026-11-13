import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createDesktopActions, createDesktopActionServer, desktopActionClient } from '../native/desktop-actions.mjs';
import { executeInput } from '../native/input.mjs';
import { serviceUnits } from '../native/service-units.mjs';
import { fixture } from './fixture.mjs';

test('opening the fixed transfer directory requires owner, Origin and CSRF and never accepts a path', async t => {
  const app = await fixture(); t.after(() => app.close());
  const path = '/api/desktop/transfer-directory', options = { method: 'POST', body: {} };
  assert.equal((await app.request(path, options)).status, 401);
  await app.login(); assert.equal((await app.request(path, options)).status, 409);
  await app.claim();
  assert.equal((await app.request(path, { ...options, headers: { origin: 'https://invalid.example' } })).status, 403);
  assert.equal((await app.request(path, { ...options, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await app.request(path, { ...options, body: { path: '/etc' } })).status, 400);
  assert.equal(app.managementStats.folderOpens, 0);
  const result = await app.request(path, options);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
  assert.equal(app.managementStats.folderOpens, 1); assert.deepEqual(app.inputCalls, []);
  assert.equal(app.managementStats.restarts, 0);
});

test('terminal-only deployments cannot open a graphical transfer directory', async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close()); await app.login(); await app.claim();
  assert.equal((await app.request('/api/desktop/transfer-directory', { method: 'POST', body: {} })).status, 501);
  assert.equal(app.managementStats.folderOpens, 0);
});

test('transfer folder action uses a fixed private file manager, restores minimized windows and bounds children', async () => {
  const calls = [], children = []; let window = '';
  const env = { DISPLAY: ':synthetic', XAUTHORITY: '/private/auth' };
  const actions = createDesktopActions({ transfer: "/workspace/a '$(never)/transfer" }, env, {
    async run(command, args) {
      calls.push([command, args]);
      if (command === 'xprop') return '_NET_CLIENT_LIST(WINDOW): window id # 0x7b, 0x1c8';
      return args[0] === 'search' && !args.includes('--onlyvisible') ? window : '';
    },
    spawnProcess(command, args, options) {
      calls.push([command, args]); assert.equal(options.env, env);
      const child = new EventEmitter(); Object.assign(child, { exitCode: null, signalCode: null, stdin: { end() {} }, kill() { this.signalCode = 'SIGTERM'; } });
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  await assert.rejects(actions.perform('/transfer-directory', { path: '/etc' }), { status: 400 });
  assert.deepEqual(await actions.perform('/transfer-directory', {}), { ok: true });
  assert.deepEqual(calls.find(call => call[0] === 'dbus-run-session'), ['dbus-run-session', ['--', 'thunar', '--class=CodexCloudTransfer', '--', "/workspace/a '$(never)/transfer"]]);
  await assert.rejects(actions.perform('/transfer-directory', {}), { status: 409 });
  window = 'invalid\n999\n123\n456';
  assert.deepEqual(await actions.perform('/transfer-directory', {}), { ok: true });
  assert.deepEqual(calls.at(-1), ['xdotool', ['windowactivate', '--sync', '123']]);
  assert.equal(children.length, 1);
  actions.close(); assert.equal(children[0].signalCode, 'SIGTERM');
  await assert.rejects(actions.perform('/transfer-directory', {}), { status: 503 });
});

test('stopping transfer folder actions during a window probe prevents late launch', async () => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const actions = createDesktopActions({ transfer: '/fixed' }, {}, { async run() { await hold; return ''; }, spawnProcess() { throw Error('late launch'); } });
  const pending = actions.perform('/transfer-directory', {}); actions.close(); release();
  await assert.rejects(pending, { status: 503 });
});

test('a failed file manager spawn releases its slot for an explicit manual retry', async () => {
  let spawns = 0;
  const actions = createDesktopActions({ transfer: '/fixed' }, {}, {
    async run() { return ''; },
    spawnProcess() {
      const child = new EventEmitter(); Object.assign(child, { exitCode: null, signalCode: null, stdin: { end() {} }, kill() {} });
      const fail = ++spawns === 1;
      queueMicrotask(() => { if (fail) { child.emit('error', Error('spawn failed')); child.emit('close', -2); } else child.emit('spawn'); });
      return child;
    },
  });
  try {
    await assert.rejects(actions.perform('/transfer-directory', {}), /spawn failed/);
    assert.equal(spawns, 1, 'never retry automatically');
    assert.deepEqual(await actions.perform('/transfer-directory', {}), { ok: true });
    assert.equal(spawns, 2);
  } finally { actions.close(); }
});

test('desktop action socket authenticates, bounds bodies and admits only one action without a queue', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-actions-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release, entered; const hold = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const calls = [], secret = 'synthetic_desktop_secret', socketPath = join(dir, 'actions.sock');
  const server = createDesktopActionServer(secret, { async perform(path, body) { calls.push({ path, body }); entered(); await hold; return { ok: true }; } });
  server.listen(socketPath); await once(server, 'listening'); t.after(async () => { release(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  function request(path, body, auth = secret) { return new Promise((resolve, fail) => { const req = http.request({ socketPath, path, method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', fail); req.end(body); }); }
  assert.equal(await request('/terminal', '{}', 'wrong'), 401);
  assert.equal(await request('/shell', '{}'), 404);
  assert.equal(await request('/terminal', '[]'), 400);
  assert.equal(await request('/clipboard', 'x'.repeat(200 * 1024 + 1)), 413);
  const client = desktopActionClient(socketPath, secret), pending = client('/clipboard', { text: 'literal $(never) 中文' }); await started;
  assert.equal(await request('/terminal', '{"id":"main"}'), 409); assert.equal(calls.length, 1);
  release(); assert.deepEqual(await pending, { ok: true });
});

test('a failed desktop clipboard acknowledgement never sends the paste key or retries elsewhere', async () => {
  const commands = [], writes = [];
  await assert.rejects(executeInput({ action: 'paste', text: 'unchanged', target: 'terminal' }, {}, async (...args) => commands.push(args), async text => { writes.push(text); throw Error('lost acknowledgement'); }));
  assert.deepEqual(writes, ['unchanged']); assert.deepEqual(commands, []);
});

test('stopping desktop actions during a terminal probe cannot launch a late child', async () => {
  let release, entered, spawns = 0;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const actions = createDesktopActions({ root: '/synthetic' }, { TMUX_SOCKET: '/synthetic/tmux.sock' }, {
    spawnProcess() { spawns++; throw Error('must not launch after shutdown'); },
    async run(command) { if (command === 'tmux') { entered(); await hold; return ''; } throw Error('no X window'); },
  });
  const pending = actions.perform('/terminal', { id: 'main' });
  await started; actions.close(); release();
  await assert.rejects(pending, { status: 503, message: '桌面执行服务已停止' });
  assert.equal(spawns, 0);
});

test('generated services separate desktop children and bound only panel failure recovery', () => {
  const units = serviceUnits('/workspace/a b%$literal', '/usr/bin', '/usr/bin/node');
  const panel = units.get('codex-cloud-panel.service'), worker = units.get('codex-cloud-actions.service');
  assert.match(panel, /StartLimitIntervalSec=60\nStartLimitBurst=3/); assert.match(panel, /Restart=on-failure\nRestartSec=5/);
  for (const key of ['desktop', 'manager', 'actions']) assert.match(units.get(`codex-cloud-${key}.service`), /Restart=no/);
  assert.match(worker, /Requisite=codex-cloud-desktop.service/); assert.match(worker, /PartOf=codex-cloud-desktop.service/);
  assert.match(units.get('codex-cloud-manager.service'), /Wants=codex-cloud-actions.service/);
  assert.ok(!worker.includes('BindsTo=')); assert.match(worker, /KillMode=control-group/);
  assert.ok(panel.includes('a b%%$$literal/panel/main.mjs')); assert.throws(() => serviceUnits('/workspace/\ninvalid', '/usr/bin'));
});
