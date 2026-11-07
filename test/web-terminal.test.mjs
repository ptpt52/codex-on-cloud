import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { terminalPaste, TERMINAL_KEYS } from '../panel/terminal-bridge.mjs';

function url(app, query = {}) { const target = new URL('/terminal/connect', app.config.origin); target.protocol = 'ws:'; target.search = new URLSearchParams({ viewer: app.viewer, terminalId: 'main', terminalToken: '%0:4000', ...query }); return target; }
async function denied(app, query, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(app, query), { headers: { cookie: app.cookie, origin: app.config.origin, ...headers } });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); }); ws.on('open', () => { ws.terminate(); reject(new Error('unexpected upgrade')); }); ws.on('error', () => {});
  });
}
async function connected(app, csrf = app.csrf, acknowledge = true) {
  const ws = new WebSocket(url(app), { headers: { cookie: app.cookie, origin: app.config.origin } }), records = [];
  ws.on('error', () => {});
  ws.on('message', bytes => { const value = JSON.parse(bytes); records.push(value); if (records.length > 64) records.shift(); if (value.type === 'output' && acknowledge) ws.send(JSON.stringify({ type: 'ack', bytes: Buffer.from(value.data, 'base64').length })); });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', csrf }));
  return { ws, records };
}
async function until(probe) { for (let i = 0; i < 150; i++) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('web terminal mock deadline'); }

test('terminal assets and WebSockets authenticate Host, Origin, viewer, target token and a CSRF handshake before launching a PTY', async t => {
  const app = await fixture(); t.after(() => app.close());
  for (const path of ['/terminal/index.html', '/terminal/terminal.js', '/terminal/terminal-health.js', '/terminal/terminal-rtc.js', '/terminal/terminal-history.js', '/terminal/terminal-history-style.js', '/terminal/terminal-history-limits.js', '/terminal/xterm.js']) assert.equal((await app.request(path)).status, 401);
  assert.equal(await denied(app), 401); await app.login(); assert.equal(await denied(app), 409); await app.claim();
  for (const headers of [{ origin: 'https://evil.test' }, { host: 'evil.test', origin: 'http://evil.test' }]) assert.equal(await denied(app, {}, headers), 403);
  assert.equal(await denied(app, { terminalId: '../main' }), 400); assert.equal(await denied(app, { terminalToken: '%0:9999' }), 409);
  for (const csrf of ['', 'bad', {}, { toString: 'invalid' }]) {
    const { ws } = await connected(app, csrf); await once(ws, 'close'); assert.equal(app.terminalConnections, 0);
  }
  for (const first of ['null', JSON.stringify({ type: 'health', nonce: 1 })]) {
    const malformed = new WebSocket(url(app), { headers: { cookie: app.cookie, origin: app.config.origin } });
    await once(malformed, 'open'); const malformedClosed = once(malformed, 'close'); malformed.send(first); await malformedClosed; assert.equal(app.terminalConnections, 0);
  }
  for (const path of ['/terminal/index.html', '/terminal/terminal.js', '/terminal/terminal-health.js', '/terminal/terminal-history.js', '/terminal/terminal-history-style.js', '/terminal/terminal-history-limits.js', '/terminal/xterm.js', '/terminal/fit.js', '/terminal/xterm.css']) assert.equal((await app.request(path)).status, 200);
  const { ws, records } = await connected(app); t.after(() => ws.terminate()); await until(() => records.some(item => item.type === 'ready'));
  assert.equal(app.terminalConnections, 1); assert.equal(app.inputCalls.length, 0); assert.equal(app.terminalInputs.length, 0);
});

test('terminal paste and fixed keys preserve separate Enter, protect multiline paste and read remote clipboard only explicitly', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const { ws, records } = await connected(app); t.after(() => ws.terminate()); await until(() => records.some(item => item.type === 'ready'));
  ws.send(JSON.stringify({ type: 'control', id: 1, action: 'paste', text: '中文\n第二行', bracketed: true })); await until(() => records.some(item => item.id === 1));
  assert.equal(app.terminalInputs[0].text, '\x1b[200~中文\n第二行\x1b[201~');
  ws.send(JSON.stringify({ type: 'control', id: 2, action: 'key', key: 'Enter' })); await until(() => records.some(item => item.id === 2)); assert.equal(app.terminalInputs[1].text, '\r');
  ws.send(JSON.stringify({ type: 'control', id: 3, action: 'paste', text: '不得\n自动提交', bracketed: false })); await until(() => records.some(item => item.id === 3));
  assert.equal(records.find(item => item.id === 3).outcome, 'rejected'); assert.equal(app.terminalInputs.length, 2);
  app.clipboardText.clipboard = '远程剪贴板'; ws.send(JSON.stringify({ type: 'control', id: 4, action: 'key', key: 'Ctrl+Shift+V', bracketed: true })); await until(() => records.some(item => item.id === 4));
  assert.equal(app.terminalInputs[2].text, '\x1b[200~远程剪贴板\x1b[201~'); assert.deepEqual(app.clipboardReads, ['clipboard']); assert.equal(app.inputCalls.length, 0);
  ws.send(JSON.stringify({ type: 'control', id: 5, action: 'paste', text: '\b'.repeat(32768), bracketed: true })); await until(() => records.some(item => item.id === 5));
  assert.equal(records.find(item => item.id === 5).ok, true); assert.equal(Buffer.byteLength(app.terminalInputs[3].text), 32780);
  const started = Date.now(); ws.send(JSON.stringify({ type: 'control', id: 6, action: 'key', key: 'Escape Escape' })); await until(() => records.some(item => item.id === 6));
  assert.ok(Date.now() - started >= 75); assert.deepEqual(app.terminalInputs.slice(-2).map(item => item.text), ['\x1b', '\x1b']);
  assert.equal(TERMINAL_KEYS['Ctrl+J'], '\n'); assert.equal(TERMINAL_KEYS.Enter, '\r');
  assert.equal(TERMINAL_KEYS['Shift+ArrowLeft'], '\x1b[1;2D'); assert.equal(TERMINAL_KEYS['Shift+ArrowRight'], '\x1b[1;2C');
  assert.throws(() => terminalPaste('x\ny', false)); assert.throws(() => terminalPaste('x'.repeat(32769), true)); assert.throws(() => terminalPaste('x\0y', true));
});

test('terminal output pauses the producer until rendered-byte acknowledgments drain the bounded window', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const { ws, records } = await connected(app, app.csrf, false); t.after(() => ws.terminate()); await until(() => records.some(item => item.type === 'ready'));
  const child = app.terminalChildren[0];
  for (let i = 0; i < 10; i++) child.stdout.write(JSON.stringify({ type: 'output', data: Buffer.alloc(8192, 65).toString('base64') }) + '\n');
  await until(() => child.stdout.isPaused() && records.filter(item => item.type === 'output').length >= 8);
  const rendered = records.filter(item => item.type === 'output').reduce((total, item) => total + Buffer.from(item.data, 'base64').length, 0);
  ws.send(JSON.stringify({ type: 'ack', bytes: rendered })); await until(() => !child.stdout.isPaused());
  assert.equal(app.terminalInputs.length, 0);
});

test('terminal streaming accepts bounded sizes and UTF-8 input, rejects repeated IDs and closes on takeover without replay', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  let active = await connected(app); await until(() => active.records.some(item => item.type === 'ready'));
  active.ws.send(JSON.stringify({ type: 'resize', id: 1, cols: 120, rows: 30 })); active.ws.send(JSON.stringify({ type: 'input', id: 2, data: '中文键入' }));
  await until(() => app.terminalInputs.length === 1); assert.deepEqual(app.terminalSizes, [{ terminalId: 'main', cols: 120, rows: 30 }]);
  const closed = once(active.ws, 'close'); active.ws.send(JSON.stringify({ type: 'input', id: 2, data: '不能重放' })); await closed;
  assert.equal(app.terminalInputs.length, 1);
  active = await connected(app); await until(() => active.records.some(item => item.type === 'ready'));
  const revoked = once(active.ws, 'close'); await app.claim('22222222-2222-4222-8222-222222222222'); await revoked;
  assert.equal(app.terminalInputs.length, 1); assert.equal((await app.controls.get()).session.pid, 4000);
});

test('read-only geometry forwards bounded client limits, rejects malformed values and cannot cross takeover', async t => {
  const app = await fixture({ terminalMaxCols: 122 }); t.after(() => app.close()); await app.login(); await app.claim();
  let active = await connected(app); await until(() => active.records.some(value => value.type === 'ready'));
  assert.equal(active.records.some(value => value.type === 'geometry'), false, 'legacy pages receive only known record types');
  active.ws.send(JSON.stringify({ type: 'resize', id: 1, cols: 233, rows: 44, geometry: true }));
  await until(() => active.records.some(value => value.type === 'geometry'));
  assert.deepEqual(active.records.find(value => value.type === 'geometry'), { type: 'geometry', maxCols: 122 });
  for (const maxCols of [0, 501, '122', 12.5]) {
    const closed = once(active.ws, 'close');
    app.terminalChildren[0].stdout.write(JSON.stringify({ type: 'geometry', maxCols }) + '\n'); await closed;
    active = await connected(app); await until(() => active.records.some(value => value.type === 'ready'));
  }
  const revoked = once(active.ws, 'close'); await app.claim('22222222-2222-4222-8222-222222222222'); await revoked;
  assert.deepEqual(app.terminalInputs, []); assert.deepEqual(app.terminalSizes, [{ terminalId: 'main', cols: 233, rows: 44 }]); assert.equal(app.managementStats.restarts, 0);
});

test('malformed, oversized and invalid output acknowledgments close the terminal without executing input', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  for (const value of ['not-json', JSON.stringify({ type: 'resize', id: 1, cols: 501, rows: 20 }), JSON.stringify({ type: 'resize', id: 1, cols: 233, rows: 40, viewport: 'true' }), JSON.stringify({ type: 'ack', bytes: 999999 }), JSON.stringify({ type: 'input', id: 1, data: 'x'.repeat(8193) })]) {
    const { ws, records } = await connected(app); await until(() => records.some(item => item.type === 'ready'));
    const closed = once(ws, 'close'); ws.send(value); await closed;
  }
  assert.equal(app.terminalInputs.length, 0); assert.equal((await app.controls.listTerminals()).terminals.length, 1);
});

test('read-only terminal health is independent of a pending input and does not consume input IDs', async t => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ terminalHook: async () => { entered(); await hold; } }); t.after(() => { release(); return app.close(); }); await app.login(); await app.claim();
  const { ws, records } = await connected(app); t.after(() => ws.terminate()); await until(() => records.some(item => item.type === 'ready'));
  ws.send(JSON.stringify({ type: 'health', nonce: 1 })); await until(() => records.some(item => item.type === 'health' && item.nonce === 1));
  assert.deepEqual(app.terminalInputs, []); assert.deepEqual(app.terminalSizes, []); assert.deepEqual(app.clipboardReads, []);
  ws.send(JSON.stringify({ type: 'control', id: 1, action: 'key', key: 'Enter' })); await started;
  ws.send(JSON.stringify({ type: 'health', nonce: 2 })); await until(() => records.some(item => item.type === 'health' && item.nonce === 2));
  assert.equal(records.some(item => item.type === 'result'), false); assert.equal(app.terminalInputs.length, 1);
  release(); await until(() => records.some(item => item.type === 'result' && item.id === 1));
  ws.send(JSON.stringify({ type: 'resize', id: 2, cols: 100, rows: 24 })); await until(() => app.terminalSizes.length === 1);
  assert.equal(app.terminalInputs.length, 1); assert.equal(app.managementStats.restarts, 0);
});

test('terminal health rejects malformed, repeated, extra-field and rate-exceeding records before forwarding any input', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  for (const value of [{ type: 'health', nonce: 0 }, { type: 'health', nonce: -1 }, { type: 'health', nonce: '1' }, { type: 'health', nonce: 2147483648 }, { type: 'health', nonce: 1, data: 'Enter' }, { type: 'health', nonce: 1, padding: 'x'.repeat(96) }]) {
    const { ws, records } = await connected(app); await until(() => records.some(item => item.type === 'ready'));
    const closed = once(ws, 'close'); ws.send(JSON.stringify(value)); await closed;
  }
  let current = await connected(app); await until(() => current.records.some(item => item.type === 'ready'));
  current.ws.send(JSON.stringify({ type: 'health', nonce: 1 })); await until(() => current.records.some(item => item.type === 'health'));
  let closed = once(current.ws, 'close'); current.ws.send(JSON.stringify({ type: 'health', nonce: 1 })); await closed;
  current = await connected(app); await until(() => current.records.some(item => item.type === 'ready'));
  for (let nonce = 1; nonce <= 8; nonce++) current.ws.send(JSON.stringify({ type: 'health', nonce }));
  await until(() => current.records.filter(item => item.type === 'health').length === 8);
  closed = once(current.ws, 'close'); current.ws.send(JSON.stringify({ type: 'health', nonce: 9 })); await closed;
  assert.deepEqual(app.terminalInputs, []); assert.deepEqual(app.terminalSizes, []); assert.deepEqual(app.clipboardReads, []);
});

test('history pages use a separate bounded read-only slot without consuming or replaying accepted input', async t => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const text = '中文历史😀\n'.repeat(6000), app = await fixture({ terminalHistory: text, terminalHook: async () => { entered(); await hold; } });
  t.after(() => { release(); return app.close(); }); await app.login(); await app.claim();
  const { ws, records } = await connected(app); t.after(() => ws.terminate()); await until(() => records.some(value => value.type === 'ready'));
  ws.send(JSON.stringify({ type: 'control', id: 1, action: 'key', key: 'Enter' })); await started;
  const parts = []; let id = 1, offset = 0;
  for (let page = 0; page < 8; page++) {
    ws.send(JSON.stringify({ type: 'history', id: ++id, offset })); await until(() => records.some(value => value.type === 'history' && value.id === id));
    const value = records.find(value => value.type === 'history' && value.id === id), bytes = Buffer.from(value.data, 'base64');
    assert.equal(value.ok, true); assert.ok(bytes.length <= 8192); parts.push(bytes); offset = value.next;
    if (value.done) break;
  }
  assert.equal(Buffer.concat(parts).length, 65536); assert.deepEqual(Buffer.concat(parts), Buffer.from(text).subarray(-65536));
  assert.equal(records.some(value => value.type === 'result'), false); assert.equal(app.terminalHistoryReads.length, 8);
  ws.send(JSON.stringify({ type: 'history', id: ++id, offset: 0 })); await until(() => records.some(value => value.type === 'history' && value.id === id));
  assert.equal(records.find(value => value.type === 'history' && value.id === id).ok, false); assert.equal(app.terminalHistoryReads.length, 8);
  release(); await until(() => records.some(value => value.type === 'result' && value.id === 1));
  assert.deepEqual(app.terminalInputs, [{ terminalId: 'main', text: '\r' }]); assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.clipboardReads, []);
});

test('malformed history records close before reading and takeover discards a delayed snapshot', async t => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ terminalHistory: '不得泄露的测试快照', terminalHistoryHook: async () => { entered(); await hold; } });
  t.after(() => { release(); return app.close(); }); await app.login(); await app.claim();
  for (const offset of [-1, 1, 65537, '0', true]) {
    const { ws, records } = await connected(app); await until(() => records.some(value => value.type === 'ready'));
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'history', id: 1, offset })); await closed;
  }
  assert.equal(app.terminalHistoryReads.length, 0);
  const { ws, records } = await connected(app); await until(() => records.some(value => value.type === 'ready'));
  ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0 })); await started;
  const closed = once(ws, 'close'); await app.claim('22222222-2222-4222-8222-222222222222'); release(); await closed;
  assert.equal(records.some(value => value.type === 'history'), false); assert.deepEqual(app.terminalInputs, []);
});

test('opt-in history reads a full 1 MiB in bounded chunks while legacy readers retain their 64 KiB limit', async t => {
  const text = 'long-history-row\n'.repeat(70000), app = await fixture({ terminalHistory: text });
  t.after(() => app.close()); await app.login(); await app.claim();
  const { ws, records } = await connected(app); t.after(() => ws.terminate()); await until(() => records.some(value => value.type === 'ready'));
  const parts = []; let offset = 0;
  for (let id = 1; id <= 128; id++) {
    ws.send(JSON.stringify({ type: 'history', id, offset, limit: 1048576 }));
    await until(() => records.some(value => value.type === 'history' && value.id === id));
    const value = records.find(value => value.type === 'history' && value.id === id);
    assert.equal(value.ok, true); assert.equal(value.offset, offset); assert.equal(value.truncated, true);
    const bytes = Buffer.from(value.data, 'base64'); assert.equal(bytes.length, 8192); parts.push(bytes); offset = value.next;
    assert.equal(value.done, id === 128);
  }
  assert.deepEqual(Buffer.concat(parts), Buffer.from(text).subarray(-1048576));
  assert.deepEqual(app.terminalInputs, []); assert.deepEqual(app.clipboardReads, []);
});

test('history rejects unsupported limits and offsets beyond the selected bound before invoking the helper', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  for (const query of [{ limit: 0 }, { limit: 65535 }, { limit: 1048577 }, { limit: '1048576' }, { limit: true },
    { limit: 1048576, offset: 1056768 }, { limit: 1048576, offset: 65537 }, { offset: 73728 }]) {
    const { ws, records } = await connected(app); await until(() => records.some(value => value.type === 'ready'));
    const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0, ...query })); await closed;
  }
  assert.equal(app.terminalHistoryReads.length, 0); assert.deepEqual(app.terminalInputs, []);
});

test('history styling is explicitly requested; legacy readers remain plain and malformed format flags fail closed', async t => {
  const source = '\x1b[1;31m红字\x1b[0m\n', app = await fixture({ terminalHistory: source }); t.after(() => app.close()); await app.login(); await app.claim();
  const legacy = await connected(app); t.after(() => legacy.ws.terminate()); await until(() => legacy.records.some(value => value.type === 'ready'));
  assert.equal(legacy.records.find(value => value.type === 'ready').historyStyles, true);
  legacy.ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0 })); await until(() => legacy.records.some(value => value.type === 'history'));
  const plain = legacy.records.find(value => value.type === 'history'); assert.equal(plain.styled, false); assert.equal(Buffer.from(plain.data, 'base64').toString(), '红字\n');
  const modern = await connected(app); t.after(() => modern.ws.terminate()); await until(() => modern.records.some(value => value.type === 'ready'));
  modern.ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0, styled: true })); await until(() => modern.records.some(value => value.type === 'history'));
  const styled = modern.records.find(value => value.type === 'history'); assert.equal(styled.styled, true); assert.equal(Buffer.from(styled.data, 'base64').toString(), source);
  for (const extra of [{ styled: false }, { styled: 'true' }, { styled: null }, { styled: true, command: 'invalid' }]) {
    const active = await connected(app); await until(() => active.records.some(value => value.type === 'ready'));
    const closed = once(active.ws, 'close'); active.ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0, ...extra })); await closed;
  }
  assert.equal(app.terminalHistoryReads.length, 2); assert.deepEqual(app.terminalInputs, []);
});

test('a helper cannot change a styled snapshot into another format while a read is pending', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ terminalHistory: 'late', terminalHistoryHook: async () => { entered(); await hold; } }); t.after(() => { release(); return app.close(); }); await app.login(); await app.claim();
  const { ws, records } = await connected(app); await until(() => records.some(value => value.type === 'ready'));
  ws.send(JSON.stringify({ type: 'history', id: 1, offset: 0, styled: true })); await started;
  const closed = once(ws, 'close'); app.terminalChildren[0].stdout.write(JSON.stringify({ type: 'history', id: 1, offset: 0, next: 4, data: Buffer.from('late').toString('base64'), done: true,
    alternate: false, truncated: false, styled: false, ok: true }) + '\n'); await closed;
  assert.equal(records.some(value => value.type === 'history'), false); assert.deepEqual(app.terminalInputs, []);
});
