import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfhostCenter, CENTER_REQUEST_LIMITS, CENTER_CONNECTION_LIMITS } from '../selfhost/center.mjs';
import { JSON_BODY_LIMITS } from '../panel/json-body.mjs';
import { joinNode, leaveNode, nodeDoctor } from '../selfhost/node.mjs';
import { centerRequest } from '../panel/center-http.mjs';
import { createAuth } from '../panel/auth.mjs';
import { createHmac } from 'node:crypto';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function setup(t, { turnSecret, legacy = false, helpPage } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-center-')), port = await freePort(), origin = `http://127.0.0.1:${port}`, closed = [];
  const helpFile = join(directory, 'help.html');
  if (helpPage !== undefined) await writeFile(helpFile, helpPage, { mode: 0o640 });
  let legacyToken;
  if (legacy) {
    const auth = await createAuth({ dataDir: join(directory, 'center'), username: 'admin', password: 'center_password_very_long_123', sessionMs: 60000 });
    legacyToken = (await auth.create()).token; await auth.close();
  }
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpServerPort: 7000, frpTlsServerName: 'desk.example.test', frpToken: 'frp_test_token_very_long_123', turnSecret, helpFile, closeTunnel: async (slug, reason) => closed.push({ slug, reason }) });
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

async function onlineCenter(t) {
  const h = await setup(t), key = await h.center.registry.createKey({ name: 'Reserved capacity', slug: 'capacity' });
  const joined = await h.center.registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  const metas = { slug: key.slug, credential: joined.credential, nodeId: 'a'.repeat(32), mode: 'terminal' };
  const plugin = (op, content, extra = {}) => h.request('/internal/frp-plugin?op=' + op, { method: 'POST', authenticated: false, body: { content, ...extra } });
  assert.equal((await (await plugin('Login', { metas, run_id: 'capacity-run', client_address: '127.0.0.1' })).json()).reject, false);
  assert.equal((await (await plugin('NewProxy', { user: { metas, run_id: 'capacity-run' }, proxy_name: 'node-capacity', proxy_type: 'http', custom_domains: ['desk.example.test'], locations: ['/node/capacity/'] })).json()).reject, false);
  return { ...h, ping: extra => plugin('Ping', { user: { metas, run_id: 'capacity-run' } }, extra), route: () => h.request('/internal/route-auth?path=/node/capacity/', { authenticated: false }) };
}

function incompleteCenterBody(h, path) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(h.origin + path, { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/json', 'content-length': 100 } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, value: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.once('error', reject); request.write('{');
  });
  void response.catch(() => {});
  return { request, response };
}

function rawCenterRequest(t, h, path, { method = 'GET', headers = {}, body = '' } = {}) {
  const socket = net.createConnection({ host: '127.0.0.1', port: h.port });
  const closed = new Promise(resolve => socket.once('close', resolve));
  t.after(() => socket.destroy());
  const response = new Promise((resolve, reject) => {
    let data = '';
    socket.once('error', reject);
    socket.once('close', () => reject(Error('connection closed before response headers')));
    socket.setTimeout(3000, () => socket.destroy(Error('response deadline')));
    const receive = chunk => {
      data += chunk.toString();
      const end = data.indexOf('\r\n\r\n'); if (end < 0) return;
      socket.off('data', receive); socket.setTimeout(0);
      const lines = data.slice(0, end).split('\r\n');
      resolve({ status: Number(lines[0].split(' ')[1]), headers: Object.fromEntries(lines.slice(1).map(line => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; })) });
    };
    socket.on('data', receive);
    socket.once('connect', () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: keep-alive\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${body}`));
  });
  return { socket, closed, response };
}

test('center rejects framed GET/HEAD bodies before static, redirect, public or internal dispatch', { timeout: 10000 }, async t => {
  const h = await setup(t); let routes = 0;
  h.center.registry.routeAllowed = async () => { routes++; return true; };
  for (const path of ['/healthz', '/api/public/nodes', '/', '/admin', '/internal/route-auth?path=/node/capacity/']) {
    for (const method of ['GET', 'HEAD']) {
      for (const framing of [{ 'Content-Length': 1048576 }, { 'Transfer-Encoding': 'chunked' }]) {
        const item = rawCenterRequest(t, h, path, { method, headers: framing, body: framing['Transfer-Encoding'] ? '1\r\nx\r\n' : 'x' });
        const response = await item.response;
        assert.equal(response.status, 400); assert.equal(response.headers.connection, 'close'); await item.closed;
      }
    }
  }
  assert.equal(routes, 0);
  assert.equal((await h.request('/healthz', { headers: { 'content-length': '0' } })).status, 200);
});

test('successful center logout flushes its result and closes an ignored incomplete request body', { timeout: 5000 }, async t => {
  const h = await setup(t); await h.login();
  let request, closed;
  const response = await new Promise((resolve, reject) => {
    request = http.request(h.origin + '/admin/api/logout', { method: 'POST', headers: { origin: h.origin, cookie: h.cookie, 'x-csrf-token': h.csrf, 'content-length': 1048576 } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, value: JSON.parse(Buffer.concat(chunks)) }));
    });
    t.after(() => request.destroy()); request.once('error', reject);
    closed = new Promise(resolveClose => request.once('socket', socket => socket.once('close', resolveClose)));
    request.write('x');
  });
  assert.deepEqual(response, { status: 200, connection: 'close', value: { ok: true } }); await closed;
  assert.equal((await h.request('/admin/api/me')).status, 401);
});

test('public keep-alive connection saturation preserves internal node heartbeat and route capacity', { timeout: 15000 }, async t => {
  const h = await onlineCenter(t); h.center.server.keepAliveTimeout = 15000;
  h.center.server.closeIdleConnections(); await new Promise(resolve => setImmediate(resolve));
  const held = [];
  for (let index = 0; index < CENTER_CONNECTION_LIMITS.public; index++) {
    const item = rawCenterRequest(t, h, '/healthz'); held.push(item);
    assert.equal((await item.response).status, 200);
  }
  const overflow = rawCenterRequest(t, h, '/healthz'), rejected = await overflow.response;
  assert.equal(rejected.status, 503); assert.equal(rejected.headers.connection, 'close'); await overflow.closed;
  assert.equal((await h.route()).status, 204);
  assert.equal((await (await h.ping()).json()).reject, false);
  held[0].socket.destroy(); await held[0].closed; await new Promise(resolve => setImmediate(resolve));
  const recovered = rawCenterRequest(t, h, '/healthz'); assert.equal((await recovered.response).status, 200);
});

test('internal keep-alive connection capacity is bounded independently of public requests', { timeout: 10000 }, async t => {
  const h = await onlineCenter(t); h.center.server.keepAliveTimeout = 15000;
  h.center.server.closeIdleConnections(); await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < CENTER_CONNECTION_LIMITS.internal; index++) {
    const item = rawCenterRequest(t, h, '/internal/route-auth?path=/node/capacity/');
    assert.equal((await item.response).status, 204);
  }
  const overflow = rawCenterRequest(t, h, '/internal/route-auth?path=/node/capacity/'), rejected = await overflow.response;
  assert.equal(rejected.status, 503); assert.equal(rejected.headers.connection, 'close'); await overflow.closed;
  assert.equal((await h.request('/healthz')).status, 200);
});

test('center reclassifies reused proxy connections and releases their last class on close', { timeout: 15000 }, async t => {
  const h = await onlineCenter(t), agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy()); h.center.server.keepAliveTimeout = 15000;
  h.center.server.closeIdleConnections(); await new Promise(resolve => setImmediate(resolve));
  const request = path => new Promise((resolve, reject) => {
    const req = http.get(h.origin + path, { agent }, res => { const socket = res.socket; res.resume(); res.once('end', () => resolve({ status: res.statusCode, socket })); res.once('error', reject); });
    req.once('error', reject);
  });
  const first = await request('/healthz'); assert.equal(first.status, 200);
  for (let index = 1; index < CENTER_CONNECTION_LIMITS.public; index++) assert.equal((await rawCenterRequest(t, h, '/healthz').response).status, 200);
  const internal = await request('/internal/route-auth?path=/node/capacity/');
  assert.equal(internal.status, 204); assert.equal(internal.socket, first.socket);
  assert.equal((await rawCenterRequest(t, h, '/healthz').response).status, 200);
  assert.equal((await request('/healthz')).status, 503);
  // Rejection must release the previous internal classification as well.
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < CENTER_CONNECTION_LIMITS.internal; index++) assert.equal((await rawCenterRequest(t, h, '/internal/route-auth?path=/node/capacity/').response).status, 204);
});

test('public JSON saturation preserves separate plugin bodies and internal route authorization', { timeout: 5000 }, async t => {
  const h = await onlineCenter(t), pending = [];
  try {
    for (let index = 0; index < JSON_BODY_LIMITS.pending; index++) {
      const reading = once(h.center.server, 'request'); pending.push(incompleteCenterBody(h, '/api/join-result')); await reading;
    }
    const overflow = incompleteCenterBody(h, '/api/join-result'); pending.push(overflow);
    assert.deepEqual(await overflow.response, { status: 429, connection: 'close', value: { error: '请求内容读取繁忙，请稍后重试', outcome: 'rejected' } });
    // Plugin payloads keep their existing 128 KiB cap, separate from public
    // endpoint caps and body slots. Authentication and node identity are real.
    assert.equal((await (await h.ping({ padding: 'x'.repeat(100 * 1024) })).json()).reject, false);
    assert.equal((await h.route()).status, 204);
    const oversized = await h.request('/api/join-result', { method: 'POST', body: { padding: 'x'.repeat(4096) }, authenticated: false });
    assert.equal(oversized.status, 413); assert.equal((await oversized.json()).outcome, 'rejected');
  } finally { for (const item of pending) item.request.destroy(); }
});

test('public operation saturation leaves independent admission for authenticated node heartbeats and routing', { timeout: 5000 }, async t => {
  const h = await onlineCenter(t); await h.login();
  let release, entered = 0, ready;
  const gate = new Promise(resolve => { release = resolve; }), admitted = new Promise(resolve => { ready = resolve; });
  const snapshot = h.center.registry.snapshot.bind(h.center.registry);
  h.center.registry.snapshot = async (...args) => { if (++entered === CENTER_REQUEST_LIMITS.public) ready(); await gate; return snapshot(...args); };
  const pending = Array.from({ length: CENTER_REQUEST_LIMITS.public }, () => h.request('/admin/api/overview'));
  for (const response of pending) void response.catch(() => {});
  let timeout;
  try {
    await Promise.race([admitted, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('public requests did not enter')), 3000); })]);
    clearTimeout(timeout);
    const excess = await h.request('/admin/api/overview'); assert.equal(excess.status, 503); assert.equal((await excess.json()).outcome, 'rejected');
    assert.equal((await (await h.ping()).json()).reject, false);
    assert.equal((await h.route()).status, 204);
    release(); assert((await Promise.all(pending)).every(response => response.status === 200));
    assert.equal((await h.request('/healthz')).status, 200);
  } finally { clearTimeout(timeout); release(); await Promise.allSettled(pending); }
});

test('incomplete plugin bodies cannot consume public JSON or internal GET admission', { timeout: 5000 }, async t => {
  const h = await onlineCenter(t), pending = [], received = [];
  h.center.server.on('request', req => { if (req.url.startsWith('/internal/frp-plugin')) received.push(req); });
  try {
    for (let index = 0; index < JSON_BODY_LIMITS.pending; index++) {
      const reading = once(h.center.server, 'request'); pending.push(incompleteCenterBody(h, '/internal/frp-plugin?op=Ping')); await reading;
    }
    const excess = incompleteCenterBody(h, '/internal/frp-plugin?op=Ping'); pending.push(excess);
    const result = await excess.response; assert.equal(result.status, 429); assert.equal(result.value.outcome, 'rejected'); assert.equal(result.connection, 'close');
    assert.equal((await h.route()).status, 204);
    const publicBody = await h.request('/api/join-result', { method: 'POST', authenticated: false, body: {} });
    assert.equal(publicBody.status, 400);
    const closed = received.slice(0, JSON_BODY_LIMITS.pending).map(req => new Promise(resolve => req.once('close', resolve)));
    for (const item of pending) item.request.destroy(); await Promise.all(closed);
    assert.equal((await (await h.ping()).json()).reject, false);
  } finally { for (const item of pending) item.request.destroy(); }
});

test('internal operation admission is bounded without consuming public capacity', { timeout: 5000 }, async t => {
  const h = await onlineCenter(t);
  h.center.server.closeIdleConnections(); await new Promise(resolve => setImmediate(resolve));
  let release, entered = 0, ready, timeout;
  const gate = new Promise(resolve => { release = resolve; }), admitted = new Promise(resolve => { ready = resolve; });
  const routeAllowed = h.center.registry.routeAllowed.bind(h.center.registry);
  h.center.registry.routeAllowed = async (...args) => { if (++entered === CENTER_REQUEST_LIMITS.internal) ready(); await gate; return routeAllowed(...args); };
  const pending = Array.from({ length: CENTER_REQUEST_LIMITS.internal }, () => h.route());
  for (const response of pending) void response.catch(() => {});
  try {
    await Promise.race([admitted, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('internal requests did not enter')), 3000); })]);
    clearTimeout(timeout);
    const excess = await h.route(); assert.equal(excess.status, 503); assert.equal((await excess.json()).outcome, 'rejected');
    assert.equal((await h.request('/healthz')).status, 200);
    release(); assert((await Promise.all(pending)).every(response => response.status === 204));
  } finally { clearTimeout(timeout); release(); await Promise.allSettled(pending); }
});

test('both center JSON classes enforce the absolute deadline and recover their admission', { timeout: 18000 }, async t => {
  const h = await onlineCenter(t), pending = [];
  try {
    pending.push(incompleteCenterBody(h, '/api/join-result'), incompleteCenterBody(h, '/internal/frp-plugin?op=Ping'));
    for (const response of await Promise.all(pending.map(item => item.response))) {
      assert.equal(response.status, 408); assert.equal(response.value.outcome, 'rejected'); assert.equal(response.connection, 'close');
    }
    assert.equal((await (await h.ping()).json()).reject, false); assert.equal((await h.route()).status, 204);
  } finally { for (const item of pending) item.request.destroy(); }
});

test('center reports unknown when an unexpected failure follows a committed mutation', async t => {
  const h = await setup(t); await h.login();
  const create = h.center.registry.createKey.bind(h.center.registry); let calls = 0;
  h.center.registry.createKey = async (...args) => { calls++; await create(...args); throw Error('injected lost result'); };
  const response = await h.request('/admin/api/keys', { method: 'POST', body: { name: 'Committed once', slug: 'committed-once' } });
  assert.equal(response.status, 503); assert.equal((await response.json()).outcome, 'unknown');
  assert.equal(calls, 1); assert.equal((await h.center.registry.snapshot()).keys.filter(key => key.slug === 'committed-once').length, 1);
});

test('a lost enrollment response is resolved over authenticated HTTP without repeating the join or changing node services', async t => {
  const h = await setup(t), key = await h.center.registry.createKey({ name: 'Lost response', slug: 'receipt' });
  const root = join(h.directory, 'node'); await mkdir(root);
  const env = 'PUBLIC_ORIGIN=http://127.0.0.1:36080\n'; await writeFile(join(root, '.env'), env, { mode: 0o600 });
  let joins = 0, services = 0;
  const options = { root, server: h.origin, slug: key.slug, mode: 'terminal', panelPort: 36080, configHome: join(root, 'config'),
    install: async () => '/opt/isolated-frpc', promptKey: async () => key.key,
    run: async () => { services++; return { ok: true, stdout: 'active' }; },
    request: async (url, init) => { const response = await centerRequest(url, init); if (url.endsWith('/api/join')) { joins++; throw Error('simulated lost response'); } return response; } };
  await assert.rejects(joinNode(options), { outcome: 'unknown' });
  const journal = join(root, 'data/selfhost-node/join-recovery.json'), before = await readFile(journal, 'utf8'), receipt = JSON.parse(before);
  assert.equal(receipt.credential, null); assert(h.center.registry.sessions.has(key.slug));
  const diagnostic = await nodeDoctor({ root, resolve: true, request: centerRequest });
  assert.equal(diagnostic.enrollment.state, 'accepted'); assert.equal(diagnostic.operationId, receipt.operation.id);
  assert(!JSON.stringify(diagnostic).includes(receipt.operation.proof)); assert(!JSON.stringify(diagnostic).includes(h.center.registry.enrollmentResult({ ...receipt.target, mode: receipt.mode, operation: receipt.operation }).credential));
  assert.equal(await readFile(journal, 'utf8'), before);
  const denied = await h.request('/api/join-result', { method: 'POST', authenticated: false, body: { slug: key.slug, nodeId: receipt.target.nodeId, mode: receipt.mode, operation: { ...receipt.operation, proof: 'cocj_' + 'x'.repeat(43) } } });
  assert.equal(denied.status, 404);
  assert.equal((await leaveNode({ ...options, recover: true, request: centerRequest })).recovered, true);
  assert.equal(joins, 1); assert.equal(services, 0); assert(!h.center.registry.sessions.has(key.slug));
  assert.equal(await readFile(join(root, '.env'), 'utf8'), env);
  await assert.rejects(readFile(journal), { code: 'ENOENT' });
});

for (const action of ['create', 'update', 'reissue', 'revoke', 'disconnect']) test(`logout rejects a delayed administrator ${action} request without changing registry state`, async t => {
  const h = await setup(t); await h.login();
  const key = await h.center.registry.createKey({ name: 'Original node', slug: 'original' });
  const routes = {
    create: ['POST', '/admin/api/keys', { name: 'Late node', slug: 'late' }],
    update: ['PATCH', '/admin/api/keys/' + key.id, { name: 'Late rename' }],
    reissue: ['POST', '/admin/api/keys/' + key.id + '/reissue', { neverExpires: true }],
    revoke: ['DELETE', '/admin/api/keys/' + key.id, {}],
    disconnect: ['POST', '/admin/api/nodes/original/disconnect', {}],
  };
  const before = await readFile(join(h.directory, 'center', 'state.json'), 'utf8');
  const [method, path, body] = routes[action], text = JSON.stringify(body), started = once(h.center.server, 'request');
  let pending;
  const result = new Promise((resolve, reject) => {
    pending = http.request(h.origin + path, { method, headers: { origin: h.origin, cookie: h.cookie, 'x-csrf-token': h.csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    pending.once('error', reject); pending.write(text.slice(0, 1));
  });
  t.after(() => pending.destroy()); await started;
  assert.equal((await h.request('/admin/api/logout', { method: 'POST', body: {} })).status, 200);
  pending.end(text.slice(1));
  assert.equal(await result, 401);
  assert.equal(await readFile(join(h.directory, 'center', 'state.json'), 'utf8'), before);
});

test('administrator reads revalidate their session after waiting for registry work', async t => {
  const h = await setup(t); await h.login();
  let release; h.center.registry.queue = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const started = once(h.center.server, 'request'), response = h.request('/admin/api/overview'); await started;
  await h.request('/admin/api/logout', { method: 'POST', body: {} }); release();
  assert.equal((await response).status, 401);
});

test('logout rejects a complete administrator write queued behind other registry work', async t => {
  const h = await setup(t); await h.login();
  let release, entered; h.center.registry.queue = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const queued = new Promise(resolve => { entered = resolve; }), create = h.center.registry.createKey.bind(h.center.registry);
  t.mock.method(h.center.registry, 'createKey', (...args) => { const result = create(...args); entered(); return result; });
  const response = h.request('/admin/api/keys', { method: 'POST', body: { name: 'Queued node', slug: 'queued' } }); await queued;
  await h.request('/admin/api/logout', { method: 'POST', body: {} }); release();
  assert.equal((await response).status, 401); assert.deepEqual(await h.center.registry.list(), []);
});

for (const action of ['join', 'leave']) test(`a cancelled machine ${action} never commits after waiting for storage`, async t => {
  const h = await setup(t), registry = h.center.registry;
  const key = await registry.createKey({ name: 'Node', slug: 'cancelled' }), node = { id: 'a'.repeat(32), mode: 'terminal' };
  const original = action === 'leave' ? await registry.join({ version: 1, slug: key.slug, key: key.key, node }) : null;
  const body = action === 'join' ? { version: 1, slug: key.slug, key: key.key, node } : { slug: key.slug, credential: original.credential };
  const before = await readFile(join(h.directory, 'center/state.json'), 'utf8'), sessions = structuredClone(registry.sessions);
  let release, entered, disconnected;
  registry.queue = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const admitted = new Promise(resolve => { entered = resolve; }), closed = new Promise(resolve => { disconnected = resolve; });
  const operation = registry[action].bind(registry);
  t.mock.method(registry, action, (...args) => { const result = operation(...args); entered(); return result; });
  h.center.server.once('request', (_req, res) => res.once('close', disconnected));
  const request = http.request(h.origin + '/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {}); t.after(() => request.destroy()); request.end(JSON.stringify(body));
  await admitted; request.destroy(); await closed; release(); await registry.queue;
  assert.equal(await readFile(join(h.directory, 'center/state.json'), 'utf8'), before);
  assert.deepEqual(registry.sessions, sessions);
  const retry = await h.request('/api/' + action, { method: 'POST', body, authenticated: false });
  assert.equal(retry.status, 200);
});

test('center bounds password verification concurrency and accepts login after busy requests drain', async t => {
  const h = await setup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.request('/admin/api/login', { method: 'POST', authenticated: false, body: { username: 'admin', password: 'center_password_very_long_123' } })));
  assert(responses.some(response => response.status === 200));
  assert(responses.some(response => response.status === 429));
  for (const response of responses) assert([200, 429].includes(response.status));
  assert.equal((await h.login()).status, 200);
});

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

test('central login uses its own password-manager identity and still accepts the original username', async t => {
  const h = await setup(t), html = await (await h.request('/admin/', { authenticated: false })).text();
  assert.match(html, /value="admin@center"/);
  assert.match(html, /autocomplete="section-coc-center username"/);
  assert.match(html, /action="\/admin\/api\/login"/);
  const send = (username, password = 'center_password_very_long_123') => h.request('/admin/api/login', { method: 'POST', authenticated: false, body: { username, password } });
  assert.equal((await send('admin@node-a')).status, 401);
  assert.equal((await send('admin@center', 'wrong_password_123')).status, 401);
  const logged = await send('admin@center'); assert.equal(logged.status, 200); assert.equal((await logged.json()).username, 'admin');
  assert.equal((await h.login()).status, 200);
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
  assert.equal((await h.request('/')).status, 200);
  assert.equal((await h.request('/admin')).headers.get('location'), '/admin/');
  const page = await h.request('/admin/'); assert.match(page.headers.get('set-cookie'), /coc_session_center=; Path=\/;.*Max-Age=0/);
});


test('the anonymous homepage and online list expose only routable node names, modes and paths', async t => {
  const h = await setup(t), registry = h.center.registry;
  let now = Date.now(); registry.now = () => now;
  const enroll = async (slug, mode = 'desktop', state = 'online', expiresAt = null) => {
    const key = await registry.createKey({ name: '节点 ' + slug, slug, expiresAt });
    if (state === 'offline') return key;
    const joined = await registry.join({ version: 1, slug, key: key.key, node: { id: 'a'.repeat(32), mode }, source: '198.51.100.20' });
    if (state === 'connecting') return key;
    const metas = { credential: joined.credential, slug, nodeId: 'a'.repeat(32), mode }, runId = 'run-' + slug;
    assert(await registry.authorizeLogin({ metas, runId, source: '198.51.100.20' }));
    if (state === 'authenticated') return key;
    assert(await registry.authorizeProxy({ metas, runId, name: 'node-' + slug, type: 'http', customDomains: ['desk.example.test'], locations: ['/node/' + slug + '/'] }));
    if (state === 'grace') await registry.closeProxy({ metas, runId });
    return key;
  };
  await enroll('offline', 'terminal', 'offline'); await enroll('connecting', 'terminal', 'connecting');
  await enroll('authenticated', 'terminal', 'authenticated'); await enroll('grace', 'terminal', 'grace');
  await enroll('expired', 'terminal', 'online', now + 60000);
  const revoked = await enroll('revoked'); await registry.revoke(revoked.id);
  await enroll('a'); await enroll('b', 'terminal'); now += 60001;
  const page = await h.request('/', { authenticated: false });
  assert.equal(page.status, 200); assert.equal(page.headers.get('location'), null);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text(); assert.match(html, /href="\/admin\/"/); assert(!html.includes('password')); assert(!html.includes('id="help-entry"'));
  assert.equal((await h.request('/help/', { authenticated: false })).status, 404);
  for (const path of ['/home.js', '/styles.css']) assert.equal((await h.request(path, { authenticated: false })).status, 200);
  const response = await h.request('/api/public/nodes', { authenticated: false });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { nodes: [{ name: '节点 a', path: '/node/a/', mode: 'desktop' }, { name: '节点 b', path: '/node/b/', mode: 'terminal' }] });
  assert.equal((await h.request('/admin/api/keys', { authenticated: false })).status, 401);
  assert.equal((await h.request('/api/public/nodes', { method: 'POST', body: {}, authenticated: false })).status, 404);
  assert.equal((await h.request('/api/public/keys', { authenticated: false })).status, 404);
  now += 60000;
  assert.deepEqual(await (await h.request('/api/public/nodes', { authenticated: false })).json(), { nodes: [] });
});

test('public list polling has a separate per-client bounded rate limit', async t => {
  const h = await setup(t);
  for (let index = 0; index < 121; index++) {
    const response = await h.request('/api/public/nodes', { authenticated: false, headers: { 'x-forwarded-for': '198.51.100.30' } });
    assert.equal(response.status, index < 120 ? 200 : 429);
  }
  assert.equal((await h.request('/api/public/nodes', { authenticated: false, headers: { 'x-forwarded-for': '198.51.100.31' } })).status, 200);
  assert.equal((await h.login()).status, 200);
});

test('custom help is public and sandboxed without changing homepage or admin security', async t => {
  const content = '<!doctype html><html lang="zh-CN"><h1>使用帮助</h1><a href="/">返回首页</a></html>';
  const h = await setup(t, { helpPage: content });
  const home = await h.request('/', { authenticated: false }); assert.match(await home.text(), /id="help-entry"[^>]*href="\/help\/"/);
  const response = await h.request('/help/', { authenticated: false });
  assert.equal(response.status, 200); assert.equal(await response.text(), content);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.match(response.headers.get('x-content-type-options'), /nosniff/);
  const redirect = await h.request('/help', { authenticated: false }); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/help/');
  for (const path of ['/help.html', '/help/admin_password', '/help/%2e%2e%2fadmin_password']) assert.equal((await h.request(path, { authenticated: false })).status, 404);
  const invalidHost = await new Promise((resolve, reject) => {
    http.get(h.origin + '/help/', { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(invalidHost, 400);
  assert.equal((await h.request('/help/', { method: 'POST', body: {}, authenticated: false })).status, 404);
  assert.equal((await h.request('/admin/api/keys', { authenticated: false })).status, 401);
});

test('overview and lifecycle writes retain authentication, origin and CSRF boundaries', async t => {
  const h = await setup(t);
  assert.equal((await h.request('/admin/api/overview', { authenticated: false })).status, 401);
  await h.login();
  assert.equal((await h.request('/admin/api/keys', { method: 'POST', body: { name: '节点', slug: 'finite', neverExpires: false, expiresAt: null } })).status, 400);
  const key = await (await h.request('/admin/api/keys', { method: 'POST', body: { name: '节点', slug: 'node-a', neverExpires: true, expiresAt: null } })).json();
  const path = '/admin/api/keys/' + key.id;
  for (const [method, url, body] of [['PATCH', path, { name: '改名' }], ['POST', path + '/reissue', { neverExpires: true }]]) {
    assert.equal((await h.request(url, { method, body, authenticated: false })).status, 401);
    assert.equal((await h.request(url, { method, body, headers: { 'x-csrf-token': '' } })).status, 403);
    assert.equal((await h.request(url, { method, body, headers: { origin: 'https://evil.example.test' } })).status, 403);
  }
  const overview = await (await h.request('/admin/api/overview')).json();
  assert.equal(overview.keys.length, 1); assert.equal(overview.revision, overview.status.revision); assert.equal(overview.csrf, h.csrf);
  assert.equal((await h.request(path, { method: 'PATCH', body: { name: '新名称', revision: overview.revision } })).status, 200);
  assert.equal((await h.request(path + '/reissue', { method: 'POST', body: { neverExpires: true, revision: overview.revision } })).status, 409);
  const fresh = await (await h.request(path + '/reissue', { method: 'POST', body: { neverExpires: true } })).json();
  assert.equal(fresh.id, key.id); assert.notEqual(fresh.key, key.key); assert.equal(fresh.name, '新名称');
  const publicList = await (await h.request('/api/public/nodes', { authenticated: false })).json(); assert.deepEqual(publicList.nodes, []);
});
