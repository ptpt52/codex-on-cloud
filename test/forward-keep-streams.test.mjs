import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { fixture } from './support/forward-transport.mjs';
import { FORWARD_LIMITS } from '../panel/forward.mjs';

const capability = { 'x-codex-forward-resume': '1', 'x-codex-forward-keep-streams': '1', 'x-codex-forward-reverse': '1' };
async function until(probe) {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('Keep-streams test deadline');
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function open(app, path, token, headers = {}) {
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', {
    headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
  const records = []; ws.on('error', () => {});
  ws.on('message', (bytes, binary) => { records.push(binary ? Buffer.from(bytes) : JSON.parse(bytes)); assert.ok(records.length < 64); });
  await once(ws, 'open'); return { ws, records };
}
async function denied(app, path, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', {
      headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on('open', () => { ws.terminate(); reject(Error('Unexpected data authorization')); });
  });
}
const status = async app => (await (await app.request('mapping')).json()).mappings[0];
async function control(app, path, token, direct = false) {
  const result = await open(app, path, token); await until(() => result.records.length === 1);
  result.ready = result.records[0]; result.ws.send(JSON.stringify({ type: 'listening', ...(direct ? { direct: 1 } : {}) })); await until(() => result.records.some(value => value.type === 'listening')); return result;
}

test('preserved peer health cannot interleave with a new control handshake or authorize new targets while offline', async t => {
  let captured, peer;
  const app = await fixture({ webrtc: true, forwardPorts: '*', forwardPeerFactory: options => {
    captured = options;
    return peer = { state: { id: options.id, available: true, healthy: true, reason: '', family: 'IPv4', rttMs: 1 }, streams: 1,
      async answer() { return 'test-answer'; }, async destroy() { options.closed(); } };
  } });
  t.after(() => app.close());
  const mapping = await (await app.request('mapping', { method: 'POST', body: { localPort: await freePort(), targetPort: 22 } })).json();
  const first = await control(app, '/forward/helper', mapping.code, true);
  first.ws.send(JSON.stringify({ type: 'rtc_offer', id: 1, sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), ''].join('\r\n') }));
  await until(() => first.records.some(value => value.type === 'rtc_answer'));
  const closed = once(first.ws, 'close'); first.ws.terminate(); await closed;
  await until(async () => (await status(app))?.state === 'recovering');
  assert.equal(captured.valid(), true); assert.equal(captured.authenticate(first.ready.streamToken), false);
  let refused = 0; captured.connect({ terminate() { refused++; } }); assert.equal(refused, 1);
  const next = await open(app, '/forward/resume', first.ready.resumeToken); await until(() => next.records.length === 1);
  captured.status(peer.state); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(next.records.length, 1, 'Peer status overtook the listening acknowledgement');
  next.ws.send('{"type":"listening","direct":1}'); await until(() => next.records.length === 4);
  assert.deepEqual(next.records.map(value => value.type), ['ready', 'listening', 'rtc_config', 'rtc_status']);
  assert.equal(captured.valid(), true); assert.equal(captured.authenticate(first.ready.streamToken), true);
  await app.request('stop', { method: 'POST', body: { id: mapping.id } }); assert.equal(captured.valid(), false);
});
async function setup(t, reverse, withPending = false) {
  const sockets = new Set(); let accepted = 0;
  const target = net.createServer(socket => { accepted++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.on('data', data => socket.write(data)); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const app = await fixture({ forwardPorts: '*', sessionMs: 60000 });
  t.after(async () => { await app.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); });

  const mapping = await (await app.request('mapping', { method: 'POST', body: {
    localPort: await freePort(), targetHost: '127.0.0.1', targetPort: target.address().port,
    ...(reverse ? { direction: 'reverse', deviceName: 'test-device' } : {}) } })).json();
  const first = await control(app, '/forward/helper', mapping.code);
  assert.equal(first.ready.keepStreamsProtocol, 1);
  let data, tcp, replies = [];
  if (reverse) {
    tcp = net.createConnection({ host: '127.0.0.1', port: mapping.localPort }); tcp.on('error', () => {}); t.after(() => tcp.destroy());
    tcp.on('data', bytes => replies.push(bytes)); await once(tcp, 'connect');
    await until(() => first.records.some(value => value.type === 'reverse_open'));
    const id = first.records.find(value => value.type === 'reverse_open').id;
    data = await open(app, '/forward/data', first.ready.streamToken, { 'x-codex-reverse-stream': id });
    await until(() => data.records.length === 1); data.ws.send('{"type":"target_ready"}');
  } else {
    data = await open(app, '/forward/data', first.ready.streamToken); await until(() => data.records.length === 1);
  }
  async function exchange(text) {
    if (reverse) { data.ws.send(Buffer.from(text)); await until(() => Buffer.concat(replies).toString().endsWith(text)); }
    else { data.ws.send(Buffer.from(text)); await until(() => Buffer.concat(data.records.filter(Buffer.isBuffer)).toString().endsWith(text)); }
  }
  await exchange('before');
  let pendingClosed;
  if (reverse && withPending) {
    const pending = net.createConnection({ host: '127.0.0.1', port: mapping.localPort }); pending.on('error', () => {}); t.after(() => pending.destroy());
    pendingClosed = once(pending, 'close'); await once(pending, 'connect');
    await until(() => first.records.filter(value => value.type === 'reverse_open').length === 2);
    assert.equal((await status(app)).connections, 2);
  }
  const closed = once(first.ws, 'close'); first.ws.terminate(); await closed;
  await until(async () => (await status(app))?.state === 'recovering');
  if (pendingClosed) await pendingClosed;
  return { app, mapping, first, data, tcp, exchange, accepted: () => accepted };
}

for (const reverse of [false, true]) {
  const direction = reverse ? 'reverse' : 'forward';
  test(`${direction}: healthy WSS bytes survive control loss and a partial resume; new connections pause and scope stays fixed`, async t => {
    const { app, mapping, first, data, exchange, accepted } = await setup(t, reverse, reverse);
    const before = await status(app); assert.equal(before.connections, 1); const deadline = before.recoverUntil;
    await exchange('while-offline'); assert.equal(data.ws.readyState, WebSocket.OPEN);
    assert.equal(await denied(app, '/forward/data', first.ready.streamToken), 401);
    assert.equal(await denied(app, '/forward/resume', first.ready.resumeToken, { 'x-codex-forward-keep-streams': '0' }), 400);
    if (reverse) {
      const blocked = net.createConnection({ host: '127.0.0.1', port: mapping.localPort }); blocked.on('error', () => {});
      await once(blocked, 'close'); assert.equal((await status(app)).connections, 1);
    }
    const partial = await open(app, '/forward/resume', first.ready.resumeToken); await until(() => partial.records.length === 1);
    await exchange('during-handshake'); const gone = once(partial.ws, 'close'); partial.ws.terminate(); await gone;
    await until(async () => (await status(app))?.state === 'recovering'); assert.equal((await status(app)).recoverUntil, deadline);
    const second = await control(app, '/forward/resume', first.ready.resumeToken);
    assert.equal(second.ready.id, mapping.id); assert.equal(second.ready.streamToken, first.ready.streamToken);
    assert.equal(second.ready.targetHost, first.ready.targetHost); assert.equal(second.ready.targetPort, first.ready.targetPort);
    await exchange('after-resume'); assert.equal(accepted(), reverse ? 0 : 1);
    assert.equal((await status(app)).connections, 1); assert.equal((await status(app)).recoverUntil, null);
    const json = JSON.stringify(await (await app.request('mapping')).json());
    for (const secret of [first.ready.streamToken, first.ready.resumeToken, mapping.code, 'streamToken', 'streamHash']) assert.equal(json.includes(secret), false);
    const ended = once(data.ws, 'close'); await app.request('stop', { method: 'POST', body: { id: mapping.id } }); await ended;
    assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []);
  });
  for (const reason of ['revoke', 'authorization-expired', 'resume-expired']) {
    test(`${direction}: preserved data is revoked on ${reason} during management recovery`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const { app, data, exchange } = await setup(t, reverse); await exchange('alive'); const ended = once(data.ws, 'close');
      if (reason === 'revoke') await app.request('revoke', { method: 'POST', body: {} });
      else { t.mock.timers.setTime(Date.now() + (reason === 'authorization-expired' ? 61000 : FORWARD_LIMITS.resumeMs + 1)); await app.request('mapping'); }
      await ended; assert.equal(data.ws.readyState, WebSocket.CLOSED);
    });
  }
}
