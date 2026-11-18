import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayFixture } from './gateway-fixture.mjs';

const node = n => ({ id: n.toString(16).padStart(32, '0'), name: '探测节点 ' + n, backendOrigin: `https://probe-${n}.example.test`, mode: 'terminal' });
const secret = n => n.toString(16).padStart(64, '0');
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(count = 1) {
  const h = await gatewayFixture({ probe: async () => true });
  await h.login(); const code = await h.code();
  for (let n = 1; n <= count; n++) assert.equal((await h.register(node(n), secret(n), code.key)).status, 200);
  h.advance(6000); return h;
}
async function login(h) {
  const response = await h.fetch(h.origin + '/__nodes/api/login', { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: h.password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const value = await (await h.fetch(h.origin + '/__nodes/api/nodes', { headers: { cookie } })).json();
  return { cookie, csrf: value.csrf };
}
const request = (h, session, path, body) => h.fetch(h.origin + '/__nodes/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: h.origin, cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const probe = (h, session, n = 1) => request(h, session, 'probe', { nodeId: node(n).id });
function watchJoin(h) {
  const joined = latch(), get = h.registry.probes.get.bind(h.registry.probes);
  h.registry.probes.get = id => { const value = get(id); if (value) joined.resolve(); return value; };
  return joined.promise;
}

for (const revoked of ['first', 'follower', 'none']) test(`coalesced readiness validates each caller independently when ${revoked} session is revoked`, { timeout: 5000 }, async () => {
  const h = await fixture(), a = await login(h), b = await login(h);
  const entered = latch(), gate = latch(); let probes = 0;
  h.registry.probe = async () => { probes++; entered.resolve(); await gate.promise; return true; };
  const joined = watchJoin(h);
  try {
    const first = probe(h, a); await entered.promise;
    const follower = probe(h, b); await joined;
    if (revoked !== 'none') assert.equal((await request(h, revoked === 'first' ? a : b, 'logout', {})).status, 200);
    gate.resolve();
    const responses = await Promise.all([first, follower]);
    assert.deepEqual(responses.map(response => response.status), revoked === 'first' ? [401, 200] : revoked === 'follower' ? [200, 401] : [200, 200]);
    for (const response of responses.filter(response => response.ok)) assert.equal((await response.json()).ready, true);
    assert.equal((await request(h, revoked === 'first' ? b : a, 'nodes')).status, 200);
    assert.equal(probes, 1); assert.equal(h.registry.probes.size, 0);
    assert.equal(h.storage.value.nodes[0].checkedAt, h.registry.now());
  } finally { gate.resolve(); }
});

for (const changed of ['secret', 'backendOrigin', 'removed']) test(`shared readiness cannot commit an old result after node ${changed} changes`, { timeout: 5000 }, async () => {
  const h = await fixture(), a = await login(h), b = await login(h), entered = latch(), gate = latch();
  h.registry.probe = async () => { entered.resolve(); await gate.promise; return true; };
  try {
    const first = probe(h, a); await entered.promise;
    await h.registry.transaction(value => {
      if (changed === 'removed') value.nodes = [];
      else value.nodes[0][changed] = changed === 'secret' ? secret(99) : 'https://changed.example.test';
    });
    let follower;
    if (changed !== 'removed') { const joined = watchJoin(h); follower = probe(h, b); await joined; }
    gate.resolve();
    assert.equal((await first).status, 409);
    if (follower) assert.equal((await follower).status, 409);
    assert.equal(h.registry.probes.size, 0);
    if (changed !== 'removed') assert.notEqual(h.storage.value.nodes[0].checkedAt, h.registry.now());
  } finally { gate.resolve(); }
});

test('readiness rejects unauthenticated or invalid CSRF callers before joining a valid probe', { timeout: 5000 }, async () => {
  const h = await fixture(), a = await login(h), b = await login(h), entered = latch(), gate = latch(); let probes = 0;
  h.registry.probe = async () => { probes++; entered.resolve(); await gate.promise; return true; };
  try {
    const first = probe(h, a); await entered.promise;
    assert.equal((await probe(h, { cookie: '', csrf: '' })).status, 401);
    assert.equal((await probe(h, { ...b, csrf: 'invalid' })).status, 403);
    assert.equal(probes, 1); gate.resolve(); assert.equal((await first).status, 200);
  } finally { gate.resolve(); }
});

test('readiness keeps its four-network-probe limit while admitting a follower of an existing probe', { timeout: 5000 }, async () => {
  const h = await fixture(5), a = await login(h), entered = latch(), gate = latch(); let probes = 0;
  h.registry.probe = async () => { if (++probes === 4) entered.resolve(); await gate.promise; return true; };
  try {
    const pending = [1, 2, 3, 4].map(n => probe(h, a, n)); await entered.promise;
    assert.equal(h.registry.probes.size, 4); assert.equal((await probe(h, a, 5)).status, 429);
    const joined = watchJoin(h), follower = probe(h, a); await joined;
    assert.equal(probes, 4); gate.resolve();
    assert.deepEqual((await Promise.all([...pending, follower])).map(response => response.status), [200, 200, 200, 200, 200]);
    assert.equal(h.registry.probes.size, 0);
    assert.equal((await probe(h, a)).status, 200); assert.equal(probes, 4); // Five-second cache.
  } finally { gate.resolve(); }
});

test('a rejected shared network probe releases its slot and permits an explicit fresh probe', async () => {
  const h = await fixture(), a = await login(h);
  h.registry.probe = async () => { throw Error('synthetic readiness failure'); };
  assert.equal((await probe(h, a)).status, 503); assert.equal(h.registry.probes.size, 0);
  h.registry.probe = async () => false;
  const response = await probe(h, a); assert.equal(response.status, 200); assert.equal((await response.json()).ready, false);
});
