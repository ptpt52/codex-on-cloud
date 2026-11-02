import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { validateInput } from '../native/input.mjs';

const target = terminal => ({ terminalId: terminal.id, terminalToken: terminal.token });
async function listed(app) { return (await app.request('/api/terminals')).json(); }
async function create(app, name) { const response = await app.request('/api/terminals', { method: 'POST', body: { action: 'create', name } }); assert.equal(response.status, 200); return response.json(); }

test('terminal endpoints authenticate reads and guard mutations with ownership, CSRF, Origin and bounded bodies', async t => {
  const app = await fixture(); t.after(() => app.close());
  assert.equal((await app.request('/api/terminals')).status, 401);
  await app.login(); assert.equal((await listed(app)).terminals.length, 1);
  const body = { action: 'create', name: '测试' };
  assert.equal((await app.request('/api/terminals', { method: 'POST', body })).status, 409);
  await app.claim();
  for (const headers of [{ origin: 'https://invalid.test' }, { 'x-csrf-token': '' }]) assert.equal((await app.request('/api/terminals', { method: 'POST', body, headers })).status, 403);
  assert.equal((await app.request('/api/terminals', { method: 'POST', body: { ...body, name: 'x'.repeat(1025) } })).status, 413);
  for (const name of ['', 'x'.repeat(25), 'a\nb', 'x\0y']) assert.equal((await app.request('/api/terminals', { method: 'POST', body: { ...body, name } })).status, 400);
  assert.equal((await listed(app)).terminals.length, 1); assert.equal(app.inputCalls.length, 0);
});

test('three independent auxiliary slots keep literal names, survive repeated reads and forbid automatic desktop recovery', async t => {
  const calls = [];
  const app = await fixture({ desktopHook: (command, args) => calls.push({ command, args }) }); t.after(() => app.close()); await app.login(); await app.claim();
  const original = await (await app.request('/api/desktop/settings')).json();
  const label = "测试 ' $(never) `never`";
  const first = await create(app, label);
  assert.equal(first.created, 'aux1'); assert.equal(first.opened, 'aux1'); assert.equal(first.terminals[1].name, label);
  await create(app, '运行服务'); await create(app, '查看日志');
  assert.equal((await app.request('/api/terminals', { method: 'POST', body: { action: 'create', name: '超过上限' } })).status, 409);
  const before = await listed(app);
  await app.request('/api/terminals'); await app.request('/api/state');
  assert.deepEqual(await listed(app), before);
  assert.equal(calls.filter(item => item.args.includes('new-session')).length, 3);
  assert.equal(calls.find(item => item.args.includes('set-option')).args.at(-1), label);
  for (const call of calls.filter(item => item.args.includes('new-session'))) {
    assert.deepEqual(call.args.slice(-2), ['bash', join(app.directory, 'desktop', 'codex-session')]);
    assert.equal(call.args[call.args.indexOf('-c') + 1], '/test-workspace');
  }
  assert.equal((await (await app.request('/api/desktop/settings')).json()).session, null);
  assert.equal(app.managementStats.restarts, 0); assert.equal(original.session.pid, 4000);
});

test('targeted paste and keys verify the live terminal token and focus; stale or malformed targets execute nothing', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const result = await create(app, '辅助命令'), terminal = result.terminals.find(item => item.id === 'aux1');
  const destination = target(terminal);
  assert.equal((await app.request('/api/paste', { method: 'POST', body: { text: '只粘贴', target: 'terminal', ...destination } })).status, 200);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter', ...destination } })).status, 200);
  assert.deepEqual(app.inputCalls, [{ action: 'paste', target: 'terminal', text: '只粘贴', ...destination }, { action: 'key', key: 'Enter', ...destination }]);
  for (const terminalToken of ['%1:1', '%999:4100']) {
    const response = await app.request('/api/key', { method: 'POST', body: { key: 'Enter', ...destination, terminalToken } });
    assert.equal(response.status, 409); assert.equal((await response.json()).outcome, 'rejected');
  }
  for (const terminalId of ['codex', 'aux4', '../main', 'aux1; echo x']) assert.throws(() => validateInput({ action: 'key', key: 'Enter', terminalId, terminalToken: terminal.token }));
  assert.throws(() => validateInput({ action: 'key', key: 'Enter', terminalId: 'main' }));
  assert.throws(() => validateInput({ action: 'paste', text: 'x', target: 'application', ...destination }));
  assert.equal(app.inputCalls.length, 2);
  const renamed = await app.request('/api/terminals', { method: 'POST', body: { action: 'rename', ...destination, name: '改名后' } });
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).terminals[1].token, terminal.token);
});

test('targeted inputs and terminal mutations share one lock and delayed writes cannot survive takeover', async t => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ inputHook: async () => { entered(); await hold; } }); t.after(() => { release(); return app.close(); }); await app.login(); await app.claim();
  const terminal = (await create(app, '串行')).terminals[1];
  const pending = app.request('/api/key', { method: 'POST', body: { key: 'Enter', ...target(terminal) } }); await started;
  assert.equal((await app.request('/api/terminals', { method: 'POST', body: { action: 'rename', name: '不应修改', ...target(terminal) } })).status, 409);
  release(); assert.equal((await pending).status, 200);
  const body = JSON.stringify({ action: 'create', name: '不应创建' });
  const reading = once(app.panel.server, 'request'); let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/terminals', { method: 'POST', headers: { cookie: app.cookie, origin: app.config.origin, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject); request.write(body.slice(0, 1));
  }); t.after(() => request.destroy()); await reading;
  await app.claim('22222222-2222-4222-8222-222222222222'); request.end(body.slice(1));
  assert.equal(await response, 409); assert.equal((await listed(app)).terminals.length, 2);
});
