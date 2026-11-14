import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture } from './fixture.mjs';
import { createForwardMux } from '../panel/forward-mux.mjs';

const until = async probe => { const end = Date.now() + 5000; while (!await probe()) { if (Date.now() > end) throw Error('pool test deadline'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const frame = (op, id, bytes = '') => { const body = Buffer.from(bytes), result = Buffer.alloc(5 + body.length); result[0] = op; result.writeUInt32BE(id, 1); body.copy(result, 5); return result; };
async function post(app, path, body) {
  const response = await app.request('/api/forward/agents/' + path, { method: 'POST', body });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
function socket(app, path, token, instance, protocol = 'codex-forward-v1', extra = {}) {
  const url = new URL(app.entryPath(path), app.config.origin); url.protocol = 'ws:';
  const ws = new WebSocket(url, protocol, { headers: { origin: app.config.origin, authorization: 'Bearer ' + token, 'x-codex-agent-instance': instance, 'x-codex-forward-node': app.config.nodeId, ...extra } });
  ws.on('error', () => {}); return ws;
}
async function agent(app, slot = 0) {
  const list = await (await app.request('/api/forward/agents')).json(), item = list.agents[slot];
  const key = await (await app.request('/api/forward/agents/key?id=' + item.id)).json();
  const grant = JSON.parse(Buffer.from(key.key.slice(6), 'base64url')), instance = String(slot + 1).repeat(32);
  const ws = socket(app, '/forward/agent', grant.agent + '.' + grant.secret, instance, 'codex-agent-v2');
  const messages = []; ws.on('message', bytes => { if (messages.length < 64) messages.push(JSON.parse(bytes)); });
  await once(ws, 'open'); await until(() => messages.some(value => value.type === 'agent-ready'));
  assert.equal(messages[0].transportProtocol, 1);
  return { ...item, grant, instance, ws, messages };
}
async function pool(app, helper, extra = {}) {
  const ws = socket(app, '/forward/transport', helper.grant.agent + '.' + helper.grant.secret, helper.instance, 'codex-forward-pool-v1', extra);
  const packets = [], received = new Map(); let next = 0;
  ws.on('message', (bytes, binary) => {
    if (!binary) {
      const value = JSON.parse(bytes);
      if (value.type === 'pool-ping') ws.send(JSON.stringify({ type: 'pool-pong', id: value.id }));
      if (packets.length < 256) packets.push(value); return;
    }
    const op = bytes[0], id = bytes.readUInt32BE(1), data = bytes.subarray(5);
    if (op === 1 && JSON.parse(data).type === 'ack') return;
    if (op === 1 || op === 2) {
      const sequence = (received.get(id) || 0) + 1; received.set(id, sequence);
      ws.send(frame(1, id, JSON.stringify({ type: 'ack', id: sequence })));
    }
    if (packets.length < 256) packets.push({ op, id, data });
  });
  await once(ws, 'open'); await until(() => packets.some(value => value.type === 'pool-ping'));
  return { ws, packets, async open(mapping, token, additions = {}) {
    const id = ++next; ws.send(frame(4, id)); await until(() => packets.some(value => value.op === 5 && value.id === id));
    ws.send(frame(1, id, JSON.stringify({ type: 'open', mapping, token, ...additions }))); return id;
  }, async echo(id, text) {
    ws.send(frame(2, id, text)); await until(() => packets.some(value => value.op === 2 && value.id === id && value.data.toString() === text));
  } };
}
async function rule(app, helper, targetPort, localPort) {
  const result = await post(app, 'rule', { agentId: helper.id, name: '独立规则' + localPort, enabled: true, config: { targetHost: '127.0.0.1', targetPort, localPort } });
  await until(() => helper.messages.some(message => message.type === 'rules' && message.rules.some(value => value.id === result.id)));
  const grant = helper.messages.filter(message => message.type === 'rules').at(-1).rules.find(value => value.id === result.id);
  const ws = socket(app, '/forward/helper', grant.code, helper.instance, 'codex-forward-v1', { 'x-codex-forward-resume': '1', 'x-codex-forward-keep-streams': '1', 'x-codex-forward-pool': '1' });
  const packets = []; ws.on('message', bytes => packets.push(JSON.parse(bytes)));
  await once(ws, 'open'); await until(() => packets.some(value => value.type === 'ready'));
  const ready = packets[0]; assert.equal(ready.poolProtocol, 1); assert.equal(ready.directProtocol, 0);
  ws.send('{"type":"listening"}'); await until(() => packets.some(value => value.type === 'listening'));
  return { ...result, ws, ready };
}

test('helper path preference uses repeated RTT samples, keeps its healthy peer during cooldown and ignores an unavailable WSS', async () => {
  let options, destroyed = 0;
  const app = await fixture({ webrtc: true, forwardPorts: '*', forwardPeerFactory: value => {
    options = value; return { state: { available: true }, streams: 0, async answer(offer) { return offer.sdp; }, async destroy() { destroyed++; value.closed(); } };
  } }); const clients = [];
  try {
    await app.login(); await app.claim(); const helper = await agent(app); clients.push(helper.ws);
    const mapping = await rule(app, helper, 22, 22001); clients.push(mapping.ws);
    const transport = await pool(app, helper); clients.push(transport.ws);
    const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=candidate:1 1 udp 123 127.0.0.1 40048 typ host', ''].join('\r\n');
    await until(() => transport.packets.filter(value => value.type === 'pool-ping').length >= 2);
    // The offer follows pong 2 on the same ordered socket. Waiting for the
    // server's offer handler then proves both RTT samples were processed.
    transport.ws.send(JSON.stringify({ type: 'rtc_offer', id: 1, sdp })); await until(() => !!options);
    // Keep the degraded path slower than the bounded loopback samples even
    // when other integration tests briefly stall this process.
    assert.equal(options.prefer(20000), true); assert.equal(options.prefer(20000), true); assert.equal(options.prefer(20000), false);
    for (let i = 0; i < 10; i++) assert.equal(options.prefer(0), false, 'cooldown prevents route oscillation');
    transport.ws.terminate(); await until(() => options.prefer(0));
    assert.equal(destroyed, 0); assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
  } finally { for (const ws of clients) ws.terminate(); await app.close(); }
});

test('pooled WSS isolates rule capabilities and revocation, never dials targets during preflight, and survives agent-control loss', async () => {
  const app = await fixture({ forwardPorts: '*' }), clients = [], targets = new Set(); let accepted = 0;
  const echo = net.createServer(tcp => { accepted++; targets.add(tcp); tcp.on('error', () => {}); tcp.once('close', () => targets.delete(tcp)); tcp.pipe(tcp); });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  try {
    await app.login(); await app.claim();
    const a = await agent(app), b = await agent(app, 1); clients.push(a.ws, b.ws);
    const first = await rule(app, a, echo.address().port, 22001), second = await rule(app, a, echo.address().port, 22002); clients.push(first.ws, second.ws);
    const transport = await pool(app, a), other = await pool(app, b); clients.push(transport.ws, other.ws);
    assert.equal(accepted, 0, 'warming a standby must not reach business targets');
    const one = await transport.open(first.ready.id, first.ready.streamToken), two = await transport.open(second.ready.id, second.ready.streamToken);
    await transport.echo(one, '正向规则一'); await transport.echo(two, '正向规则二'); assert.equal(accepted, 2);
    const forged = await transport.open(second.ready.id, first.ready.streamToken);
    await until(() => transport.packets.some(value => value.op === 3 && value.id === forged));
    const crossHelper = await other.open(first.ready.id, first.ready.streamToken);
    await until(() => other.packets.some(value => value.op === 3 && value.id === crossHelper));
    assert.equal(accepted, 2, 'a pool cannot borrow another rule/helper grant');
    a.ws.terminate(); await until(() => a.ws.readyState === 3);
    await transport.echo(two, '管理掉线不影响共享数据');
    await post(app, 'rule/remove', { agentId: a.id, id: first.id, revision: first.revision });
    await until(() => transport.packets.some(value => value.op === 3 && value.id === one));
    await transport.echo(two, '删除规则不影响其他流'); assert.equal(transport.ws.readyState, 1);
    await post(app, 'rekey', { id: a.id, revision: a.keyRevision });
    await until(() => transport.ws.readyState === 3); assert.equal(other.ws.readyState, 1);
    assert.equal(accepted, 2); assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
  } finally { for (const ws of clients) ws.terminate(); for (const tcp of targets) tcp.destroy(); await new Promise(resolve => echo.close(resolve)); await app.close(); }
});

test('pooled transport requires the enrolled instance, correct node/Origin and one physical WSS per helper', async () => {
  const app = await fixture({ nodeId: 'a'.repeat(32), entryBasePath: '/node/pool-test/' }), clients = [];
  async function rejected(helper, extra, status, reason) {
    const ws = socket(app, '/forward/transport', helper.grant.agent + '.' + helper.grant.secret, helper.instance, 'codex-forward-pool-v1', extra); clients.push(ws);
    const [, response] = await once(ws, 'unexpected-response'); assert.equal(response.statusCode, status);
    if (reason) assert.equal(response.headers['x-codex-forward-error'], reason);
    response.resume(); ws.terminate();
  }
  try {
    await app.login(); await app.claim();
    const slots = await (await app.request('/api/forward/agents')).json();
    const key = await (await app.request('/api/forward/agents/key?id=' + slots.agents[0].id)).json();
    const grant = JSON.parse(Buffer.from(key.key.slice(6), 'base64url'));
    await rejected({ grant, instance: '1'.repeat(32) }, {}, 409, 'helper_reconnecting');
    const a = await agent(app); clients.push(a.ws);
    await rejected(a, { 'x-codex-agent-instance': 'f'.repeat(32) }, 409);
    await rejected(a, { 'x-codex-forward-node': 'b'.repeat(32) }, 409);
    await rejected(a, { origin: 'https://foreign.example' }, 403);
    const active = await pool(app, a); clients.push(active.ws);
    await rejected(a, {}, 409);
    // Reusing a stream identifier closes this WSS instead of reusing a grant.
    active.ws.send(frame(4, 1)); await until(() => active.packets.some(value => value.op === 5 && value.id === 1));
    active.ws.send(frame(4, 1)); await until(() => active.ws.readyState === 3);
    const replacement = await pool(app, a); clients.push(replacement.ws); assert.equal(replacement.ws.readyState, 1);
  } finally { for (const ws of clients) ws.terminate(); await app.close(); }
});

test('one paused or over-credit WSS stream cannot block or close another rule on the shared connection', async () => {
  const packets = [], sockets = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(bytes, callback) { packets.push(bytes); callback?.(); }, terminate() { assert.fail('one stream must not terminate the physical WSS'); }, pause() { assert.fail('one stream must not pause the physical WSS'); } };
  const mux = createForwardMux(ws, { valid: () => true, healthy: () => true, connect(socket, record) {
    sockets.push(socket);
    if (record.slow) socket.pause();
    else socket.on('message', data => socket.send(data));
  } });
  try {
    mux.receive(frame(4, 1)); mux.receive(frame(1, 1, '{"slow":true}'));
    mux.receive(frame(4, 2)); mux.receive(frame(1, 2, '{}'));
    for (let i = 0; i < 3; i++) mux.receive(frame(2, 1, 'slow'));
    mux.receive(frame(2, 2, 'fast'));
    await new Promise(resolve => setImmediate(resolve));
    assert(packets.some(bytes => bytes[0] === 2 && bytes.readUInt32BE(1) === 2 && bytes.subarray(5).toString() === 'fast'));
    mux.receive(frame(2, 1, 'over-credit'));
    assert.equal(sockets[0].readyState, 3); assert.equal(sockets[1].readyState, 1);
    assert.equal(mux.streams, 1);
  } finally { mux.close(); }
});

test('shared WSS serializes writes, prioritizes a new preflight over bulk backlog, and keeps FIN after its own data', async () => {
  const packets = [], callbacks = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(bytes, callback) { assert.equal(callbacks.length, 0, 'only one physical data write'); packets.push(bytes); callbacks.push(callback); }, terminate() { assert.fail('bounded backlog must apply backpressure'); } };
  const mux = createForwardMux(ws, { valid: () => true, healthy: () => true, connect(socket) {
    socket.send(Buffer.alloc(16384, 1)); socket.send(Buffer.alloc(16384, 2)); socket.send('{"type":"fin"}');
  } });
  const complete = async () => { const callback = callbacks.shift(); assert(callback); callback(); await Promise.resolve(); };
  try {
    mux.receive(frame(4, 1)); await complete();
    mux.receive(frame(1, 1, '{}')); // First bulk frame remains physically blocked.
    mux.receive(frame(4, 2));
    for (let i = 0; i < 8 && !packets.some(bytes => bytes[0] === 5 && bytes.readUInt32BE(1) === 2); i++) await complete();
    const preflight = packets.findIndex(bytes => bytes[0] === 5 && bytes.readUInt32BE(1) === 2);
    assert(preflight >= 0);
    assert.equal(packets.filter(bytes => bytes[0] === 2).length, 1, 'preflight must precede the second queued bulk frame');
    mux.receive(frame(1, 2, '{}'));
    for (let i = 0; callbacks.length && i < 20; i++) await complete();
    for (const id of [1, 2]) {
      const own = packets.filter(bytes => bytes.readUInt32BE(1) === id);
      const data = own.filter(bytes => bytes[0] === 2); assert.equal(data.length, 2);
      assert.equal(data[0][5], 1); assert.equal(data[1][5], 2);
      const fin = own.findIndex(bytes => bytes[0] === 1 && bytes.subarray(5).toString() === '{"type":"fin"}');
      assert(fin > own.lastIndexOf(data[1]), 'FIN cannot overtake business bytes');
    }
  } finally { mux.close(); }
});
