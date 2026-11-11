import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { fixture } from './support/forward-transport.mjs';
import { FORWARD_LIMITS } from '../panel/forward.mjs';

const capability = { 'x-codex-forward-resume': '1' };
async function until(probe) {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Recovery test deadline');
}
async function open(app, path, token, headers = {}) {
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', {
    headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
  const records = []; ws.on('error', () => {});
  ws.on('message', (bytes, binary) => { records.push(binary ? Buffer.from(bytes) : JSON.parse(bytes)); assert.ok(records.length <= 64); });
  await once(ws, 'open'); return { ws, records };
}
async function rejected(app, token, path = '/forward/resume', headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', {
      headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve({ status: response.statusCode, code: response.headers['x-codex-forward-error'] }); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected recovery authorization')); });
  });
}
const status = async app => (await (await app.request('mapping')).json());
async function create(app, localPort = 2222, targetHost = '127.0.0.1') {
  const response = await app.request('mapping', { method: 'POST', body: { localPort, targetHost, targetPort: app.config.forwardPorts[0] } });
  assert.equal(response.status, 200); return response.json();
}
async function connected(app, path, token, direct = false) {
  const control = await open(app, path, token); await until(() => control.records.length === 1);
  control.ready = control.records[0]; control.ws.send(JSON.stringify({ type: 'listening', ...(direct ? { direct: 1 } : {}) })); await until(() => control.records.length === (direct ? 3 : 2));
  return control;
}
async function suspend(app, control) {
  const closed = once(control.ws, 'close'); control.ws.terminate(); await closed;
  await until(async () => (await status(app)).mappings[0]?.state === 'recovering');
}


test('recovery uses a separate capability, drops old TCP, rotates data authorization and opens targets only for new clients', async t => {
  const peers = new Set(); let accepted = 0, received = '';
  const target = net.createServer(socket => { accepted++; peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); socket.on('data', bytes => { received += bytes.toString(); socket.write(bytes); }); });
  target.listen(0, '127.0.0.2'); await once(target, 'listening');
  const app = await fixture({ forwardPorts: [target.address().port] });
  t.after(async () => { await app.close(); for (const socket of peers) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
   const mapping = await create(app, 2222, '127.0.0.2'), first = await connected(app, '/forward/helper', mapping.code);
  assert.equal(first.ready.targetHost,'127.0.0.2');
  assert.equal(first.ready.resumeToken.length, 43); assert.equal(first.ready.resumeMs, FORWARD_LIMITS.resumeMs);
  assert.notEqual(first.ready.resumeToken, first.ready.streamToken); assert.notEqual(first.ready.resumeToken, mapping.code);
  assert.equal((await rejected(app, mapping.code)).status, 401); assert.equal((await rejected(app, first.ready.streamToken)).status, 401);
  assert.equal((await rejected(app, first.ready.resumeToken, '/forward/data')).status, 401);
  assert.equal((await rejected(app, first.ready.resumeToken, '/forward/resume', { origin: 'https://invalid.example' })).status, 403);
  assert.equal((await rejected(app, first.ready.resumeToken, '/forward/resume', { host: 'invalid.example' })).status, 403);
  const oldData = await open(app, '/forward/data', first.ready.streamToken); await until(() => oldData.records.length === 1);
  oldData.ws.send(Buffer.from('sent once')); await until(() => oldData.records.some(Buffer.isBuffer));
  const oldClosed = once(oldData.ws, 'close'); await suspend(app, first); await oldClosed;
  const waiting = await status(app); assert.equal(waiting.mappings[0].connections, 0); assert.equal(waiting.mappings[0].errorCode, 'helper_reconnecting');
  assert.ok(waiting.mappings[0].recoverUntil > Date.now()); assert.equal(accepted, 1);
  assert.equal((await rejected(app, first.ready.streamToken, '/forward/data')).status, 401);
  const second = await connected(app, '/forward/resume', first.ready.resumeToken);
  assert.equal(second.ready.id, mapping.id); assert.equal(second.ready.resumeToken, undefined); assert.notEqual(second.ready.streamToken, first.ready.streamToken);
  assert.equal(second.ready.targetHost,'127.0.0.2'); assert.equal(second.ready.targetPort,target.address().port);
  assert.equal((await status(app)).mappings[0].recoverUntil, null); assert.equal(accepted, 1); assert.equal(received, 'sent once');
  assert.equal((await rejected(app, mapping.code, '/forward/helper')).code, 'pair_used');
  const fresh = await open(app, '/forward/data', second.ready.streamToken); await until(() => fresh.records.length === 1);
  fresh.ws.send(Buffer.from('new client')); await until(() => fresh.records.some(Buffer.isBuffer));
  assert.equal(accepted, 2); assert.equal(received, 'sent oncenew client');
  const json = JSON.stringify(await status(app));
  for (const value of [mapping.code, first.ready.resumeToken, first.ready.streamToken, second.ready.streamToken, 'resumeHash', 'streamHash']) assert.equal(json.includes(value), false);
  assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []);
});

test('a credentialed resume can replace a half-open control, and a concurrent handshake or stale close cannot take over again', async t => {
  const app = await fixture(); t.after(() => app.close());
  const mapping = await create(app), first = await connected(app, '/forward/helper', mapping.code), closed = once(first.ws, 'close');
  const second = await open(app, '/forward/resume', first.ready.resumeToken); await until(() => second.records.length === 1);
  assert.equal((await rejected(app, first.ready.resumeToken)).code, 'resume_busy');
  await closed; second.ws.send('{"type":"listening"}'); await until(() => second.records.length === 2);
  assert.equal((await status(app)).mappings[0].state, 'active'); assert.equal(second.ws.readyState, WebSocket.OPEN);
  const ended = once(second.ws, 'close'); second.ws.close(1000, 'client_stopping'); await ended;
  await until(async () => (await status(app)).recent[0]?.code === 'helper_stopped');
  assert.equal((await rejected(app, first.ready.resumeToken)).code, 'helper_stopped');
});

for (const operation of ['stop', 'revoke', 'expiry', 'restart']) {
  test(`recovery cannot survive ${operation} or recreate the revoked mapping`, async t => {
    if (operation === 'expiry') t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const app = await fixture({ sessionMs: 60000 }); t.after(() => app.close());
    const mapping = await create(app), first = await connected(app, '/forward/helper', mapping.code); await suspend(app, first);
    const before = Date.now(); let expected;
    if (operation === 'stop') { await app.request('stop', { method: 'POST', body: { id: mapping.id } }); expected = 'stopped'; }
    if (operation === 'revoke') { await app.request('revoke', { method: 'POST', body: {} }); expected = 'authorization_revoked'; }
    if (operation === 'expiry') { t.mock.timers.setTime(before + 61000); expected = 'authorization_expired'; }
    if (operation === 'restart') { await app.panel.close(); expected = 'resume_authorization_invalid'; }
    if (operation === 'restart') {
      const fresh = await fixture(); t.after(() => fresh.close());
      assert.equal((await rejected(fresh, first.ready.resumeToken)).code, expected);
    } else {
      const denied = await rejected(app, first.ready.resumeToken); assert.equal(denied.status, 401); assert.equal(denied.code, expected);
    }
    assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []);
  });
}

test('recovery deadline and attempt budget cannot be renewed by incomplete handshakes, and recovering slots stay bounded', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await fixture(); t.after(() => app.close());
  const mapping = await create(app), first = await connected(app, '/forward/helper', mapping.code); await suspend(app, first);
  const deadline = (await status(app)).mappings[0].recoverUntil;
  for (let i = 0; i < FORWARD_LIMITS.resumeAttempts; i++) {
    t.mock.timers.setTime(Date.now() + 100);
    const attempt = await open(app, '/forward/resume', first.ready.resumeToken); await until(() => attempt.records.length === 1);
    await suspend(app, attempt); assert.equal((await status(app)).mappings[0].recoverUntil, deadline);
  }
  assert.equal((await rejected(app, first.ready.resumeToken)).code, 'resume_expired');
  for (let i = 0; i < FORWARD_LIMITS.mappings; i++) {
    const next = await create(app, 2223 + i), control = await connected(app, '/forward/helper', next.code); await suspend(app, control);
  }
  const full = await app.request('mapping', { method: 'POST', body: { localPort: 3333, targetPort: app.config.forwardPorts[0] } }); assert.equal(full.status, 409);
  t.mock.timers.setTime(Date.now() + FORWARD_LIMITS.resumeMs + 1);
  const ended = await status(app); assert.equal(ended.mappings.length, 0); assert.equal(ended.recent[0].code, 'resume_expired');
  assert.ok(ended.recent.length <= FORWARD_LIMITS.recent); assert.equal(JSON.stringify(ended).includes('resumeHash'), false);
});

test('late ICE answers and status from the previous control generation cannot authorize or replace the resumed peer', async t => {
  let release, captured;
  const answer = new Promise(resolve => { release = resolve; });
  const app = await fixture({ webrtc: true, forwardPeerFactory: options => {
    captured = options;
    return { state: { id: options.id, available: false, reason: 'rtc_connecting' }, streams: 0, answer: () => answer,
      async destroy() { options.closed(); } };
  } }); t.after(async () => { release('late test answer'); await app.close(); });
  const mapping = await create(app), first = await connected(app, '/forward/helper', mapping.code, true);
  const offer = JSON.stringify({ type: 'rtc_offer', id: 1, sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), ''].join('\r\n') });
  first.ws.send(offer); await until(() => captured); const previous = captured;
  assert.equal(previous.valid(), true); assert.equal(previous.authenticate(first.ready.streamToken), true);
  await suspend(app, first); assert.equal(previous.valid(), false);
  const second = await connected(app, '/forward/resume', first.ready.resumeToken, true);
  assert.equal(previous.authenticate(second.ready.streamToken), false);
  previous.status({ id: 1, available: true, family: 'IPv6', reason: '' });
  release('late test answer'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.records.length, 3); assert.equal((await status(app)).mappings[0].direct.available, false);
  assert.equal((await status(app)).mappings[0].state, 'active');
  second.ws.send(offer); await until(() => captured !== previous); assert.equal(captured.valid(), true);
});
