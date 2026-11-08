import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { uploadOptions, uploadHeaders, readUploadHeaders, uploadResult } from '../panel/public/file-upload.js';
import { settings } from '../native/config.mjs';

test('independent file helper port defaults to the desktop helper and rejects invalid ports', () => {
  assert.equal(settings({ AGENT_PORT: '31001' }).fileAgentPort, 31001);
  assert.equal(settings({ FILE_AGENT_PORT: '31002' }).fileAgentPort, 31002);
  for (const value of ['-1', '22', '65536', '1.5', 'url']) assert.throws(() => settings({ FILE_AGENT_PORT: value }), /FILE_AGENT_PORT/);
});

test('an independent file helper serves every file route while desktop health retains its original helper', async t => {
  const app = await fixture(); t.after(() => app.close()); const files = await fixture(); t.after(() => files.close());
  await app.login(); app.config.fileAgentUrl = files.config.agentUrl;
  const result = await app.request('/api/files/independent.txt', { method: 'PUT', raw: 'independent files' });
  assert.equal(result.status, 200); assert.equal(files.files.get('independent.txt').toString(), 'independent files'); assert.equal(app.files.size, 0);
  assert.equal((await (await app.request('/api/files')).json()).files[0].name, 'independent.txt');
  assert.equal(await (await app.request('/api/files/independent.txt')).text(), 'independent files');
  assert.equal((await (await app.request('/api/state')).json()).desktop.ready, true);
  assert.equal(app.received.some(r => r.url === '/health'), true); assert.equal(files.received.some(r => r.url === '/health'), false);
  await files.close(); app.files.set('must-not-read', Buffer.from('old helper'));
  assert.equal((await app.request('/api/files')).status, 502); assert.equal(app.received.some(r => r.url === '/files'), false, 'unavailable file helper cannot fall back to the old helper');
});

test('upload conditions default to create and require an exact version for replacement', () => {
  const version = 'a'.repeat(64);
  for (const policy of [{ mode: 'create' }, { mode: 'rename' }, { mode: 'replace', version }]) {
    assert.deepEqual(readUploadHeaders(uploadHeaders(policy)), policy);
  }
  assert.deepEqual(readUploadHeaders({}), { mode: 'create' });
  for (const value of [null, {}, { mode: 'replace' }, { mode: 'replace', version: '*' }, { mode: 'create', version }, { mode: 'rename', extra: true }]) assert.throws(() => uploadOptions(value), { status: 400 });
  for (const headers of [{ 'if-match': '"' + version + '"' }, { 'x-codex-upload-mode': 'replace', 'if-match': '*' }, { 'x-codex-upload-mode': 'rename', 'if-none-match': '*' }, { 'if-none-match': 'anything' }, { 'x-codex-upload-mode': 'replace', 'if-match': '"' + version + '"', 'if-none-match': '*' }]) assert.throws(() => readUploadHeaders(headers), { status: 400 });
});

test('upload completion requires a valid actual filename and reports incomplete replies as unknown', () => {
  assert.equal(uploadResult({ ok: true, name: '资料 (2).txt' }).name, '资料 (2).txt');
  for (const value of [null, {}, { ok: true }, { name: 'missing-ok' }, { ok: true, name: '' }, { ok: true, name: '../outside' }, { ok: true, name: '.upload-private' }, { ok: true, name: '资'.repeat(81) }]) assert.throws(() => uploadResult(value), { status: 502, outcome: 'unknown' });
});

test('HTTP uploads preserve same-name content, enforce versions, rename and retain write authentication', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  app.files.set('keep.txt', Buffer.from('original'));
  const version = (await (await app.request('/api/files')).json()).files[0].version;
  const put = (mode, bytes, extra = {}) => app.request('/api/files/keep.txt', { method: 'PUT', raw: bytes, headers: { ...uploadHeaders(mode), ...extra } });
  assert.equal((await put({ mode: 'create' }, 'unconfirmed')).status, 409);
  assert.equal(app.files.get('keep.txt').toString(), 'original');
  assert.equal(app.received.filter(r => r.method === 'PUT').length, 0);
  assert.equal((await put({ mode: 'replace', version }, 'blocked', { 'x-csrf-token': '' })).status, 403);
  assert.equal((await put({ mode: 'replace', version }, 'blocked', { origin: 'https://attacker.example' })).status, 403);
  const renamed = await put({ mode: 'rename' }, 'another'); assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, 'keep (2).txt'); assert.equal(app.files.get('keep (2).txt').toString(), 'another');
  assert.equal(app.files.get('keep.txt').toString(), 'original');
  assert.equal((await put({ mode: 'replace', version }, 'confirmed')).status, 200);
  assert.equal((await put({ mode: 'replace', version }, 'stale')).status, 412);
  assert.equal(app.files.get('keep.txt').toString(), 'confirmed');
  assert.match((await app.request('/api/files/keep.txt')).headers.get('etag'), /^"[a-f0-9]{64}"$/);
});

test('an old helper cannot silently bypass safe uploads', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); let puts = 0;
  const old = http.createServer((req, res) => { if (req.method === 'PUT') puts++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ files: [] })); });
  old.listen(0, '127.0.0.1'); await once(old, 'listening'); t.after(() => new Promise(resolve => old.close(resolve)));
  app.config.agentUrl = 'http://127.0.0.1:' + old.address().port;
  const result = await app.request('/api/files/new', { method: 'PUT', raw: 'must not send' });
  assert.equal(result.status, 503); assert.match((await result.json()).error, /更新/); assert.equal(puts, 0);
});

test('guest rename consumes a new file quota while versioned replacement credits only its original file', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password' } })).status, 200);
  const login = await app.request('/api/login', { method: 'POST', body: { username: 'visitor', password: 'temporary-test-password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
  const put = policy => app.request('/api/files/keep', { method: 'PUT', raw: 'new', headers: { cookie, 'x-csrf-token': csrf, ...uploadHeaders(policy) } });
  app.files.set('keep', Buffer.from('old'));
  for (let index = 1; index < 1000; index++) app.files.set('item' + index, Buffer.alloc(0));
  let version = (await (await app.request('/api/files')).json()).files.find(file => file.name === 'keep').version;
  assert.equal((await put({ mode: 'rename' })).status, 413);
  assert.equal((await put({ mode: 'replace', version })).status, 200); assert.equal(app.files.size, 1000);
  app.files.clear(); app.files.set('keep', { length: 1024 * 1024 * 1024 });
  version = (await (await app.request('/api/files')).json()).files[0].version;
  assert.equal((await put({ mode: 'rename' })).status, 413);
  assert.equal((await put({ mode: 'replace', version })).status, 200); assert.equal(app.files.get('keep').toString(), 'new');
  app.files.clear(); app.files.set('keep', Buffer.from('original'));
  for (let index = 1; index < 1001; index++) app.files.set('item' + index, Buffer.alloc(0));
  const listing = (await (await app.request('/api/files')).json());
  assert.equal(listing.files.length, 1000); assert.equal(listing.truncated, true);
  version = listing.files[0].version;
  assert.equal((await put({ mode: 'replace', version })).status, 413);
  assert.equal(app.files.get('keep').toString(), 'original');
  assert.equal(app.received.filter(req => req.method === 'PUT').every(req => req.headers['x-codex-upload-quota'] === 'temporary-v1'), true);
});
