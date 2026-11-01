import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { validateInput, executeInput, runInputCommand } from '../native/input.mjs';
import { fixture } from './fixture.mjs';
import { SHORTCUTS } from '../panel/public/shortcuts.js';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function delayed(app, path, value) {
  const body = JSON.stringify(value), started = once(app.panel.server, 'request');
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + path, { method: 'POST', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
    request.on('error', reject); request.write(body.slice(0, 1));
  });
  await started;
  return { finish() { request.end(body.slice(1)); return response; }, close() { request.destroy(); } };
}

test('delayed paste, Enter and terminal requests are rejected after takeover, logout, expiry or reclaim', async () => {
  for (const scenario of ['takeover', 'logout', 'expiry', 'reclaim']) {
    const app = await fixture({ sessionMs: scenario === 'expiry' ? 300 : undefined });
    try {
      for (const [path, body] of [['/api/paste', { text: 'mock only', target: 'terminal' }], ['/api/key', { key: 'Enter' }], ['/api/terminal', {}]]) {
        await app.login(); await app.claim();
        const pending = await delayed(app, path, body);
        try {
          if (scenario === 'logout') await app.request('/api/logout', { method: 'POST', body: {} });
          else if (scenario === 'expiry') await new Promise(resolve => setTimeout(resolve, 330));
          else { await app.claim('22222222-2222-4222-8222-222222222222'); if (scenario === 'reclaim') await app.claim(); }
          const response = await pending.finish();
          assert.equal(response.status, ['logout', 'expiry'].includes(scenario) ? 401 : 409, `${scenario}: ${path}`);
          assert.equal(response.body.outcome, 'rejected');
        } finally { pending.close(); }
      }
      assert.deepEqual(app.inputCalls, []);
    } finally { await app.close(); }
  }
});

test('a delayed claim cannot revive a logged-out session or replace the new owner', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const pending = await delayed(app, '/api/desktop/claim', { viewer: app.viewer }); t.after(pending.close);
  await app.request('/api/logout', { method: 'POST', body: {} });
  await app.login(); await app.claim('22222222-2222-4222-8222-222222222222');
  assert.equal((await pending.finish()).status, 401);
  assert.equal((await (await app.request('/api/state', { headers: { 'x-viewer-id': '22222222-2222-4222-8222-222222222222' } })).json()).mine, true);
});

test('busy inputs fail immediately without queuing and exclude desktop maintenance', async t => {
  const hold = gate(), started = gate();
  const app = await fixture({ inputHook: async () => { started.release(); await hold.promise; } });
  t.after(() => app.close()); t.after(hold.release);
  await app.login(); await app.claim();
  const first = app.request('/api/paste', { method: 'POST', body: { text: '中文原样 $(never)', target: 'terminal' } });
  await started.promise;
  assert.equal((await (await app.request('/api/state')).json()).controls.inputBusy, true);
  for (const path of ['/api/key', '/api/terminal', '/api/desktop/terminal-display']) {
    const response = await app.request(path, { method: 'POST', body: path.endsWith('/key') ? { key: 'Enter' } : { action: 'maximize' } });
    assert.equal(response.status, 409); assert.equal((await response.json()).outcome, 'rejected');
  }
  assert.equal(app.inputCalls.length, 1);
  hold.release(); assert.equal((await (await first).json()).outcome, 'success');
  assert.equal(app.controls.status().inputBusy, false); assert.equal(app.inputCalls.length, 1);
  assert.equal(JSON.stringify(app.controls.status()).includes('中文原样'), false);
});

test('desktop maintenance blocks HTTP input and VNC upgrades, then allows explicit new input', async t => {
  const hold = gate(), started = gate();
  const app = await fixture({ desktopHook: async (command, args) => { if (command === 'xdotool' && args[0] === 'windowclose') { started.release(); await hold.promise; } } });
  t.after(() => app.close()); t.after(hold.release);
  await app.login(); await app.claim();
  const view = await (await app.request('/api/desktop/settings')).json();
  assert.equal((await app.request('/api/desktop/terminal-display', { method: 'POST', body: { action: 'font', revision: view.revision } })).status, 200);
  await started.promise;
  assert.equal((await (await app.request('/api/state')).json()).controls.maintenance, true);
  for (const [path, body] of [['/api/paste', { text: 'never sent' }], ['/api/key', { key: 'Enter' }], ['/api/terminal', {}]]) {
    const response = await app.request(path, { method: 'POST', body });
    assert.equal(response.status, 409); assert.equal((await response.json()).outcome, 'rejected');
  }
  const status = await new Promise(resolve => {
    const socket = new WebSocket(app.config.origin.replace('http:', 'ws:') + `/desktop/websockify?viewer=${app.viewer}`, { origin: app.config.origin, headers: { cookie: app.cookie } });
    socket.on('error', () => {}); socket.once('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
  });
  assert.equal(status, 503); assert.equal(app.inputCalls.length, 0);
  hold.release();
  for (let i = 0; app.controls.status().maintenance && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.controls.status().maintenance, false);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 200);
  assert.deepEqual(app.inputCalls, [{ action: 'key', key: 'Enter' }]);
});

test('failed execution returns unknown, keeps one bounded metadata record and is never replayed', async t => {
  const app = await fixture({ inputHook: () => { throw new Error('mock command failed after dispatch'); } }); t.after(() => app.close());
  await app.login(); await app.claim();
  const result = await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } });
  assert.equal(result.status, 502); assert.equal((await result.json()).outcome, 'unknown');
  assert.equal(app.controls.status().input.status, 'unknown');
  for (let i = 0; i < 3; i++) await app.request('/api/state');
  assert.equal(app.inputCalls.length, 1);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'constructor' } })).status, 400);
  assert.equal(app.inputCalls.length, 1);
});

test('input pauses before the manager acknowledges maintenance, including existing VNC connections', async t => {
  const hold = gate(), started = gate();
  const app = await fixture({ applyHook: async () => { started.release(); await hold.promise; } });
  t.after(() => app.close()); t.after(hold.release);
  await app.login(); await app.claim();
  let view = await (await app.request('/api/desktop/settings')).json();
  await app.request('/api/desktop/settings', { method: 'POST', body: { ...view.saved, width: 1920, revision: view.revision } });
  view = await (await app.request('/api/desktop/settings')).json();
  const socket = new WebSocket(app.config.origin.replace('http:', 'ws:') + `/desktop/websockify?viewer=${app.viewer}`, { origin: app.config.origin, headers: { cookie: app.cookie } });
  socket.on('error', () => {}); await once(socket, 'open');
  const closed = once(socket, 'close');
  const applying = app.request('/api/desktop/apply', { method: 'POST', body: { revision: view.revision, panePid: view.session.pid, resumeId: view.session.resumeId, confirm: true } });
  await started.promise; await closed;
  assert.equal(app.controls.status().maintenance, false, 'the mock manager has not admitted the job yet');
  assert.equal((await (await app.request('/api/state')).json()).controls.maintenance, true);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 409);
  assert.deepEqual(app.inputCalls, []);
  hold.release(); assert.equal((await applying).status, 200);
});

test('input validation and fixed commands preserve literal stdin and never append Enter', async () => {
  for (const body of [{ action: 'key', key: '__proto__' }, { action: 'key', key: ['Enter'] }, { action: 'paste', text: 'x'.repeat(32769) }, { action: 'paste', text: 'a\0b' }, { action: 'paste', text: 'ok', target: 'bad' }]) assert.throws(() => validateInput(body));
  const calls = [], text = '中文\n`touch /tmp/never` $(never)';
  await executeInput(validateInput({ action: 'paste', text, target: 'terminal' }), {}, async (command, args, options) => calls.push({ command, args, input: options.input }));
  assert.deepEqual(calls, [
    { command: 'xclip', args: ['-selection', 'clipboard', '-i'], input: text },
    { command: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+shift+v'], input: undefined },
  ]);
  await executeInput(validateInput({ action: 'paste', text, target: 'application' }), {}, async (_command, args) => { if (args[0] === 'key') assert.equal(args.at(-1), 'ctrl+v'); });
  await assert.rejects(runInputCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, timeout: 50 }), /timed out/);
  await assert.rejects(runInputCommand('/nonexistent/codex-test-input', [], { env: process.env, timeout: 50 }));
});

test('shortcut catalog uses fixed argv, preserves newline versus Enter and refuses arbitrary chords', async () => {
  const calls = [];
  for (const { key } of SHORTCUTS) {
    const value = validateInput({ action: 'key', key });
    await executeInput(value, {}, async (command, args) => calls.push({ key, command, args }));
  }
  assert.equal(new Set(SHORTCUTS.map(item => item.key)).size, SHORTCUTS.length);
  assert.ok(SHORTCUTS.length <= 48);
  assert.ok(calls.every(call => call.command === 'xdotool' && call.args[0] === 'key' && call.args[1] === '--clearmodifiers'));
  const args = key => calls.find(call => call.key === key).args;
  assert.deepEqual(args('Ctrl+J'), ['key', '--clearmodifiers', 'ctrl+j']);
  assert.deepEqual(args('Enter'), ['key', '--clearmodifiers', 'Return']);
  assert.deepEqual(args('Ctrl+ArrowLeft'), ['key', '--clearmodifiers', 'ctrl+Left']);
  assert.deepEqual(args('Alt+Backspace'), ['key', '--clearmodifiers', '--delay', '0', 'Escape', 'BackSpace']);
  assert.deepEqual(args('Ctrl+Shift+V'), ['key', '--clearmodifiers', 'ctrl+shift+v']);
  assert.deepEqual(args('Escape Escape'), ['key', '--clearmodifiers', '--delay', '80', 'Escape', 'Escape']);
  assert.ok(calls.filter(call => call.key !== 'Enter').every(call => !call.args.includes('Return')));
  for (const key of ['Shift+Enter', 'ctrl+r', 'Ctrl+R;echo injected', 'ctrl+r Return', '__proto__', 'constructor', ['Ctrl+R']]) {
    assert.throws(() => validateInput({ action: 'key', key }));
    await assert.rejects(executeInput({ action: 'key', key }, {}, async () => assert.fail('invalid key executed')));
  }
});
