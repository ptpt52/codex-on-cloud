import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portalFixture } from './portal-fixture.mjs';
import { fixture } from './fixture.mjs';
import { encodePortalCode } from '../panel/public/node-directory.js';
import { createPortalConnection, readPortalConnection } from '../panel/portal-connection.mjs';
import { createNodeDirectoryReader } from '../panel/node-directory.mjs';
const node = (id = 'home') => ({ id, name: id, origin: `https://${id}-codex.example.com`, mode: 'desktop', enabled: true });

test('takeover aborts pending registration and prevents a late reply committing local configuration', async t => {
  for (const remoteCommitted of [false, true]) {
    const portal = await portalFixture(), app = await fixture(); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    try {
      await portal.login(); const code = await portal.code(); await app.login(); await app.claim();
      app.config.portalFetch = async (url, init) => { const response = remoteCommitted ? await portal.fetch(url, init) : null; entered(); await gate; init.signal.throwIfAborted(); return response || portal.fetch(url, init); };
      const pending = app.request('/api/portal/register', { method: 'POST', body: { name: 'stale viewer', authorizationCode: code.code } }); await started;
      const viewer = '22222222-2222-4222-8222-222222222222'; await app.claim(viewer); release();
      const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).outcome, 'unknown');
      await assert.rejects(readFile(join(app.config.dataDir, 'portal.json')), { code: 'ENOENT' }); assert.equal(portal.storage.value.directory.nodes.length, remoteCommitted ? 1 : 0);
      app.config.portalFetch = portal.fetch;
      const retried = await app.request('/api/portal/register', { method: 'POST', body: { name: 'current viewer', authorizationCode: code.code }, headers: { 'x-viewer-id': viewer } });
      assert.equal(retried.status, 200); assert.equal(portal.storage.value.directory.nodes.length, 1, 'manual retry reuses the staged identity');
    } finally { release(); await app.close(); await portal.close(); }
  }
});

test('node registration preserves its identity on a lost reply and keeps working when the portal is unavailable', async t => {
  const portal = await portalFixture(); t.after(portal.close); await portal.login(); const code = await portal.code();
  const directory = await mkdtemp(join(tmpdir(), 'codex-node-portal-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let loseReply = true;
  const config = { dataDir: directory, origin: node().origin, mode: 'terminal', portalFetch: async (url, init) => { const response = await portal.fetch(url, init); if (loseReply && url.endsWith('/api/register')) { loseReply = false; throw Error('test lost reply'); } return response; } };
  const connection = createPortalConnection(config);
  await assert.rejects(connection.register({ name: 'home', authorizationCode: code.code }), /结果未知/);
  const saved = await connection.register({ name: 'home', authorizationCode: code.code }); assert.equal(saved.configured, true); assert.equal(saved.enabled, true);
  assert.equal(portal.storage.value.directory.nodes.length, 1);
  const data = await readPortalConnection(config); assert.equal((await lstat(join(directory, 'portal.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(saved), /nodeSecret|authorizationCode|directoryToken/);
  const reader = createNodeDirectoryReader(config); assert.equal((await reader()).nodes[0].mode, 'terminal');
  config.portalFetch = async () => { throw Error('offline'); }; await assert.rejects(reader(), /独立使用/);
  const before = await readFile(join(directory, 'portal.json'), 'utf8');
  await assert.rejects(connection.register({ name: 'new', authorizationCode: encodePortalCode('https://other.example.com', '1'.repeat(64)) }), /独立使用/);
  assert.equal(await readFile(join(directory, 'portal.json'), 'utf8'), before); assert.equal(data.nodeId, saved.nodeId);
});

test('node APIs require local administrator control and do not depend on portal availability for core functions', async t => {
  const portal = await portalFixture(); t.after(portal.close); await portal.login(); const code = await portal.code();
  const app = await fixture(); t.after(() => app.close()); app.config.portalFetch = portal.fetch;
  assert.equal((await app.request('/api/nodes')).status, 401); await app.login();
  assert.deepEqual(await (await app.request('/api/nodes')).json(), { enabled: false });
  assert.equal((await app.request('/api/portal/register', { method: 'POST', body: { name: 'test', authorizationCode: code.code } })).status, 409);
  await app.claim(); assert.equal((await app.request('/api/portal/register', { method: 'POST', body: { name: 'test', authorizationCode: code.code }, headers: { 'x-csrf-token': 'bad' } })).status, 403);
  assert.equal((await app.request('/api/portal/register', { method: 'POST', body: { name: 'test', authorizationCode: code.code } })).status, 200);
  assert.equal((await app.request('/api/nodes')).status, 200);
  app.config.portalFetch = async () => { throw Error('portal offline'); };
  assert.equal((await app.request('/api/nodes')).status, 503); assert.equal((await app.request('/api/me')).status, 200);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 200);
  assert.equal((await app.request('/api/files')).status, 200); assert.equal(app.managementStats.restarts, 0);
});


test('invalid shared codes preserve node login and active registration; guests and locked viewers cannot configure enrollment', async t => {
  const portal = await portalFixture(); t.after(portal.close); await portal.login();
  const app = await fixture(); t.after(() => app.close()); app.config.portalFetch = portal.fetch; await app.login(); await app.claim();
  const invalid = encodePortalCode(portal.origin, 'f'.repeat(64));
  assert.equal((await app.request('/api/portal/register', { method: 'POST', body: { name: 'test', authorizationCode: invalid } })).status, 400);
  assert.equal((await app.request('/api/me')).status, 200);
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'test-visitor-password', durationMs: 3600000 } })).status, 200);
  const guest = await fetch(app.config.origin + '/api/login', { method: 'POST', headers: { origin: app.config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'visitor', password: 'test-visitor-password' }) });
  const guestCookie = guest.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('/api/nodes', { headers: { cookie: guestCookie } })).status, 403);
  assert.equal((await app.request('/api/portal', { headers: { cookie: guestCookie } })).status, 403);
  assert.equal((await app.request('/api/security/screen-lock', { method: 'POST', body: { enabled: true, password: 'test-screen-password' } })).status, 200);
  assert.equal((await app.request('/api/portal')).status, 423);
  assert.equal((await app.request('/api/portal/register', { method: 'POST', body: { name: 'test', authorizationCode: invalid } })).status, 423);
  assert.deepEqual(app.inputCalls, []);
});
