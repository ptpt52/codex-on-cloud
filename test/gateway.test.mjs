import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayFixture } from './gateway-fixture.mjs';
import { gatewayConfig, gatewayBackend, gatewayProxyHeaders, gatewayNode, gatewayHex, GATEWAY_LIMITS, gatewayDeadline, gatewayJSON, gatewayDigest } from '../gateway/protocol.mjs';

const entry = number => ({ id: number.toString(16).padStart(32, '0'), name: '动态节点 ' + number, backendOrigin: `https://node-${number}.example.test`, mode: 'terminal' });
const key = number => number.toString(16).padStart(64, '0');
const setup = async options => { const h = await gatewayFixture({ probe: async () => true, ...options }); await h.login(); const code = await h.code(); return { ...h, codeValue: code }; };

test('stable gateway reads avoid storage writes while concurrent mutations remain durable and serialized', async () => {
  const h = await setup(), before = structuredClone(h.storage.value), writes = h.storage.writes;
  const reads = await Promise.all(Array.from({ length: 20 }, (_, index) => h.api(index % 2 ? 'nodes' : 'codes')));
  assert(reads.every(response => response.status === 200));
  assert.equal(h.storage.writes, writes); assert.deepEqual(h.storage.value, before);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => h.api(index % 2 ? 'nodes' : 'codes', index % 2 ? {} : { method: 'POST', body: { name: 'Concurrent ' + index } })));
  assert(responses.every(response => response.status === 200)); assert.equal(h.storage.writes, writes + 4);
  assert.equal(h.storage.value.codes.length, before.codes.length + 4);
  h.restart(); const listing = await (await h.api('codes')).json();
  assert.equal(listing.codes.length, before.codes.length + 4); assert.equal(h.storage.writes, writes + 4);
});

test('gateway read transactions persist expiry cleanup once and recheck revoked sessions', async () => {
  const h = await setup(), now = h.registry.now();
  h.storage.value.sessions.push({ ...h.storage.value.sessions[0], hash: 'a'.repeat(64), expires: now - 1 });
  h.storage.value.failures.push({ client: 'expired', count: 1, until: now - 1 });
  h.storage.value.pending = { id: key(1).slice(0, 32), nodeId: entry(1).id, at: now - GATEWAY_LIMITS.pendingMs - 1 };
  const writes = h.storage.writes;
  assert.equal((await h.api('nodes')).status, 200); assert.equal(h.storage.writes, writes + 1);
  assert.equal(h.storage.value.sessions.length, 1); assert.deepEqual(h.storage.value.failures, []); assert.equal(h.storage.value.pending, null);
  assert.equal((await h.api('nodes')).status, 200); assert.equal(h.storage.writes, writes + 1);
  assert.equal((await h.api('logout', { method: 'POST', body: {} })).status, 200); assert.equal(h.storage.writes, writes + 2);
  assert.equal((await h.api('nodes')).status, 401); assert.equal(h.storage.writes, writes + 2);
});

test('gateway read optimization preserves initial state persistence and password rotation', async () => {
  const h = await gatewayFixture(); assert.equal(h.storage.writes, 0);
  await h.login(); assert.equal(h.storage.writes, 1);
  await h.code(); assert.equal(h.storage.writes, 2);
  const original = h.env.GATEWAY_PASSWORD_HASH;
  const password = 'rotated-test-password-' + 'b'.repeat(32);
  h.env.GATEWAY_PASSWORD_HASH = await gatewayDigest(password);
  assert.equal((await h.api('nodes')).status, 401);
  assert.equal((await h.api('login', { method: 'POST', body: { password } })).status, 200);
  assert.equal(h.storage.writes, 3); assert.deepEqual(h.storage.value.codes, []);
  assert.equal(h.storage.value.sessions.length, 1); assert.equal(h.storage.value.passwordHash, h.env.GATEWAY_PASSWORD_HASH);
  assert.equal((await h.api('nodes')).status, 401); assert.equal(h.storage.writes, 3);
  h.env.GATEWAY_PASSWORD_HASH = original;
  await h.login(); const writes = h.storage.writes;
  h.advance(604800001);
  assert.equal((await h.api('nodes')).status, 401); assert.equal(h.storage.writes, writes);
  // A successful login commits cleanup and a fresh session in one write.
  await h.login(); assert.equal(h.storage.writes, writes + 1); assert.equal(h.storage.value.sessions.length, 1);
});

test('a switched browser scope never sends sensitive headers or file bytes to the new backend', async () => {
  const calls = [], h = await setup({ request: async request => {
    calls.push(request); return new Response('accepted', { headers: { 'x-codex-node-id': request.headers.get('x-codex-gateway-node') } });
  } });
  for (const n of [1, 2]) assert.equal((await h.register(entry(n), key(n), h.codeValue.key)).status, 200);
  await h.select(entry(1).id); await h.select(entry(2).id);
  const old = entry(1).id, current = entry(2).id;
  for (const [path, headers] of [
    ['/api/login', { 'x-codex-node': old }],
    ['/api/files/private.bin?node=' + old, {}],
    ['/api/login?node=' + old, { 'x-codex-node': current }],
    ['/api/login?node=' + current + '&node=' + old, {}],
    ['/api/login', { 'x-codex-node': '' }],
  ]) {
    let canceled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('synthetic sensitive body')); }, cancel() { canceled = true; } });
    const response = await h.fetch(h.origin + path, { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/json', ...headers }, body, duplex: 'half' });
    assert.equal(response.status, 409); assert.deepEqual((await response.json()).code, 'node_changed');
    assert(canceled); assert.equal(calls.length, 0);
  }
  const response = await h.fetch(h.origin + '/session/connect?node=' + old, { headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 409); assert.equal(calls.length, 0);
  assert.equal((await h.fetch(h.origin + '/api/state?node=' + current, { headers: { 'x-codex-node': current } })).status, 200);
  assert.equal(calls.length, 1);
});

test('gateway propagates cancellation through registry control, routing and the selected upstream', async () => {
  let dispatched; const seen = [], h = await setup({ request: (request, options) => {
    assert(options.signal, 'upstream fetch needs an explicit cancellation signal');
    seen.push(request); dispatched(request);
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  } });
  await h.register(entry(1), key(1), h.codeValue.key); await h.select(entry(1).id);
  const registry = h.registry;
  for (const path of ['/__nodes/api/nodes', '/api/state']) {
    let started; const ready = new Promise(resolve => { started = resolve; });
    h.env.GATEWAY_REGISTRY.get = () => ({ fetch: (request, options) => {
      assert(options.signal, 'registry fetch needs an explicit cancellation signal');
      started(request); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } });
    const controller = new AbortController(), response = h.fetch(h.origin + path, { signal: controller.signal });
    const forwarded = await ready; controller.abort(); await response;
    assert.equal(forwarded.signal.aborted, true); assert.equal(seen.length, 0);
  }
  h.env.GATEWAY_REGISTRY.get = () => registry;
  const ready = new Promise(resolve => { dispatched = resolve; });
  const controller = new AbortController();
  const response = h.fetch(h.origin + '/api/state', { signal: controller.signal });
  const forwarded = await ready; controller.abort(); await response;
  assert.equal(forwarded.signal.aborted, true);
  await h.fetch(h.origin + '/api/input', { method: 'POST', signal: controller.signal });
  assert.equal(seen.length, 1, 'an already canceled mutation must not be dispatched');
});

test('gateway control deadline includes a dripping response body and cancels its reader', async () => {
  let canceled = false, interval;
  const response = new Response(new ReadableStream({ start(controller) { interval = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 10); }, cancel() { canceled = true; clearInterval(interval); } }));
  try { await assert.rejects(gatewayDeadline(undefined, 80, signal => gatewayJSON(response, 4096, signal)), /超时/); assert(canceled); }
  finally { clearInterval(interval); }
});

test('canceling an incomplete control upload never dispatches it or waits for a stuck body cleanup', async () => {
  const h = await setup(); let pulling, canceled = false, dispatches = 0;
  const reading = new Promise(resolve => { pulling = resolve; });
  const body = new ReadableStream({ pull() { pulling(); return new Promise(() => {}); }, cancel() { canceled = true; return new Promise(() => {}); } });
  h.env.GATEWAY_REGISTRY.get = () => ({ fetch() { dispatches++; throw Error('must not dispatch incomplete JSON'); } });
  const controller = new AbortController();
  const pending = h.fetch(h.origin + '/__nodes/api/codes', { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/json' }, body, duplex: 'half', signal: controller.signal });
  await reading; controller.abort();
  let timer;
  try { const response = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('canceled request stuck in cleanup')), 1000); })]); assert.equal(response.status, 408); }
  finally { clearTimeout(timer); }
  assert(canceled); assert.equal(dispatches, 0);
});

test('a registry commit followed by a lost storage acknowledgement is unknown and not repeated', async () => {
  const h = await setup(), transaction = h.storage.transaction.bind(h.storage), before = h.storage.value.codes.length;
  h.storage.transaction = async fn => { await transaction(fn); throw Error('injected lost commit acknowledgement'); };
  const response = await h.api('codes', { method: 'POST', body: { name: 'Committed once' } });
  assert.equal(response.status, 503); assert.equal((await response.json()).outcome, 'unknown');
  assert.equal(h.storage.value.codes.length, before + 1);
});

test('native helper control and data stay on their authorized node while browser selection changes', async () => {
  const calls = [], h = await setup({ request: async request => {
    const selected = request.headers.get('x-codex-gateway-node'); calls.push({ selected, path: new URL(request.url).pathname });
    return new Response('accepted', { headers: { 'x-codex-node-id': selected } });
  } });
  await h.register(entry(1), key(1), h.codeValue.key); await h.register(entry(2), key(2), h.codeValue.key); await h.select(entry(1).id);
  for (const path of ['/forward/agent', '/forward/helper', '/forward/resume', '/forward/data', '/forward/transport']) {
    const response = await h.fetch(h.origin + path, { headers: { 'x-codex-forward-node': entry(2).id, authorization: 'Bearer ' + (path.endsWith('/agent') ? entry(2).id + '.' : '') + 'a'.repeat(43) } });
    assert.equal(response.status, 200); assert.equal(calls.at(-1).selected, entry(2).id);
  }
  await h.fetch(h.origin + '/api/state', { headers: { 'x-codex-forward-node': entry(2).id } }); assert.equal(calls.at(-1).selected, entry(1).id);
  assert.equal((await h.fetch(h.origin + '/forward/agent', { headers: { 'x-codex-forward-node': 'invalid' } })).status, 400);
  assert.equal(h.storage.value.activeId, entry(1).id);
});

test('fixed gateway login, CSRF and Host checks protect selection while registration credentials cannot administer the gateway', async () => {
  const h = await gatewayFixture({ probe: async () => true });
  assert.equal((await h.api('nodes')).status, 401);
  assert.equal((await h.api('login', { method: 'POST', body: { password: h.password }, headers: { origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await h.fetch('https://other.example.test/__nodes/')).status, 400);
  await h.login(); const code = await h.code(); assert.equal((await h.register(entry(1), key(1), code.key)).status, 200);
  assert.equal((await h.api('switch', { method: 'POST', body: {}, headers: { 'x-csrf-token': '' } })).status, 400);
  const state = await (await h.api('nodes')).json();
  assert.equal((await h.api('switch', { method: 'POST', body: { nodeId: entry(1).id, revision: state.revision, operation: 'a'.repeat(32) }, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await h.api('nodes', { headers: { cookie: '', authorization: 'Bearer ' + key(1) } })).status, 401);
  assert.equal((await h.api('route')).status, 404); assert.equal((await h.fetch(h.origin + '/__nodes/api/../route')).status, 404);
  assert.equal((await h.api('codes', { method: 'POST', raw: '', body: { name: 'x'.repeat(9000) } })).status, 413);
});

test('pinned helper routes fail closed when an older registry ignores the requested node during deployment', async () => {
  const calls = [], h = await setup({ request: async request => {
    const selected = request.headers.get('x-codex-gateway-node'); calls.push(selected);
    return new Response('accepted', { headers: { 'x-codex-node-id': selected } });
  } });
  await h.register(entry(1), key(1), h.codeValue.key); await h.register(entry(2), key(2), h.codeValue.key); await h.select(entry(1).id);
  h.env.GATEWAY_REGISTRY.get = () => ({ fetch: request => {
    const url = new URL(request.url); url.search = ''; // Pre-pinning DO behavior.
    return h.registry.fetch(new Request(url, request));
  } });
  for (const path of ['/forward/agent', '/forward/helper', '/forward/resume', '/forward/data', '/forward/transport']) {
    const response = await h.fetch(h.origin + path, { headers: { 'x-codex-forward-node': entry(2).id, authorization: 'Bearer ' + 'a'.repeat(43) } });
    assert.equal(response.status, 503);
  }
  assert.deepEqual(calls, []); assert.equal(h.storage.value.activeId, entry(1).id);
  const own = await h.fetch(h.origin + '/forward/agent', { headers: { 'x-codex-forward-node': entry(1).id, authorization: 'Bearer ' + 'a'.repeat(43) } });
  assert.equal(own.status, 200); assert.deepEqual(calls, [entry(1).id]);
});

test('arbitrary nodes register dynamically with bounded pagination, revoked codes preserve existing ownership, and routing survives restart', async () => {
  const h = await setup();
  for (let number = 1; number <= 20; number++) assert.equal((await h.register(entry(number), key(number), h.codeValue.key)).status, 200);
  const first = await (await h.api('nodes')).json(); assert.equal(first.nodes.length, 16); assert.equal(first.next, 16); assert.equal(first.total, 20);
  assert.equal(JSON.stringify(first).includes(key(2)), false); assert.equal(JSON.stringify(first).includes('backendOrigin'), false);
  const second = await (await h.api('nodes?offset=16')).json(); assert.equal(second.nodes.length, 4); assert.equal(second.next, null);
  assert.equal((await h.select(entry(17).id)).status, 200); h.restart(); assert.equal((await (await h.api('nodes')).json()).activeId, entry(17).id);
  assert.equal((await h.api('codes/' + h.codeValue.id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await h.register(entry(21), key(21), h.codeValue.key)).status, 401);
  assert.equal((await h.register(entry(1), key(1))).status, 200);
  assert.equal((await h.register(entry(1), key(2), h.codeValue.key)).status, 409);
});

test('selection probes the exact target before an atomic route update and never retries an unavailable target', async () => {
  let available = true, probes = 0;
  const h = await setup({ probe: async node => { probes++; return available || node.id === entry(1).id; } });
  await h.register(entry(1), key(1), h.codeValue.key); await h.register(entry(2), key(2), h.codeValue.key); await h.select(entry(1).id);
  available = false; const count = probes; assert.equal((await h.select(entry(2).id)).status, 503); assert.equal(probes, count + 1);
  assert.equal((await (await h.api('nodes')).json()).activeId, entry(1).id); assert.equal(h.storage.value.pending, null);
});

test('only one selection can be pending and an expired probe cannot overwrite a later confirmed selection', async () => {
  let release, entered; const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }); let hold = false;
  const h = await setup({ probe: async node => { if (hold && node.id === entry(1).id) { entered(); await waiting; } return true; } });
  await h.register(entry(1), key(1), h.codeValue.key); await h.register(entry(2), key(2), h.codeValue.key); hold = true;
  const original = h.select(entry(1).id); await started;
  assert.equal((await h.select(entry(2).id)).status, 409);
  h.advance(GATEWAY_LIMITS.pendingMs + 1); assert.equal((await h.select(entry(2).id)).status, 200);
  release(); assert.equal((await original).status, 409); assert.equal(h.storage.value.activeId, entry(2).id);
});

test('lost selection acknowledgements are reconciled by operation identity without executing another switch', async () => {
  let probes = 0; const h = await setup({ probe: async () => { probes++; return true; } }); await h.register(entry(1), key(1), h.codeValue.key);
  const operation = 'c'.repeat(32), first = await h.select(entry(1).id, operation); assert.equal(first.status, 200); const count = probes;
  assert.equal((await h.select(entry(1).id, operation)).status, 200); assert.equal(probes, count); assert.equal(h.storage.value.lastSwitch.id, operation);
  assert.equal((await h.api('nodes/' + entry(1).id, { method: 'DELETE', body: { revision: h.storage.value.revision } })).status, 409);
});

test('gateway streams one authenticated request, removes control and other-node cookies, and preserves browser Origin and CSRF', async () => {
  const calls = []; const h = await setup({ request: async request => {
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    return new Response('accepted', { headers: { 'x-codex-node-id': entry(1).id } });
  } }); await h.register(entry(1), key(1), h.codeValue.key); await h.select(entry(1).id);
  const response = await h.fetch(h.origin + '/api/files/value.txt', { method: 'PUT', headers: { origin: h.origin, cookie: `coc_gateway_session=${key(9)}; coc_session_${entry(1).id}=own; coc_session_${entry(2).id}=other`, 'x-csrf-token': 'retained', 'x-codex-node': entry(1).id, 'x-codex-gateway-secret': 'spoof' }, body: 'literal $(never run)' });
  assert.equal(await response.text(), 'accepted'); assert.equal(calls.length, 1); assert.equal(calls[0].headers.origin, h.origin); assert.equal(calls[0].headers['x-csrf-token'], 'retained');
  assert.equal(calls[0].headers['x-codex-gateway-secret'], key(1)); assert.equal(calls[0].headers.cookie, `coc_session_${entry(1).id}=own`);
  assert.equal(calls[0].body, 'literal $(never run)'); assert.equal(new URL(calls[0].url).origin, entry(1).backendOrigin);
});

test('backend failures do not replay mutations; navigation reaches the independent selection page and loops are rejected', async () => {
  let calls = 0; const h = await setup({ request: async () => { calls++; throw Error('upstream gone'); } }); await h.register(entry(1), key(1), h.codeValue.key); await h.select(entry(1).id);
  const input = await h.fetch(h.origin + '/api/key', { method: 'POST', headers: { origin: h.origin }, body: '{}' }); assert.equal(input.status, 502); assert.equal((await input.json()).outcome, 'unknown'); assert.equal(calls, 1);
  const page = await h.fetch(h.origin); assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/__nodes/?unavailable=1'); assert.equal(calls, 2);
  assert.equal((await h.fetch(h.origin + '/', { headers: { 'x-codex-gateway-hop': '1' } })).status, 508); assert.equal(calls, 2);
});

test('backend allowlisting rejects same-entry loops, arbitrary domains, unsafe URLs and unbounded node metadata', () => {
  const config = gatewayConfig({ version: 1, origin: 'https://desk.example.test', backendZone: 'example.test' });
  for (const url of [config.origin, 'http://node.example.test', 'https://arbitrary.test', 'https://node.example.test/path', 'https://user:password@node.example.test', 'https://127.0.0.1']) assert.throws(() => gatewayBackend(url, config));
  assert.throws(() => gatewayNode({ ...entry(1), name: 'x'.repeat(49) }, config)); assert(gatewayHex(entry(1).id)); assert.equal(gatewayProxyHeaders({ id: entry(1).id, secret: key(1) }, config.origin)['x-codex-gateway-node'], entry(1).id);
});

test('logout during readiness cancels selection before its atomic commit', async () => {
  let release, entered, hold = false; const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = await setup({ probe: async () => { if (hold) { entered(); await waiting; } return true; } }); await h.register(entry(1), key(1), h.codeValue.key);
  hold = true; const changing = h.select(entry(1).id); await started; assert.equal((await h.api('logout', { method: 'POST', body: {} })).status, 200);
  release(); assert.equal((await changing).status, 401); assert.equal(h.storage.value.activeId, null); assert.equal(h.storage.value.pending, null);
});

test('the dynamic registry admits more than sixty-four nodes while bounding state, codes and sessions', async () => {
  const h = await setup();
  for (let number = 1; number <= 70; number++) assert.equal((await h.register(entry(number), key(number), h.codeValue.key)).status, 200);
  const lastPage = await (await h.api('nodes?offset=64')).json();
  assert.equal(lastPage.total, 70); assert.equal(lastPage.nodes.length, 6); assert.equal(lastPage.next, null);
  assert.equal((await h.select(entry(70).id)).status, 200);
  for (const offset of ['-1', '1.5', '9007199254740992']) assert.equal((await h.api('nodes?offset=' + offset)).status, 400);
  for (let number = 1; number < GATEWAY_LIMITS.codes; number++) await h.code();
  assert.equal((await h.api('codes', { method: 'POST', body: { name: 'overflow' } })).status, 429);
  for (let number = 0; number < 10; number++) await h.login();
  assert.equal(h.storage.value.sessions.length, GATEWAY_LIMITS.sessions); assert(Buffer.byteLength(JSON.stringify(h.storage.value)) <= GATEWAY_LIMITS.bytes);
});
