import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { validateInput } from '../native/input.mjs';
import { settings } from '../native/config.mjs';
import { createTerminalManager } from '../native/terminals.mjs';

const target = terminal => ({ terminalId: terminal.id, terminalToken: terminal.token });
async function listed(app) { return (await app.request('/api/terminals')).json(); }
async function create(app, name) { const response = await app.request('/api/terminals', { method: 'POST', body: { action: 'create', name } }); assert.equal(response.status, 200); return response.json(); }

test('deployment terminal limits default to four and reject values outside one to eight', () => {
  assert.equal(settings({}).maxTerminals, 4);
  for (const limit of [1, 4, 8]) assert.equal(settings({ MAX_TERMINALS: String(limit) }).maxTerminals, limit);
  for (const value of ['', '0', '-1', '9', '1.5', 'NaN', 'unbounded']) assert.throws(() => settings({ MAX_TERMINALS: value }), /MAX_TERMINALS/);
});

test('lowering the deployment limit preserves existing targets and prevents new shells', async () => {
  let launches = 0;
  const rows = ['codex\t%0\t4000\tbash\t0\t0\t', 'codex-aux7\t%7\t4107\tbash\t0\t0\t'];
  const manager = createTerminalManager({ runtime: '/isolated', workspace: '/workspace', maxTerminals: 1 }, { run: async (_command, args) => {
    if (args.includes('list-panes')) return rows.join('\n');
    launches++; throw new Error('unexpected mutation');
  } });
  const listed = await manager.list(); assert.equal(listed.limit, 1); assert.equal(listed.terminals.length, 2);
  const destination = target(listed.terminals.at(-1));
  assert.deepEqual(await manager.manage({ action: 'open', view: 'terminal', ...destination }), { ...listed, opened: 'aux7' });
  await assert.rejects(manager.manage({ action: 'create', name: '超过新上限' }), /最多保留 1 个/);
  assert.equal(launches, 0);
});

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

test('seven independent auxiliary slots keep literal names, survive repeated reads and forbid automatic desktop recovery', async t => {
  const calls = [];
  const app = await fixture({ maxTerminals: 8, desktopHook: (command, args) => calls.push({ command, args }) }); t.after(() => app.close()); await app.login(); await app.claim();
  const original = await (await app.request('/api/desktop/settings')).json();
  const label = "测试 ' $(never) `never`";
  const first = await create(app, label);
  assert.equal(first.created, 'aux1'); assert.equal(first.opened, 'aux1'); assert.equal(first.terminals[1].name, label);
  for (let number = 2; number <= 7; number++) await create(app, `辅助 ${number}`);
  assert.equal((await app.request('/api/terminals', { method: 'POST', body: { action: 'create', name: '超过上限' } })).status, 409);
  const before = await listed(app);
  assert.equal(before.limit, 8);
  assert.deepEqual(before.terminals.map(item => item.id), ['main', 'aux1', 'aux2', 'aux3', 'aux4', 'aux5', 'aux6', 'aux7']);
  const last = before.terminals.at(-1);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter', ...target(last) } })).status, 200);
  assert.deepEqual(app.inputCalls, [{ action: 'key', key: 'Enter', ...target(last) }]);
  await app.request('/api/terminals'); await app.request('/api/state');
  assert.deepEqual(await listed(app), before);
  assert.equal(calls.filter(item => item.args.includes('new-session')).length, 7);
  assert.equal(calls.find(item => item.args.includes('@codex_cloud_name')).args.at(-1), label);
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
  for (const terminalId of ['codex', 'aux0', 'aux8', '../main', 'aux1; echo x']) assert.throws(() => validateInput({ action: 'key', key: 'Enter', terminalId, terminalToken: terminal.token }));
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
  assert.equal(await response, 409); assert.equal((await app.request('/api/terminals')).status, 409); assert.equal((await app.controls.listTerminals()).terminals.length, 2);
});
