import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { readClipboard } from '../native/clipboard.mjs';
import { fixture } from './fixture.mjs';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
function processReader(script, options = {}) {
  return readClipboard('primary', process.env, { ...options, spawnProcess(command, args, settings) {
    assert.equal(command, 'xclip');
    assert.deepEqual(args, ['-selection', 'primary', '-out', '-target', 'UTF8_STRING']);
    assert.equal(settings.env, process.env);
    return spawn(process.execPath, ['-e', script], settings);
  } });
}

test('clipboard reader preserves UTF-8, BOM and whitespace across chunks, including empty selections', async () => {
  const text = '\ufeff  中文 😀\r\n`$(never)`\t\n ';
  const bytes = [...Buffer.from(text)];
  const result = await processReader(`const b=Buffer.from(${JSON.stringify(bytes)});process.stdout.write(b.subarray(0,4));setTimeout(()=>process.stdout.end(b.subarray(4)),10);`);
  assert.deepEqual(result, { source: 'primary', text, bytes: bytes.length });
  assert.equal((await processReader('')).text, '');
});

test('clipboard reader rejects oversized, invalid, unavailable and timed-out selections without exposing stderr', async () => {
  await assert.rejects(processReader('process.stdout.write(Buffer.alloc(32769,65))'), { status: 413 });
  await assert.rejects(processReader('process.stdout.write(Buffer.from([255,254]))'), { status: 422 });
  await assert.rejects(processReader('process.stdout.write(Buffer.from([65,0,66]))'), { status: 422 });
  await assert.rejects(processReader('process.stderr.write("private clipboard details");process.exit(1)'), error => error.status === 404 && !error.message.includes('private'));
  await assert.rejects(processReader('setInterval(()=>{},1000)', { timeout: 50 }), { status: 504 });
  assert.throws(() => readClipboard('clipboard; never', process.env), { status: 400 });
});

test('clipboard API requires login, current owner, Origin and CSRF, and returns literal uncached text', async t => {
  const app = await fixture(); t.after(() => app.close());
  const path = '/api/clipboard/read', body = { source: 'clipboard' };
  app.clipboardText.clipboard = '  中文\r\n</textarea><script>never()</script>\n';
  assert.equal((await app.request(path, { method: 'POST', body })).status, 401);
  await app.login();
  assert.equal((await app.request(path, { method: 'POST', body })).status, 409);
  await app.claim();
  assert.equal((await app.request(path, { method: 'POST', body, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', body, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', body: { source: '/etc/passwd' } })).status, 400);
  assert.equal((await app.request(path, { method: 'POST', body: { source: 'clipboard', padding: 'x'.repeat(1025) } })).status, 413);
  assert.equal((await app.request(path)).status, 404); assert.deepEqual(app.clipboardReads, []);
  const response = await app.request(path, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { source: 'clipboard', text: app.clipboardText.clipboard, bytes: Buffer.byteLength(app.clipboardText.clipboard) });
  assert.deepEqual(app.inputCalls, []);
  assert.equal(JSON.stringify(app.controls.status()).includes('中文'), false);
});

test('clipboard responses support the full bounded payload after JSON escaping', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  app.clipboardText.primary = '\x01'.repeat(32768);
  const response = await app.request('/api/clipboard/read', { method: 'POST', body: { source: 'primary' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).text, app.clipboardText.primary);
});

test('clipboard read is exclusive with inputs, desktop actions and other reads, with no retained contents', async t => {
  const hold = gate(), started = gate();
  const app = await fixture({ clipboardHook: async () => { started.release(); await hold.promise; } });
  t.after(() => app.close()); t.after(hold.release); await app.login(); await app.claim();
  app.clipboardText.clipboard = 'private preview';
  const first = app.request('/api/clipboard/read', { method: 'POST', body: { source: 'clipboard' } });
  await started.promise;
  assert.equal(app.controls.status().clipboardBusy, true);
  for (const [path, body] of [['/api/clipboard/read', { source: 'primary' }], ['/api/key', { key: 'Enter' }], ['/api/desktop/terminal-display', { action: 'maximize' }]]) assert.equal((await app.request(path, { method: 'POST', body })).status, 409);
  assert.deepEqual(app.clipboardReads, ['clipboard']); assert.deepEqual(app.inputCalls, []);
  hold.release(); assert.equal((await first).status, 200);
  assert.equal(app.controls.status().clipboardBusy, false);
  assert.equal(JSON.stringify(app.controls.status()).includes('private preview'), false);
});

test('clipboard contents are discarded when ownership, login or the claim generation changes during read', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const scenario of ['takeover', 'reclaim', 'logout', 'expiry']) {
    const hold = gate(), started = gate();
    const app = await fixture({ sessionMs: 60000, clipboardHook: async () => { started.release(); await hold.promise; } });
    try {
      await app.login(); assert.equal((await app.claim()).status, 200); app.clipboardText.primary = 'never return this late text';
      const pending = app.request('/api/clipboard/read', { method: 'POST', body: { source: 'primary' } });
      await started.promise;
      if (scenario === 'logout') await app.request('/api/logout', { method: 'POST', body: {} });
      else if (scenario === 'expiry') now += app.config.sessionMs;
      else { await app.claim('22222222-2222-4222-8222-222222222222'); if (scenario === 'reclaim') await app.claim(); }
      hold.release(); const response = await pending;
      assert.equal(response.status, ['logout', 'expiry'].includes(scenario) ? 401 : 409, scenario);
      assert.equal((await response.text()).includes(app.clipboardText.primary), false);
    } finally { hold.release(); await app.close(); }
  }
});

test('a delayed clipboard body cannot read after takeover', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const body = JSON.stringify({ source: 'clipboard' }), started = once(app.panel.server, 'request');
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/clipboard/read', { method: 'POST', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    request.on('error', reject); request.write(body.slice(0, 1));
  });
  t.after(() => request.destroy()); await started;
  await app.claim('22222222-2222-4222-8222-222222222222'); request.end(body.slice(1));
  assert.equal(await response, 409); assert.deepEqual(app.clipboardReads, []);
});
