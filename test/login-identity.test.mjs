import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalLoginUsername, createLoginIdentity, nodeLoginScope, renderLoginForm } from '../panel/login-identity.mjs';
import { createUIAssets } from '../panel/ui-assets.mjs';
import { fixture } from './fixture.mjs';

test('login labels follow fixed paths or shared node IDs and decode only the current entry suffix', () => {
  const scope = nodeLoginScope({ entryBasePath: '/node/a/', nodeId: 'a'.repeat(32) });
  assert.equal(scope, nodeLoginScope({ entryBasePath: '/node/a/', nodeId: 'b'.repeat(32) }));
  const identity = createLoginIdentity('admin', scope);
  assert.equal(identity.value, 'admin@node-a');
  assert.equal(canonicalLoginUsername(identity.value, identity), 'admin');
  assert.equal(canonicalLoginUsername('admin', identity), 'admin');
  assert.notEqual(canonicalLoginUsername('admin@node-b', identity), 'admin');
  assert.notEqual(canonicalLoginUsername('admin@center', identity), 'admin');
  assert.equal(canonicalLoginUsername('visitor@node-a', identity), 'visitor');
  const literal = createLoginIdentity('operator@center', 'center');
  assert.equal(canonicalLoginUsername(literal.username, literal), literal.username);
  assert.equal(canonicalLoginUsername(literal.value, literal), literal.username);
  const long = createLoginIdentity('u'.repeat(100), nodeLoginScope({ entryBasePath: '/node/' + 'a'.repeat(48) + '/' }));
  assert.equal(canonicalLoginUsername(long.value, long), long.username);
  for (const value of [null, undefined, {}, [], 'x'.repeat(161)]) assert.equal(canonicalLoginUsername(value, identity), null);
  assert.equal(nodeLoginScope(), '');
  assert.equal(nodeLoginScope({ sharedEntry: true, nodeId: 'a'.repeat(32) }), 'nodeid-' + 'a'.repeat(32));
  assert.throws(() => nodeLoginScope({ sharedEntry: true }), /固定节点身份/);
  assert.throws(() => nodeLoginScope({ entryBasePath: '/node/a/../b/' }), /路径/);
});

test('rendered credentials are escaped, scoped and versioned without altering other forms or legacy source defaults', async () => {
  const source = await readFile(new URL('../panel/public/index.html', import.meta.url), 'utf8');
  assert.match(source, /id="username"[^>]+value="admin"/);
  const identity = createLoginIdentity('operator"<&\'__LOGIN_ACTION__', 'node-a');
  const rendered = renderLoginForm(source, identity, '/node/a/api/login');
  assert(rendered.includes('operator&quot;&lt;&amp;&#39;__LOGIN_ACTION__@node-a'));
  assert.match(rendered, /action="\/node\/a\/api\/login"/);
  assert.match(rendered, /autocomplete="section-coc-node-a username"/);
  assert.match(rendered, /autocomplete="section-coc-node-a current-password"/);
  assert.match(rendered, /id="temporary-password"[^>]*autocomplete="new-password"/);
  const first = await createUIAssets({ validate: false, login: createLoginIdentity('admin', 'node-a') });
  const second = await createUIAssets({ validate: false, login: createLoginIdentity('admin', 'node-b') });
  assert.notEqual(first.revision, second.revision);
  assert.match(first.get('/').bytes.toString(), /value="admin@node-a"/);
});

test('nodes authenticate scoped and legacy admin names but reject another entry name even with the right password', async t => {
  const a = await fixture({ entryBasePath: '/node/a/', nodeId: 'a'.repeat(32) }); t.after(() => a.close());
  const b = await fixture({ entryBasePath: '/node/b/', nodeId: 'b'.repeat(32), password: 'different_node_password_123' }); t.after(() => b.close());
  for (const [app, own, foreign] of [[a, 'admin@node-a', 'admin@node-b'], [b, 'admin@node-b', 'admin@node-a']]) {
    const send = (username, password = app.config.password, headers) => app.request('/api/login', { method: 'POST', body: { username, password }, headers });
    assert.equal((await send(foreign)).status, 401);
    assert.equal((await send('admin@center')).status, 401);
    assert.equal((await send(own, 'wrong_password_123')).status, 401);
    assert.equal((await send(own, app.config.password, { origin: 'https://evil.example.test' })).status, 403);
    const logged = await send(own); assert.equal(logged.status, 200); assert.equal((await logged.json()).username, 'admin');
    assert.equal((await send('admin')).status, 200);
    assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
  }
});

test('scoped temporary logins preserve their canonical identity and restricted permissions', async t => {
  const app = await fixture({ entryBasePath: '/node/a/', nodeId: 'a'.repeat(32) }); t.after(() => app.close());
  await app.login(); await app.claim();
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'test-guest-password', durationMs: 300000 } })).status, 200);
  const login = username => app.request('/api/login', { method: 'POST', body: { username, password: 'test-guest-password' } });
  assert.equal((await login('visitor@node-b')).status, 401);
  const response = await login('visitor@node-a'); assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.username, 'visitor'); assert.equal(value.access.role, 'temporary');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const denied = await app.request('/api/security/screen-lock', { method: 'POST', headers: { cookie, 'x-csrf-token': value.csrf }, body: { enabled: true, password: 'never-change' } });
  assert.equal(denied.status, 403);
  assert.equal((await login('visitor')).status, 200);
});

test('standalone custom usernames remain unscoped while shared root nodes get stable identities', async t => {
  const standalone = await fixture({ username: 'operator' }); t.after(() => standalone.close());
  assert.match(await (await standalone.request('/')).text(), /value="operator"/);
  await standalone.login();
  const nodeId = 'c'.repeat(32), shared = await fixture({ nodeId, sharedEntry: true }); t.after(() => shared.close());
  const username = 'admin@nodeid-' + nodeId;
  assert.match(await (await shared.request('/')).text(), new RegExp('value="' + username + '"'));
  assert.equal((await shared.request('/api/login', { method: 'POST', body: { username, password: shared.config.password } })).status, 200);
});
