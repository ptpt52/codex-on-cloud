import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { WebSocket } from 'ws';
import { fixture } from './fixture.mjs';
import { AGENT_CONTROL_TIMEOUT_MS } from '../panel/forward-agents.mjs';

const capabilities = { 'x-codex-forward-resume': '1', 'x-codex-forward-keep-streams': '1', 'x-codex-forward-reverse': '1' };
async function until(probe) {
  const deadline = performance.now() + 4000;
  while (!await probe()) { if (performance.now() > deadline) throw Error('managed policy deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const listing = async app => (await app.request('/api/forward/agents')).json();
async function post(app, path, body) {
  const response = await app.request('/api/forward/agents/' + path, { method: 'POST', body });
  assert.equal(response.status, 200); return response.json();
}
async function open(t, app, path, token, headers = {}, protocol = 'codex-forward-v1') {
  const ws = new WebSocket(app.config.origin.replace('http:', 'ws:') + path, protocol, { headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...headers } });
  t.after(() => ws.terminate()); ws.on('error', () => {});
  const records = [];
  ws.on('message', (bytes, binary) => { assert(records.length < 128); records.push({ value: binary ? bytes : JSON.parse(bytes), binary }); });
  await once(ws, 'open'); return { ws, records };
}
async function control(t, app, slot = 0) {
  const agent = (await listing(app)).agents[slot], key = await (await app.request('/api/forward/agents/key?id=' + agent.id)).json();
  const grant = JSON.parse(Buffer.from(key.key.slice(6), 'base64url'));
  const link = await open(t, app, '/forward/agent', grant.agent + '.' + grant.secret, { 'x-codex-agent-instance': String(slot + 1).repeat(32) }, 'codex-agent-v2');
  await until(() => link.records.some(r => r.value.type === 'agent-ready')); return { ...link, agent };
}
async function rules(link, count) {
  await until(() => link.records.some(r => r.value.type === 'rules' && r.value.rules.length === count));
  return link.records.filter(r => r.value.type === 'rules').at(-1).value.rules;
}
async function mapping(t, app, rule) {
  const link = await open(t, app, '/forward/helper', rule.code, capabilities);
  await until(() => link.records.some(r => r.value.type === 'ready'));
  const ready = link.records.find(r => r.value.type === 'ready').value;
  link.ws.send('{"type":"listening"}'); await until(() => link.records.some(r => r.value.type === 'listening'));
  return { ...link, ready };
}
async function data(t, app, current, reverse = false) {
  let tcp, chunks = [], extra = {};
  if (reverse) {
    tcp = net.connect(current.ready.localPort, '127.0.0.1'); tcp.on('error', () => {}); t.after(() => tcp.destroy());
    tcp.on('data', bytes => { assert(Buffer.concat(chunks).length + bytes.length <= 65536); chunks.push(bytes); });
    await once(tcp, 'connect'); await until(() => current.records.some(r => r.value.type === 'reverse_open'));
    extra = { 'x-codex-reverse-stream': current.records.find(r => r.value.type === 'reverse_open').value.id };
  }
  const link = await open(t, app, '/forward/data', current.ready.streamToken, extra);
  await until(() => link.records.some(r => r.value.type === 'ready'));
  if (reverse) {
    link.ws.on('message', (bytes, binary) => { if (binary) link.ws.send(bytes, { binary: true }); });
    link.ws.send('{"type":"target_ready"}');
  }
  return { ...link, tcp, async exchange(text) {
    const before = reverse ? Buffer.concat(chunks).length : link.records.filter(r => r.binary).length;
    if (reverse) tcp.write(text); else link.ws.send(Buffer.from(text), { binary: true });
    await until(() => reverse ? Buffer.concat(chunks).length >= before + Buffer.byteLength(text) : link.records.filter(r => r.binary).length > before);
    const received = reverse ? Buffer.concat(chunks).subarray(before) : Buffer.concat(link.records.filter(r => r.binary).slice(before).map(r => r.value));
    assert.equal(received.toString(), text);
  } };
}
async function echo(t) {
  const peers = new Set(), server = net.createServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket)); socket.pipe(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function denied(t, app, path, token, headers = {}) {
  const ws = new WebSocket(app.config.origin.replace('http:', 'ws:') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...headers } });
  t.after(() => ws.terminate()); ws.on('error', () => {});
  const status = await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.once('open', () => { ws.terminate(); reject(Error('retired mapping accepted authorization')); });
  });
  assert.equal(status, 401);
}
async function change(app, operation, agentId, rule, targetPort) {
  return operation === 'delete' ? post(app, 'rule/remove', { agentId, id: rule.id, revision: rule.revision }) :
    post(app, 'rule', { agentId, id: rule.id, revision: rule.revision, name: rule.name, enabled: operation !== 'disable', config: { ...rule.config, ...(operation === 'edit' ? { targetPort } : {}) } });
}

for (const reverse of [false, true]) for (const operation of ['disable', 'edit', 'delete']) {
  test(`offline helper ${operation} revokes ${reverse ? 'reverse' : 'forward'} streams and leaves unrelated rules intact`, { timeout: 15000 }, async t => {
    const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close()); await app.login(); await app.claim();
    const targetPort = await echo(t), nextPort = await echo(t), a = await control(t, app), b = await control(t, app, 1);
    const config = { localPort: reverse ? await freePort() : 2222, targetHost: '127.0.0.1', targetPort,
      ...(reverse ? { direction: 'reverse', protocol: 'tcp', deviceName: 'device' } : {}) };
    const first = await post(app, 'rule', { agentId: a.agent.id, name: 'changed', enabled: true, config });
    await post(app, 'rule', { agentId: a.agent.id, name: 'same helper', enabled: true, config: { localPort: 2223, targetPort } });
    await post(app, 'rule', { agentId: b.agent.id, name: 'other helper', enabled: true, config: { localPort: 2223, targetPort } });
    const ar = await rules(a, 2), br = await rules(b, 1), original = ar.find(r => r.id === first.id), unchanged = ar.find(r => r.id !== first.id);
    const current = await mapping(t, app, original), same = await mapping(t, app, unchanged), other = await mapping(t, app, br[0]);
    const live = await data(t, app, current, reverse), sameData = await data(t, app, same), otherData = await data(t, app, other);
    await live.exchange('before'); a.ws.terminate(); await until(async () => !(await listing(app)).agents[0].online);
    await live.exchange('control offline');
    const stale = await app.request('/api/forward/agents/rule/remove', { method: 'POST', body: { agentId: a.agent.id, id: first.id, revision: 0 } });
    assert.equal(stale.status, 409); await live.exchange('rejected edit preserves data');
    const updated = await change(app, operation, a.agent.id, first, nextPort);
    await until(() => live.ws.readyState === WebSocket.CLOSED && current.ws.readyState === WebSocket.CLOSED && (!live.tcp || live.tcp.destroyed));
    const saved = (await listing(app)).agents[0].rules.find(r => r.id === first.id);
    if (operation === 'delete') assert.equal(saved, undefined);
    else { assert.equal(saved.mapping, null); assert.equal(saved.state, operation === 'disable' ? 'disabled' : 'offline'); }
    await denied(t, app, '/forward/data', current.ready.streamToken);
    await denied(t, app, '/forward/resume', current.ready.resumeToken, capabilities);
    await denied(t, app, '/forward/helper', original.code, capabilities);
    if (reverse) {
      const portCheck = net.createServer(); await new Promise((resolve, reject) => { portCheck.once('error', reject); portCheck.listen(config.localPort, '127.0.0.1', resolve); });
      await new Promise(resolve => portCheck.close(resolve));
    }
    await sameData.exchange('same helper preserved'); await otherData.exchange('other helper preserved');
    const resumed = await control(t, app), next = await rules(resumed, operation === 'edit' ? 2 : 1);
    assert.equal(next.find(r => r.id === unchanged.id).mappingId, unchanged.mappingId);
    if (operation === 'edit') {
      const fresh = next.find(r => r.id === first.id); assert.notEqual(fresh.mappingId, original.mappingId); assert.notEqual(fresh.code, original.code);
      const active = await mapping(t, app, fresh); assert.equal(active.ready.targetPort, nextPort); assert.equal(fresh.revision, updated.revision);
      await (await data(t, app, active, reverse)).exchange('new configuration');
    }
    await sameData.exchange('unchanged after reconnect'); await otherData.exchange('other helper after reconnect');
    assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
  });
}

for (const operation of ['disable', 'edit', 'delete']) test(`expired helper ${operation} invalidates an unused pairing grant`, { timeout: 10000 }, async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close()); await app.login(); await app.claim();
  const helper = await control(t, app), first = await post(app, 'rule', { agentId: helper.agent.id, name: 'pending', enabled: true, config: { localPort: 2222, targetPort: 22 } });
  const [original] = await rules(helper, 1), now = Date.now();
  t.mock.method(Date, 'now', () => now + AGENT_CONTROL_TIMEOUT_MS);
  try { assert.equal((await listing(app)).agents[0].online, false); } finally { t.mock.restoreAll(); }
  await change(app, operation, helper.agent.id, first, 23);
  await denied(t, app, '/forward/helper', original.code, capabilities);
  const saved = (await listing(app)).agents[0].rules.find(r => r.id === first.id);
  if (saved) assert.equal(saved.mapping, null);
  assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
});
