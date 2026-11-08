import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { uploadOptions, uploadHeaders, readUploadHeaders } from '../panel/public/file-upload.js';

test('upload conditions default to create and require an exact version for replacement', () => {
  const version = 'a'.repeat(64);
  for (const policy of [{ mode: 'create' }, { mode: 'rename' }, { mode: 'replace', version }]) {
    assert.deepEqual(readUploadHeaders(uploadHeaders(policy)), policy);
  }
  assert.deepEqual(readUploadHeaders({}), { mode: 'create' });
  for (const value of [null, {}, { mode: 'replace' }, { mode: 'replace', version: '*' }, { mode: 'create', version }, { mode: 'rename', extra: true }]) assert.throws(() => uploadOptions(value), { status: 400 });
  for (const headers of [{ 'if-match': '"' + version + '"' }, { 'x-codex-upload-mode': 'replace', 'if-match': '*' }, { 'x-codex-upload-mode': 'rename', 'if-none-match': '*' }, { 'if-none-match': 'anything' }, { 'x-codex-upload-mode': 'replace', 'if-match': '"' + version + '"', 'if-none-match': '*' }]) assert.throws(() => readUploadHeaders(headers), { status: 400 });
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
});
