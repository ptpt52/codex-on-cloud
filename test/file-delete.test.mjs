import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { fileDeleteOptions, fileDeleteResult } from '../panel/public/file-upload.js';

test('file deletion accepts only one literal filename and an exact version, with explicit completion', () => {
  const snapshot = { name: '资料 \\ $().txt', version: 'a'.repeat(64) };
  assert.deepEqual(fileDeleteOptions(snapshot), snapshot);
  for (const value of [null, [], {}, { ...snapshot, extra: true }, { ...snapshot, name: '../outside' }, { ...snapshot, name: '.upload-private' }, { ...snapshot, version: '*' }]) assert.throws(() => fileDeleteOptions(value), { status: 400 });
  assert.deepEqual(fileDeleteResult({ ok: true, name: snapshot.name }, snapshot.name), { ok: true, name: snapshot.name });
  for (const value of [null, {}, { ok: true }, { ok: true, name: 'other' }]) assert.throws(() => fileDeleteResult(value, snapshot.name), { status: 502, outcome: 'unknown' });
});

test('HTTP deletion requires administrator, CSRF and exact version but no desktop ownership', async t => {
  const app = await fixture(); t.after(() => app.close());
  const remove = (body, headers) => app.request('/api/files/delete', { method: 'POST', body, headers });
  const name = '中文 \\ file.txt'; app.files.set(name, Buffer.from('original'));
  assert.equal((await remove({ name, version: 'a'.repeat(64) })).status, 401);
  await app.login();
  const listing = await (await app.request('/api/files')).json(), version = listing.files[0].version;
  assert.equal(listing.deleteProtocol, 1);
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-csrf-token': '' }]) assert.equal((await remove({ name, version }, headers)).status, 403);
  for (const body of [{ name }, { name: '../outside', version }, { name, version, path: '/arbitrary' }]) assert.equal((await remove(body)).status, 400);
  app.files.set(name, Buffer.from('changed'));
  assert.equal((await remove({ name, version })).status, 412);
  assert.equal(app.files.get(name).toString(), 'changed');
  const fresh = (await (await app.request('/api/files')).json()).files[0].version;
  assert.equal((await remove({ name, version: fresh })).status, 200);
  assert.equal(app.files.has(name), false);
  assert.equal((await remove({ name, version: fresh })).status, 412);
  assert.deepEqual(app.inputCalls, []); assert.equal(app.vncConnections, 0);
});

test('temporary accounts cannot delete even when they can upload and download the shared file', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password' } });
  app.files.set('keep', Buffer.from('shared'));
  const version = (await (await app.request('/api/files')).json()).files[0].version;
  const login = await app.request('/api/login', { method: 'POST', body: { username: 'visitor', password: 'temporary-test-password' } });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await login.json()).csrf };
  assert.equal((await app.request('/api/files/keep', { headers })).status, 200);
  assert.equal((await app.request('/api/files/delete', { method: 'POST', body: { name: 'keep', version }, headers })).status, 403);
  assert.equal(app.files.get('keep').toString(), 'shared');
  assert.equal(app.received.some(req => req.method === 'DELETE'), false);
});

test('old helpers reject deletion and incomplete successful deletion is unknown without retry', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  let supported = false, deletes = 0;
  const helper = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'DELETE') { deletes++; return res.end(JSON.stringify({ ok: true })); }
    res.end(JSON.stringify({ files: [], ...(supported ? { deleteProtocol: 1 } : {}) }));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening'); t.after(() => new Promise(resolve => helper.close(resolve)));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  const remove = () => app.request('/api/files/delete', { method: 'POST', body: { name: 'file', version: 'a'.repeat(64) } });
  assert.equal((await remove()).status, 503); assert.equal(deletes, 0);
  supported = true;
  const result = await remove(); assert.equal(result.status, 502); assert.equal((await result.json()).outcome, 'unknown'); assert.equal(deletes, 1);
});

test('HTTPS file controls reject oversized helper replies without replaying the operation', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  const methods = [];
  const helper = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the admitted upload */ }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/files') return res.end(JSON.stringify({ files: [], uploadProtocol: 1, deleteProtocol: 1 }));
    methods.push(req.method);
    if (req.method === 'GET') res.statusCode = 404;
    res.write('{"ok":true,"name":"large-reply.bin","padding":"');
    res.end('x'.repeat(5000) + '"}');
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening');
  t.after(() => new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  const remove = await app.request('/api/files/delete', { method: 'POST', body: { name: 'large-reply.bin', version: 'a'.repeat(64) } });
  const upload = await app.request('/api/files/large-reply.bin', { method: 'PUT', raw: Buffer.from('abc') });
  const download = await app.request('/api/files/large-reply.bin');
  for (const response of [remove, upload, download]) {
    assert.equal(response.status, 502);
    assert.equal((await response.json()).outcome, 'unknown');
  }
  assert.deepEqual(methods, ['DELETE', 'PUT', 'GET']);
});

test('a caller cancellation budget cannot extend the local helper deadline before deletion', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  let deletes = 0;
  const helper = http.createServer((req, res) => {
    if (req.method === 'DELETE') deletes++;
    // Keep the response active so only a total deadline can end the wait.
    res.writeHead(200, { 'content-type': 'application/json' }); res.write(' ');
    const interval = setInterval(() => res.write(' '), 100);
    res.once('close', () => clearInterval(interval));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening');
  t.after(() => new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  const start = performance.now();
  const response = await app.request('/api/files/delete', { method: 'POST', body: { name: 'keep', version: 'a'.repeat(64) } });
  assert.equal(response.status, 502); assert.equal(deletes, 0);
  assert(performance.now() - start < 7500, 'the delete caller\'s 8 second budget replaced the helper\'s 6 second deadline');
});

for (const operation of ['delete', 'upload']) for (const phase of ['preflight', 'committed']) test(`${operation} expiry during ${phase} preserves its dispatched outcome without replay`, async t => {
  // Hold the periodic sweep to isolate the expiry window checked immediately
  // after a helper reply. A sweep may instead close the HTTP response entirely.
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = Date.now(), calls = 0, present = operation === 'delete'; t.mock.method(Date, 'now', () => now);
  const app = await fixture({ mode: 'terminal', sessionMs: 60000 }); t.after(() => app.close());
  const helper = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/files') {
      if (phase === 'preflight') now += 120000;
      return res.end(JSON.stringify({ files: [], deleteProtocol: 1, uploadProtocol: 1, quotaProtocol: 1 }));
    }
    calls++; present = req.method === 'PUT';
    if (req.method === 'PUT') assert.equal(Buffer.concat(chunks).toString(), 'abc');
    now += 120000;
    res.end(JSON.stringify({ ok: true, name: 'expiry.bin', ...(req.method === 'PUT' ? { size: 3 } : {}) }));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening');
  t.after(() => new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  await app.login();
  const response = operation === 'delete'
    ? await app.request('/api/files/delete', { method: 'POST', body: { name: 'expiry.bin', version: 'a'.repeat(64) } })
    : await app.request('/api/files/expiry.bin', { method: 'PUT', raw: Buffer.from('abc') });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).outcome, phase === 'committed' ? 'unknown' : 'rejected');
  assert.equal(calls, phase === 'committed' ? 1 : 0);
  assert.equal(present, phase === 'committed' ? operation === 'upload' : operation === 'delete');
});
