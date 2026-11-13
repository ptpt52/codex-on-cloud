import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture } from './fixture.mjs';

test('HTTP upload progress is live, private to its login session, bounded and removed on completion', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  const id = 'a'.repeat(32), path = '/api/file-progress/' + id;
  assert.equal((await (await app.request('/api/files')).json()).fileProgressProtocol, 1);
  assert.equal((await app.request('/api/file-progress/invalid')).status, 400);
  assert.equal((await app.request('/api/files/invalid.txt', { method: 'PUT', raw: 'x', headers: { 'x-codex-transfer-id': 'invalid' } })).status, 400);
  let upload;
  const completed = new Promise((resolve, reject) => {
    upload = http.request(app.config.origin + '/api/files/progress.txt', { method: 'PUT', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/octet-stream', 'content-length': 8, 'x-codex-transfer-id': id,
    } }, response => { const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) })); });
    upload.on('error', reject);
  });
  void completed.catch(() => {}); t.after(() => upload.destroy()); upload.write('1234');
  let progress;
  for (let i = 0; i < 100; i++) {
    const response = await app.request(path);
    if (response.status === 200) { progress = await response.json(); if (progress.loaded === 4) break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(progress, { loaded: 4, total: 8 }); assert.equal(app.files.has('progress.txt'), false);
  const login = await fetch(app.config.origin + '/api/login', { method: 'POST', headers: { origin: app.config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: app.config.username, password: app.config.password }) });
  assert.equal(login.status, 200); const cookie = login.headers.getSetCookie().find(value => value.startsWith('coc_session')).split(';')[0]; await login.arrayBuffer();
  assert.equal((await fetch(app.config.origin + path, { headers: { cookie } })).status, 404);
  const duplicate = await app.request('/api/files/duplicate.txt', { method: 'PUT', raw: 'x', headers: { 'x-codex-transfer-id': id } });
  assert.equal(duplicate.status, 409); assert.equal(app.files.has('duplicate.txt'), false);
  upload.end('5678'); const result = await completed; assert.equal(result.status, 200); assert.equal(result.body.name, 'progress.txt');
  assert.equal(app.files.get('progress.txt').toString(), '12345678'); assert.equal((await app.request(path)).status, 404);
  assert.deepEqual(app.inputCalls, []);
});
