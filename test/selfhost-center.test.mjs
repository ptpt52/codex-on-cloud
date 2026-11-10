import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfhostCenter } from '../selfhost/center.mjs';
import { createAuth } from '../panel/auth.mjs';
import { createHmac } from 'node:crypto';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function setup(t, { turnSecret, legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-center-')), port = await freePort(), origin = `http://127.0.0.1:${port}`, closed = [];
  let legacyToken;
  if (legacy) {
    const auth = await createAuth({ dataDir: join(directory, 'center'), username: 'admin', password: 'center_password_very_long_123', sessionMs: 60000 });
    legacyToken = (await auth.create()).token; await auth.close();
  }
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpServerPort: 7000, frpTlsServerName: 'desk.example.test', frpToken: 'frp_test_token_very_long_123', turnSecret, closeTunnel: async (slug, reason) => closed.push({ slug, reason }) });
  center.server.listen(port, '127.0.0.1'); await once(center.server, 'listening');
  t.after(async () => { await center.close(); await rm(directory, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = (path, { method = 'GET', body, headers = {}, authenticated = true } = {}) => fetch(origin + path, {
    method,
    headers: { origin, ...(authenticated && cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { 'x-csrf-token': csrf, 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const login = async () => {
    const response = await request('/admin/api/login', { method: 'POST', body: { username: 'admin', password: 'center_password_very_long_123' }, authenticated: false });
    cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf; return response;
  };
  return { center, directory, origin, port, closed, request, login, legacyToken, get cookie() { return cookie; }, get csrf() { return csrf; } };
}

test('central login, Host, Origin, CSRF and private state protect key management', async t => {
  const h = await setup(t);
  const page = await h.request('/admin/', { authenticated: false }); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /节点中继管理/);
  assert.equal((await h.request('/admin/api/keys', { authenticated: false })).status, 401);
  assert.equal((await h.request('/admin/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong_password_123' }, authenticated: false })).status, 401);
  const login = await h.login(); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /coc_session_center_admin=.*Path=\/admin\//);
  assert.equal((await h.request('/admin/api/keys', { method: 'POST', body: { name: '未验证', slug: 'missing-csrf' }, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await h.request('/admin/api/keys', { method: 'POST', body: { name: '错误来源', slug: 'wrong-origin' }, headers: { origin: 'https://evil.example.test' } })).status, 403);

  const created = await h.request('/admin/api/keys', { method: 'POST', body: { name: '深圳测试机', slug: 'shenzhen-test', expiresAt: null } });
  assert.equal(created.status, 201);
  const secret = await created.json();
  assert.match(secret.key, /^coc_[A-Za-z0-9_-]{43}$/);
  const list = await (await h.request('/admin/api/keys')).json();
  assert.equal(list.keys.length, 1); assert.equal(list.keys[0].path, '/node/shenzhen-test/'); assert(!('key' in list.keys[0]) && !('keyHash' in list.keys[0]));
  const disk = await readFile(join(h.directory, 'center', 'state.json'), 'utf8'); assert(!disk.includes(secret.key));
});

test('login limits follow the forwarded client address and do not lock out another client', async t => {
  const h = await setup(t);
  for (let index = 0; index < 9; index++) assert.equal((await h.request('/admin/api/login', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '198.51.100.8' }, body: { username: 'admin', password: 'wrong_password_123' } })).status, index < 8 ? 401 : 429);
  const allowed = await h.request('/admin/api/login', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '198.51.100.9' }, body: { username: 'admin', password: 'center_password_very_long_123' } });
  assert.equal(allowed.status, 200);
});

test('join and TURN rate buckets are independent and record the forwarded source', async t => {
  const h = await setup(t, { turnSecret: 'turn_shared_secret_very_long_123' });
  for (let index = 0; index < 121; index++) await h.request('/api/turn-credentials', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '198.51.100.20' }, body: { slug: 'none', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'z'.repeat(43) } });
  await h.login();
  const key = await (await h.request('/admin/api/keys', { method: 'POST', body: { name: 'Rate node', slug: 'rate-node', expiresAt: null } })).json();
  const joined = await h.request('/api/join', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '198.51.100.20' }, body: { version: 1, slug: 'rate-node', key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } } });
  assert.equal(joined.status, 200);
  assert.equal((await (await h.request('/admin/api/keys')).json()).keys[0].session.source, '198.51.100.20');
});

test('join, frp plugin authorization, disconnect and revoke form one bounded node lifecycle', async t => {
  const h = await setup(t); await h.login();
  const created = await (await h.request('/admin/api/keys', { method: 'POST', body: { name: '现场节点 A', slug: 'node-a', expiresAt: null } })).json();
  const joinedResponse = await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', key: created.key, node: { id: 'a'.repeat(32), mode: 'terminal' } } });
  assert.equal(joinedResponse.status, 200);
  const joined = await joinedResponse.json();
  assert.equal(joined.entryBasePath, '/node/node-a/'); assert.equal(joined.origin, h.origin);
  assert.deepEqual(joined.frp, { serverAddr: 'desk.example.test', serverPort: 7000, tlsServerName: 'desk.example.test', token: 'frp_test_token_very_long_123' });
  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 409);

  const metas = { credential: joined.credential, slug: 'node-a', nodeId: 'a'.repeat(32), mode: 'terminal' };
  const plugin = body => h.request('/internal/frp-plugin?version=0.1.0&op=' + body.op, { method: 'POST', authenticated: false, body: { version: '0.1.0', op: body.op, content: body.content } });
  assert.deepEqual(await (await plugin({ op: 'Login', content: { metas, run_id: 'run-a', client_address: '127.0.0.1' } })).json(), { reject: false, unchange: true });
  assert.deepEqual(await (await plugin({ op: 'NewProxy', content: { user: { metas, run_id: 'run-a' }, proxy_name: 'node-node-a', proxy_type: 'http', custom_domains: ['desk.example.test'], locations: ['/node/node-a/'] } })).json(), { reject: false, unchange: true });
  assert.equal((await (await h.request('/admin/api/status')).json()).onlineNodes, 1);
  assert.equal((await h.request('/internal/route-auth?path=%2Fnode%2Fnode-a%2Fapi%2Fme', { authenticated: false })).status, 204);
  assert.equal((await h.request('/internal/route-auth?path=%2Fnode%2Fnode-b%2F', { authenticated: false })).status, 503);
  assert.equal((await h.request('/admin/api/nodes/node-a/disconnect', { method: 'POST', body: {} })).status, 200);
  assert.deepEqual(h.closed, [{ slug: 'node-a', reason: 'disconnected_by_admin' }]);
  assert.equal((await (await h.request('/admin/api/keys')).json()).keys[0].status, 'offline');

  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 200);
  assert.equal((await h.request('/api/leave', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, nodeId: 'a'.repeat(32) } })).status, 200);
  assert.equal(h.closed.at(-1).reason, 'node_left');
  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 200);
  assert.equal((await h.request('/admin/api/keys/' + created.id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 401);
  assert.equal((await (await h.request('/admin/api/keys')).json()).keys[0].status, 'revoked');
});

test('the frp plugin endpoint cannot be reached through a non-loopback socket contract', async t => {
  const h = await setup(t);
  const response = await h.request('/internal/frp-plugin?version=0.1.0&op=Login', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '203.0.113.8' }, body: { content: {} } });
  assert.equal(response.status, 200); // Socket-origin is loopback; forwarding headers carry no trust.
  assert.equal((await response.json()).reject, true);
});

test('frps may call the plugin with the loopback listener Host under a production domain origin', async t => {
  const h = await setup(t);
  const response = await fetch(`http://127.0.0.1:${h.port}/internal/frp-plugin?version=0.1.0&op=Login`, { method: 'POST', headers: { host: `127.0.0.1:${h.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: '0.1.0', op: 'Login', content: { metas: {} } }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).reject, true);
});

test('TURN credentials are short-lived, session-bound and signed with the coturn shared secret', async t => {
  const h = await setup(t, { turnSecret: 'turn_shared_secret_very_long_123' }); await h.login();
  const created = await (await h.request('/admin/api/keys', { method: 'POST', body: { name: 'TURN 节点', slug: 'turn-a', expiresAt: null } })).json();
  const joined = await (await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'turn-a', key: created.key, node: { id: 'a'.repeat(32), mode: 'desktop' } } })).json();
  assert.equal(joined.turnEndpoint, h.origin + '/api/turn-credentials');
  const metas = { credential: joined.credential, slug: 'turn-a', nodeId: 'a'.repeat(32), mode: 'desktop' };
  const plugin = body => h.request('/internal/frp-plugin?version=0.1.0&op=' + body.op, { method: 'POST', authenticated: false, body: { version: '0.1.0', op: body.op, content: body.content } });
  await plugin({ op: 'Login', content: { metas, run_id: '', client_address: '127.0.0.1' } });
  await plugin({ op: 'NewProxy', content: { user: { metas, run_id: 'run-turn' }, proxy_name: 'node-turn-a', proxy_type: 'http', custom_domains: ['desk.example.test'], locations: ['/node/turn-a/'] } });
  const response = await h.request('/api/turn-credentials', { method: 'POST', authenticated: false, body: { slug: 'turn-a', nodeId: 'a'.repeat(32), credential: joined.credential } });
  assert.equal(response.status, 200);
  const turn = await response.json();
  assert(turn.ttlMs <= 3600000 && turn.expiresAt > Date.now());
  assert.match(turn.iceServers[1].urls[0], /^turn:desk\.example\.test:3478\?transport=udp$/);
  assert.match(turn.iceServers[1].urls[2], /^turns:desk\.example\.test:5349\?transport=tcp$/);
  assert.equal(turn.iceServers[1].credential, createHmac('sha1', 'turn_shared_secret_very_long_123').update(turn.iceServers[1].username).digest('base64'));
  assert.equal((await h.request('/api/turn-credentials', { method: 'POST', authenticated: false, body: { slug: 'turn-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'z'.repeat(43) } })).status, 401);
  assert.equal((await (await h.request('/admin/api/status')).json()).turn, true);
});


test('admin migration revokes root sessions and removes legacy root management APIs', async t => {
  const h = await setup(t, { legacy: true });
  assert.equal((await h.request('/admin/api/me', { headers: { cookie: 'coc_session_center_admin=' + h.legacyToken } })).status, 401);
  for (const path of ['/api/login', '/api/me', '/api/keys']) assert.equal((await h.request(path)).status, 404);
  assert.equal((await h.request('/')).headers.get('location'), '/admin/');
  const page = await h.request('/admin/'); assert.match(page.headers.get('set-cookie'), /coc_session_center=; Path=\/;.*Max-Age=0/);
});
