import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfhostCenter } from '../selfhost/center.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-center-')), port = await freePort(), origin = `http://127.0.0.1:${port}`, closed = [];
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpServerPort: 7000, frpTlsServerName: 'desk.example.test', closeTunnel: async (slug, reason) => closed.push({ slug, reason }) });
  center.server.listen(port, '127.0.0.1'); await once(center.server, 'listening');
  t.after(async () => { await center.close(); await rm(directory, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = (path, { method = 'GET', body, headers = {}, authenticated = true } = {}) => fetch(origin + path, {
    method,
    headers: { origin, ...(authenticated && cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { 'x-csrf-token': csrf, 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'center_password_very_long_123' }, authenticated: false });
    cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf; return response;
  };
  return { center, directory, origin, port, closed, request, login, get cookie() { return cookie; }, get csrf() { return csrf; } };
}

test('central login, Host, Origin, CSRF and private state protect key management', async t => {
  const h = await setup(t);
  const page = await h.request('/', { authenticated: false }); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /节点中继管理/);
  assert.equal((await h.request('/api/keys', { authenticated: false })).status, 401);
  assert.equal((await h.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong_password_123' }, authenticated: false })).status, 401);
  const login = await h.login(); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /coc_session_center=.*Path=\//);
  assert.equal((await h.request('/api/keys', { method: 'POST', body: { name: '未验证', slug: 'missing-csrf' }, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await h.request('/api/keys', { method: 'POST', body: { name: '错误来源', slug: 'wrong-origin' }, headers: { origin: 'https://evil.example.test' } })).status, 403);

  const created = await h.request('/api/keys', { method: 'POST', body: { name: '深圳测试机', slug: 'shenzhen-test', expiresAt: null } });
  assert.equal(created.status, 201);
  const secret = await created.json();
  assert.match(secret.key, /^coc_[A-Za-z0-9_-]{43}$/);
  const list = await (await h.request('/api/keys')).json();
  assert.equal(list.keys.length, 1); assert.equal(list.keys[0].path, '/node/shenzhen-test/'); assert(!('key' in list.keys[0]) && !('keyHash' in list.keys[0]));
  const disk = await readFile(join(h.directory, 'center', 'state.json'), 'utf8'); assert(!disk.includes(secret.key));
});

test('join, frp plugin authorization, disconnect and revoke form one bounded node lifecycle', async t => {
  const h = await setup(t); await h.login();
  const created = await (await h.request('/api/keys', { method: 'POST', body: { name: '现场节点 A', slug: 'node-a', expiresAt: null } })).json();
  const joinedResponse = await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', key: created.key, node: { id: 'a'.repeat(32), mode: 'terminal' } } });
  assert.equal(joinedResponse.status, 200);
  const joined = await joinedResponse.json();
  assert.equal(joined.entryBasePath, '/node/node-a/'); assert.equal(joined.origin, h.origin);
  assert.deepEqual(joined.frp, { serverAddr: 'desk.example.test', serverPort: 7000, tlsServerName: 'desk.example.test' });
  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 409);

  const metas = { credential: joined.credential, slug: 'node-a', nodeId: 'a'.repeat(32), mode: 'terminal' };
  const plugin = body => h.request('/internal/frp-plugin?version=0.1.0&op=' + body.op, { method: 'POST', authenticated: false, body: { version: '0.1.0', op: body.op, content: body.content } });
  assert.deepEqual(await (await plugin({ op: 'Login', content: { metas, run_id: 'run-a', client_address: '127.0.0.1' } })).json(), { reject: false, unchange: true });
  assert.deepEqual(await (await plugin({ op: 'NewProxy', content: { user: { metas, run_id: 'run-a' }, proxy_name: 'node-node-a', proxy_type: 'http', custom_domains: ['desk.example.test'], locations: ['/node/node-a/'] } })).json(), { reject: false, unchange: true });
  assert.equal((await (await h.request('/api/status')).json()).onlineNodes, 1);
  assert.equal((await h.request('/api/nodes/node-a/disconnect', { method: 'POST', body: {} })).status, 200);
  assert.deepEqual(h.closed, [{ slug: 'node-a', reason: 'disconnected_by_admin' }]);
  assert.equal((await (await h.request('/api/keys')).json()).keys[0].status, 'offline');

  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 200);
  assert.equal((await h.request('/api/keys/' + created.id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await h.request('/api/join', { method: 'POST', authenticated: false, body: { version: 1, slug: 'node-a', credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } } })).status, 401);
  assert.equal((await (await h.request('/api/keys')).json()).keys[0].status, 'revoked');
});

test('the frp plugin endpoint cannot be reached through a non-loopback socket contract', async t => {
  const h = await setup(t);
  const response = await h.request('/internal/frp-plugin?version=0.1.0&op=Login', { method: 'POST', authenticated: false, headers: { 'x-forwarded-for': '203.0.113.8' }, body: { content: {} } });
  assert.equal(response.status, 200); // Socket-origin is loopback; forwarding headers carry no trust.
  assert.equal((await response.json()).reject, true);
});
