import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture } from './fixture.mjs';
import { agentInventory } from '../panel/forward-agents.mjs';

const decode = key => JSON.parse(Buffer.from(key.slice(6), 'base64url'));
const until = async probe => { const end = Date.now() + 6000; while (!await probe()) { if (Date.now() > end) throw Error('condition deadline'); await new Promise(r => setTimeout(r, 20)); } };
const post = async (app, path, body) => { const r = await app.request('/api/forward/agents/' + path, { method: 'POST', body }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const list = async app => (await app.request('/api/forward/agents')).json();
const slot = async (app, number = 1) => { const agent = (await list(app)).agents[number - 1]; return { ...agent, ...await (await app.request('/api/forward/agents/key?id=' + agent.id)).json() }; };

async function connect(app, key, instance = '1'.repeat(32), extra = {}) {
  const grant = decode(key), messages = [], url = new URL('/forward/agent', app.config.origin);
  url.protocol = 'ws:'; url.pathname = (app.config.entryBasePath === '/' ? '' : app.config.entryBasePath.replace(/\/$/, '')) + '/forward/agent';
  const ws = new WebSocket(url, 'codex-agent-v2', { headers: { origin: app.config.origin, authorization: 'Bearer ' + grant.agent + '.' + grant.secret, 'x-codex-agent-instance': instance, ...(grant.node ? { 'x-codex-forward-node': grant.node } : {}), ...extra } });
  ws.on('error', () => {}); ws.on('message', bytes => { if (messages.length < 64) messages.push(JSON.parse(bytes)); });
  await once(ws, 'open'); await until(() => messages.some(m => m.type === 'agent-ready'));
  return { ws, messages, async rules(count) { await until(() => messages.some(m => m.type === 'rules' && m.rules.length === count)); return messages.filter(m => m.type === 'rules').at(-1).rules; } };
}
const rule = (agentId, port = 2222) => ({ agentId, name: '路由器', enabled: true, config: { direction: 'reverse', protocol: 'ssh', deviceName: '路由器', localPort: port, targetHost: '192.168.1.1', targetPort: 22 } });

test('multiple managed helpers receive only their own dynamic rules; revocation and stale edits are isolated', async () => {
  const app = await fixture(); const connections = [];
  try {
    await app.login(); await app.claim();
    const a = await slot(app), b = await slot(app, 2);
    const ca = await connect(app, a.key), cb = await connect(app, b.key, '2'.repeat(32)); connections.push(ca.ws, cb.ws);
    const ar = await post(app, 'rule', rule(a.id)), br = await post(app, 'rule', rule(b.id, 22002));
    const [am] = await ca.rules(1), [bm] = await cb.rules(1);
    assert.equal(am.id, ar.id); assert.equal(bm.id, br.id); assert.notEqual(am.code, bm.code);
    await post(app, 'visibility', { id: a.id, revision: a.visibilityRevision, visible: true });
    await post(app, 'visibility', { id: a.id, revision: a.visibilityRevision + 1, visible: false });
    assert.equal(ca.ws.readyState, 1); assert.equal((await slot(app)).key, a.key);
    assert.equal((await list(app)).agents[0].rules[0].mapping.id, am.mappingId);
    const state = await list(app); assert(state.agents.slice(0, 2).every(a => a.online));
    assert(!JSON.stringify(state).includes(am.code)); assert(!JSON.stringify(state).includes(decode(a.key).secret));
    assert.equal((await (await app.request('/api/forward')).json()).managedHelpersProtocol, 2);
    const rejected = await app.request('/api/forward/agents/rule', { method: 'POST', body: { ...rule(a.id, 22003), id: ar.id, revision: 0 } }); assert.equal(rejected.status, 409);
    await post(app, 'rule/remove', { agentId: a.id, id: ar.id, revision: ar.revision });
    await until(() => ca.messages.some(m => m.type === 'rules' && !m.rules.length));
    assert.equal((await list(app)).agents.find(a => a.id === b.id).rules[0].id, br.id);
    await post(app, 'rekey', { id: a.id, revision: a.keyRevision }); await until(() => ca.ws.readyState === 3);
    assert.equal(cb.ws.readyState, 1); assert.equal((await list(app)).agents.length, 8);
    assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
  } finally { for (const ws of connections) ws.terminate(); await app.close(); }
});

test('serial and IPv4 inventory is read-only, scoped to its helper and remains available as dated last-known information', async () => {
  const app = await fixture(); let connection;
  try {
    await app.login(); await app.claim(); const a = await slot(app); connection = await connect(app, a.key);
    const inventory = { type: 'inventory', serialPorts: ['COM3', 'COM8'], interfaces: [{ name: '以太网', index: 1, up: true, error: false, addresses: [{ address: '192.168.1.23', prefix: 24 }, { address: '10.0.0.23', prefix: 8 }] }, { name: '停用网卡', index: 2, up: false, error: false, addresses: [] }], error: '', truncated: false };
    connection.ws.send(JSON.stringify(inventory));
    await until(async () => (await list(app)).agents[0].inventory?.interfaces.length === 2);
    let value = (await list(app)).agents[0]; assert.equal(value.inventory.serialPorts[1], 'COM8'); assert.equal(value.inventory.interfaces[0].addresses.length, 2);
    assert(value.inventory.updatedAt); assert.deepEqual(app.inputCalls, []);
    connection.ws.terminate(); await until(async () => !(await list(app)).agents[0].online);
    value = (await list(app)).agents[0]; assert.equal(value.inventory.interfaces[0].name, '以太网');
  } finally { connection?.ws.terminate(); await app.close(); }
});

test('reconnecting the same helper control preserves its mapping identity and browser logout does not revoke the long-lived grant', async () => {
  const app = await fixture(); let connection, resumed, mapping;
  try {
    await app.login(); await app.claim(); const a = await slot(app);
    connection = await connect(app, a.key);
    await post(app, 'rule', { agentId: a.id, name: 'SSH', enabled: true, config: { localPort: 2222, targetHost: '127.0.0.1', targetPort: 22 } });
    const [original] = await connection.rules(1), packets = [];
    mapping = new WebSocket(app.config.origin.replace('http:', 'ws:') + '/forward/helper', 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + original.code, 'x-codex-forward-resume': '1', 'x-codex-forward-keep-streams': '1' } });
    mapping.on('error', () => {}); mapping.on('message', bytes => packets.push(JSON.parse(bytes)));
    await once(mapping, 'open'); await until(() => packets.some(m => m.type === 'ready'));
    mapping.send(JSON.stringify({ type: 'listening' })); await until(async () => (await list(app)).agents[0].rules[0].state === 'active');
    connection.ws.terminate(); await until(async () => !(await list(app)).agents[0].online);
    resumed = await connect(app, a.key);
    const [after] = await resumed.rules(1); assert.equal(after.mappingId, original.mappingId); assert.equal(mapping.readyState, 1);
    assert.equal((await app.request('/api/logout', { method: 'POST', body: {} })).status, 200);
    assert.equal(mapping.readyState, 1); assert.equal(resumed.ws.readyState, 1);
    resumed.ws.close(1000, 'client_stopping'); await until(() => mapping.readyState === 3);
  } finally { connection?.ws.terminate(); resumed?.ws.terminate(); mapping?.terminate(); await app.close(); }
});

test('managed configuration requires full administrator access, CSRF and the correct node identity', async () => {
  const app = await fixture({ nodeId: 'a'.repeat(32), entryBasePath: '/node/office/' }); let connection;
  try {
    await app.login(); await app.claim();
    assert.equal((await app.request('/api/forward/agents/rekey', { method: 'POST', body: { name: 'A' }, headers: { 'x-csrf-token': '' } })).status, 403);
    assert.equal((await app.request('/api/forward/agents/rekey', { method: 'POST', body: { name: 'A' }, headers: { origin: 'https://other.example' } })).status, 403);
    const a = await slot(app); assert.equal(decode(a.key).server, app.config.origin + '/node/office/');
    await assert.rejects(connect(app, a.key, '1'.repeat(32), { 'x-codex-forward-node': 'b'.repeat(32) }), /409/);
    connection = await connect(app, a.key);
    await assert.rejects(connect(app, a.key, '2'.repeat(32)), /409/);
    assert.equal(connection.ws.readyState, 1);
    // A half-open connection from this same process must remain retryable;
    // another computer receives a terminal rejection without evicting it.
    const grant = decode(a.key);
    for (const [instance, expected] of [['1'.repeat(32), 'resume_busy'], ['2'.repeat(32), 'agent_already_connected']]) {
      const attempt = new WebSocket(app.config.origin.replace('http:', 'ws:') + '/node/office/forward/agent', 'codex-agent-v2', { headers: { origin: app.config.origin, authorization: 'Bearer ' + grant.agent + '.' + grant.secret, 'x-codex-agent-instance': instance, 'x-codex-forward-node': grant.node } });
      attempt.on('error', () => {});
      const [, response] = await once(attempt, 'unexpected-response'); response.resume(); attempt.terminate();
      assert.equal(response.statusCode, 409); assert.equal(response.headers['x-codex-forward-error'], expected);
      assert.equal(connection.ws.readyState, 1);
    }
    const replacement = await post(app, 'rekey', { id: a.id, revision: a.keyRevision }); await until(() => connection.ws.readyState === 3);
    await assert.rejects(connect(app, a.key), /401/);
    connection = await connect(app, replacement.key);
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'visitor-test-password', durationMs: 3600000 } });
    const response = await app.request('/api/login', { method: 'POST', body: { username: 'visitor', password: 'visitor-test-password' } });
    assert.equal(response.status, 200); const guest = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request('/api/forward/agents', { headers: { cookie } })).status, 403);
    assert.equal((await app.request('/api/forward/agents/create', { method: 'POST', body: { name: 'forbidden' }, headers: { cookie, 'x-csrf-token': guest.csrf } })).status, 403);
    assert.equal((await fetch(app.config.origin + '/node/office/api/forward/agents')).status, 401);
  } finally { connection?.ws.terminate(); await app.close(); }
});

test('inventory rejects file paths, control characters, IPv6 injection and unbounded NIC data', () => {
  const value = { type: 'inventory', serialPorts: [], interfaces: [], truncated: false, error: '' };
  assert.deepEqual(agentInventory(value).interfaces, []);
  assert.throws(() => agentInventory({ ...value, serialPorts: ['/etc/passwd'] }));
  const nic = { name: 'eth0', index: 1, up: true, error: false, addresses: [{ address: '::1', prefix: 24 }] };
  assert.throws(() => agentInventory({ ...value, interfaces: [nic] }));
  assert.throws(() => agentInventory({ ...value, interfaces: [{ ...nic, name: '\u001b[31m', addresses: [] }] }));
  assert.throws(() => agentInventory({ ...value, interfaces: Array(129).fill({ ...nic, addresses: [] }) }));
});

test('batch rule failures coalesce policy snapshots and oversized inventory cannot replace the last bounded snapshot', async () => {
  const app = await fixture(); let connection;
  try {
    await app.login(); await app.claim(); const a = await slot(app); connection = await connect(app, a.key);
    for (let i = 0; i < 16; i++) await post(app, 'rule', { agentId: a.id, name: '规则 ' + i, enabled: true, config: { localPort: 2222 + i, targetHost: '127.0.0.1', targetPort: 22 } });
    const rules = await connection.rules(16), before = connection.messages.filter(m => m.type === 'rules').length;
    for (const rule of rules) connection.ws.send(JSON.stringify({ type: 'rule-result', id: rule.id, mappingId: rule.mappingId, revision: rule.revision, error: 'serial_open_failed' }));
    await until(() => connection.messages.filter(m => m.type === 'rules').length > before && connection.messages.filter(m => m.type === 'rules').at(-1).rules.length === 0);
    assert.equal(connection.messages.filter(m => m.type === 'rules').length - before, 1);
    assert.equal(connection.ws.readyState, 1); assert((await list(app)).agents[0].rules.every(r => r.state === 'failed'));
    const inventory = { type: 'inventory', serialPorts: [], interfaces: [], truncated: false, error: '' };
    connection.ws.send(JSON.stringify(inventory)); await until(async () => !!(await list(app)).agents[0].inventory);
    const previous = (await list(app)).agents[0].inventory;
    // Valid JSON and under the 48 KiB WS limit, but over the inventory bound.
    const tooLarge = JSON.stringify(inventory).replace('"interfaces":[]', '"interfaces":[' + ' '.repeat(33 * 1024) + ']');
    connection.ws.send(tooLarge); await until(() => connection.ws.readyState === 3);
    assert.deepEqual((await list(app)).agents[0].inventory, previous);
  } finally { connection?.ws.terminate(); await app.close(); }
});

test('fixed slot APIs expose keys only to full administrators and retire creation, deletion and one-time grants', async t => {
  const app = await fixture(); t.after(() => app.close());
  assert.equal((await app.request('/api/forward/agents/key?id=' + 'a'.repeat(32))).status, 401);
  await app.login(); await app.claim(); const state = await list(app);
  assert.equal(state.agents.length, 8); assert.deepEqual(state.agents.map(a => a.slot), [1,2,3,4,5,6,7,8]);
  const a = await slot(app); assert.equal((await slot(app)).key, a.key); assert(!JSON.stringify(state).includes(decode(a.key).secret));
  for (const path of ['/api/forward', '/api/forward/stop', '/api/forward/hints', '/api/forward/devices', '/api/forward/agents/create', '/api/forward/agents/remove']) {
    assert.equal((await app.request(path, { method: 'POST', body: {} })).status, 404, path);
  }
  assert.equal((await app.request('/api/forward/agents/key?id=' + a.id + '&id=' + a.id)).status, 400);
});
