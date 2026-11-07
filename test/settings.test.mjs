import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { readPreferences, writePreferences, preferenceRevision } from '../native/preferences.mjs';
import { createDesktopControls, desktopEnvironment } from '../native/desktop-controls.mjs';
import { fixture } from './fixture.mjs';

const defaults = { width: 1600, height: 1600, fontSize: 15 };
const resumeId = '11111111-1111-4111-8111-111111111111';
async function completed(controls) {
  for (let i = 0; i < 100; i++) {
    const view = await controls.get();
    if (!view.busy) return view;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('mock job timed out');
}

test('desktop preferences are bounded, private, atomic and reject invalid or linked files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-prefs-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  assert.deepEqual(readPreferences(file, defaults), defaults);
  const value = { width: 1920, height: 1600, fontSize: 18 };
  writePreferences(file, value);
  assert.deepEqual(readPreferences(file, defaults), value);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(preferenceRevision(value), preferenceRevision({ fontSize: 18, height: 1600, width: 1920 }));
  for (const invalid of [{ ...value, width: 4097 }, { ...value, height: 319 }, { ...value, fontSize: 29 }, { ...value, width: '1920' }]) assert.throws(() => writePreferences(file, invalid));
  assert.deepEqual(readPreferences(file, defaults), value);
  await writeFile(file, 'x'.repeat(1025)); assert.throws(() => readPreferences(file, defaults));
  await rm(file); await symlink('/dev/null', file); assert.throws(() => readPreferences(file, defaults));
  // A poisoned temporary path never modifies its target.
  const target = join(directory, 'target'); await writeFile(target, 'unchanged');
  await symlink(target, file + '.tmp'); assert.throws(() => writePreferences(file, value));
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('settings routes require authentication, CSRF and current ownership; saving never restarts', async t => {
  const app = await fixture(); t.after(() => app.close());
  assert.equal((await app.request('/api/desktop/settings')).status, 401);
  await app.login();
  const initial = await (await app.request('/api/desktop/settings')).json();
  const body = { ...defaults, width: 1920, revision: initial.revision };
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body })).status, 409);
  await app.claim();
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body: { ...body, width: 8192 } })).status, 400);
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body })).status, 200);
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body })).status, 409);
  const saved = await (await app.request('/api/desktop/settings')).json();
  assert.equal(saved.saved.width, 1920); assert.equal(saved.actual.width, 1600); assert.equal(saved.restartRequired, true);
  assert.equal(app.managementStats.restarts, 0); assert.equal(app.managementStats.resumes, 0);
  assert.equal((await app.request('/api/desktop/settings', { method: 'POST', body: { padding: 'x'.repeat(1025) } })).status, 413);
  for (const path of ['/api/desktop/apply', '/api/desktop/terminal-display']) {
    await app.claim('22222222-2222-4222-8222-222222222222');
    assert.equal((await app.request(path, { method: 'POST', body: { action: 'maximize' } })).status, 409);
  }
});

test('browser resolution writes preserve the native font default without inheriting a browser preference', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const initial = await app.controls.get(); app.controls.save({ ...initial.saved, fontSize: 23, revision: initial.revision });
  const current = await (await app.request('/api/desktop/settings')).json();
  const response = await app.request('/api/desktop/settings', { method: 'POST', body: { width: 1920, height: 1600, revision: current.revision } });
  assert.equal(response.status, 200); assert.equal((await response.json()).saved.fontSize, 23);
  assert.equal((await app.controls.get()).saved.fontSize, 23); assert.equal(app.managementStats.fontChanges, 0); assert.equal(app.managementStats.restarts, 0);
});

test('delayed settings requests cannot mutate after another page takes ownership', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const initial = await (await app.request('/api/desktop/settings')).json();
  for (const path of ['/api/desktop/settings', '/api/desktop/apply', '/api/desktop/terminal-display']) {
    await app.claim();
    const body = JSON.stringify({ ...defaults, width: 1920, revision: initial.revision, action: 'maximize', confirm: true, panePid: initial.session.pid, resumeId });
    const reading = once(app.panel.server, 'request');
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(app.config.origin + path, { method: 'POST', headers: {
        origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      request.on('error', reject); request.write(body.slice(0, 1));
    });
    t.after(() => request.destroy()); await reading;
    await app.claim('22222222-2222-4222-8222-222222222222'); request.end(body.slice(1));
    assert.equal(await response, 409);
  }
  assert.equal(app.managementStats.saves, 0); assert.equal(app.managementStats.restarts, 0); assert.equal(app.managementStats.maximizes, 0);
});

test('private manager socket requires its bearer secret and limits bodies', async t => {
  const app = await fixture(); t.after(() => app.close());
  async function request(authorization, body = '') {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: app.config.managerSocket, path: '/settings', method: 'POST',
        headers: { authorization, 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
  }
  assert.equal(await request('Bearer wrong'), 401);
  assert.equal(await request(`Bearer ${app.config.agentSecret}`, '[]'), 400);
  assert.equal(await request(`Bearer ${app.config.agentSecret}`, 'x'.repeat(1025)), 413);
});

test('apply guards the observed session, serializes jobs and keeps shell text fixed for hostile cwd', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-controls-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], cwd = "/workspace/a'b $(never) `never`", config = { root: directory, runtime: directory, env: process.env, defaultPreferences: defaults, preferencesFile: join(directory, 'settings.json') };
  let pid = 4000, command = 'codex', actual = '1600 1600', id = resumeId, release;
  const restarted = new Promise(resolve => { release = resolve; });
  const controls = createDesktopControls(config, { sessionId: async () => id, run: async (executable, args) => {
    calls.push({ executable, args });
    if (executable === 'xdotool') return actual;
    if (executable === 'systemctl') { await restarted; actual = '1920 1600'; pid++; command = 'bash'; return ''; }
    if (args.includes('respawn-pane')) { command = 'codex'; return ''; }
    return `codex:0.0\t${pid}\t${command}\t${cwd}`;
  } });
  const initial = await controls.get();
  controls.save({ ...defaults, width: 1920, revision: initial.revision });
  const view = await controls.get(), body = { revision: view.revision, panePid: pid, resumeId, confirm: true };
  await assert.rejects(controls.apply({ ...body, confirm: false }), { status: 400 });
  await assert.rejects(controls.apply({ ...body, panePid: 999 }), { status: 409 });
  await assert.rejects(controls.apply({ ...body, revision: initial.revision }), { status: 409 });
  id = null; await assert.rejects(controls.apply({ ...body, resumeId: null }), { status: 409 }); id = resumeId;
  assert.equal((await controls.apply(body)).status, 'running');
  await assert.rejects(controls.apply(body), { status: 409 });
  assert.throws(() => controls.save({ ...defaults, revision: view.revision }), { status: 409 });
  release(); const result = await completed(controls);
  assert.equal(result.job.status, 'complete'); assert.equal(result.restartRequired, false);
  assert.deepEqual(calls.find(call => call.executable === 'systemctl').args, ['--user', 'restart', 'codex-cloud-desktop.service']);
  const respawn = calls.find(call => call.args.includes('respawn-pane'));
  assert.equal(respawn.args.at(-2), cwd);
  assert.equal(respawn.args.at(-1), 'exec codex resume --cd "$PWD" "$CODEX_CLOUD_RESUME_ID"');
  assert.deepEqual(calls.filter(call => call.args.includes('set-environment')).map(call => call.args.slice(2)), [
    ['set-environment', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID', resumeId],
    ['set-environment', '-u', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID'],
  ]);
  await assert.rejects(controls.apply(body), { status: 409 });
  await controls.get(); await controls.get();
  assert.equal(calls.filter(call => call.executable === 'systemctl' || call.args.includes('respawn-pane')).length, 2);
});

test('unsupported foreground tasks and multiple panes cannot trigger restart; failed jobs are not replayed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-controls-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { root: directory, runtime: directory, env: process.env, defaultPreferences: defaults, preferencesFile: join(directory, 'settings.json') };
  let pane = 'codex:0.0\t4000\tpython\t/workspace', restarts = 0;
  const controls = createDesktopControls(config, { run: async (command) => {
    if (command === 'xdotool') return '1600 1600';
    if (command === 'systemctl') { restarts++; throw new Error('unavailable'); }
    return pane;
  } });
  controls.save({ ...defaults, width: 1920, revision: (await controls.get()).revision });
  for (const value of [pane, 'codex:0.0\t4000\tbash\t/workspace\ncodex:0.1\t4001\tbash\t/workspace']) {
    pane = value; const view = await controls.get();
    await assert.rejects(controls.apply({ revision: view.revision, panePid: view.session?.pid, resumeId: null, confirm: true }), { status: 409 });
  }
  assert.equal(restarts, 0);
  pane = 'codex:0.0\t4000\tbash\t/workspace';
  await controls.apply({ revision: (await controls.get()).revision, panePid: 4000, resumeId: null, confirm: true });
  assert.equal((await completed(controls)).job.status, 'failed');
  await controls.get(); await controls.get(); assert.equal(restarts, 1);
  assert.throws(() => controls.terminal({ action: 'anything; rm' }), { status: 400 });
  const env = desktopEnvironment({ ...config, display: ':94', workspace: '/workspace', transfer: '/transfer', env: { PATH: '/bin', DBUS_SESSION_BUS_ADDRESS: 'physical', SESSION_MANAGER: 'physical' } });
  assert.equal(env.DISPLAY, ':94'); assert.equal(env.TMUX_SOCKET, join(directory, 'tmux.sock')); assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined); assert.equal(env.SESSION_MANAGER, undefined);
});
