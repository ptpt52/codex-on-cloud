import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlDecoder, sendControl, CONTROL_LIMIT, createControlClient } from '../panel/public/control.js';
import { attachRTCControl } from '../panel/rtc-control.mjs';

function channel() {
  const subscriptions = new Map();
  const event = name => ({ subscribe(fn) { subscriptions.set(name, fn); } });
  return { readyState: 'open', bufferedAmount: 0, packets: [], onMessage: event('message'), stateChange: event('state'), error: event('error'),
    emit(value) { subscriptions.get('message')(value); },
    send(bytes) { this.packets.push(Buffer.from(bytes)); }, close() { this.readyState = 'closed'; },
  };
}
function receive(channel, value) {
  const sender = { readyState: 'open', bufferedAmount: 0, send: bytes => channel.emit(bytes) };
  sendControl(sender, value);
}

function clientChannel() {
  const wire = new EventTarget();
  Object.assign(wire, { readyState: 'open', bufferedAmount: 0, packets: [], send(bytes) { this.packets.push(bytes); }, close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); } });
  return wire;
}
function reply(wire, value) { sendControl({ readyState: 'open', bufferedAmount: 0, send: data => wire.dispatchEvent(new MessageEvent('message', { data })) }, value); }

test('a service RPC timeout quarantines one ID, rejects new work and drains its late reply without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = clientChannel(), states = [], client = createControlClient(wire, ready => states.push(ready), { keepOnTimeout: true });
  const pending = client.request('file-delete', { name: 'once' });
  const rejected = assert.rejects(pending, { code: 'rpc_timeout', outcome: 'unknown' });
  t.mock.timers.tick(8000); await rejected;
  assert.equal(wire.readyState, 'open'); assert.equal(client.ready, false); assert.equal(client.draining, true);
  await assert.rejects(client.request('state', {}), { outcome: 'rejected' }); assert.equal(wire.packets.length, 1);
  reply(wire, { id: 1, ok: true, value: { ok: true } });
  assert.equal(client.ready, true); assert.equal(client.draining, false);
  const next = client.request('state', {}); reply(wire, { id: 2, ok: true, value: { fresh: true } });
  assert.deepEqual(await next, { fresh: true }); assert.equal(wire.packets.length, 2); assert.deepEqual(states, [false, true]); client.close();
});

test('desktop controls still close after timeout and invalid late service replies fail closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const service of [false, true]) {
    const wire = clientChannel(), client = createControlClient(wire, () => {}, { keepOnTimeout: service });
    const rejected = assert.rejects(client.request('state', {}), { outcome: 'unknown' });
    t.mock.timers.tick(8000); await rejected;
    if (service) reply(wire, { id: 2, ok: true, value: {} });
    assert.equal(wire.readyState, 'closed');
  }
});

test('RPC diagnostics distinguish local HTTP failures, late replies and peer closure without recording payloads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = clientChannel(), events = [], client = createControlClient(wire, () => {}, { keepOnTimeout: true, trace: (type, event) => events.push({ type, ...event }) });
  for (const [id, code] of [[1, 'local_http_timeout'], [2, 'local_http_error']]) {
    const request = client.request('diagnostics', { text: 'PRIVATE_BODY' });
    reply(wire, { id, ok: false, error: { code, status: id === 1 ? 504 : 502, outcome: 'unknown', message: 'PRIVATE_MESSAGE' } });
    await assert.rejects(request, { code }); assert.equal(client.ready, true);
  }
  const timedOut = assert.rejects(client.request('file-delete', { name: 'PRIVATE_FILENAME' }), { code: 'rpc_timeout' });
  t.mock.timers.tick(8000); await timedOut; reply(wire, { id: 3, ok: true, value: { text: 'PRIVATE_REPLY' } });
  const closed = assert.rejects(client.request('PRIVATE_ACTION', {}), { code: 'peer_closed' }); wire.close(); await closed;
  assert.deepEqual(events.map(({ type, reason }) => [type, reason]), [['rpc-failed', 'local-http-timeout'], ['rpc-failed', 'local-http-error'], ['rpc-failed', 'rpc-timeout'], ['rpc-recovered', 'late-reply'], ['rpc-failed', 'peer-closed'], ['control-closed', 'peer-closed']]);
  assert.equal(events[0].action, 'diagnostics'); assert.equal(events[2].action, 'file-delete'); assert.equal(events[3].action, 'file-delete');
  assert.equal(events[4].action, undefined); assert.equal(JSON.stringify(events).includes('PRIVATE_'), false);
});

test('a failed diagnostic sink cannot prevent settlement or close the working control channel', async () => {
  const wire = clientChannel(), client = createControlClient(wire, () => {}, { trace() { throw Error('log storage unavailable'); } });
  const failed = assert.rejects(client.request('files', {}), { status: 503 });
  reply(wire, { id: 1, ok: false, error: { status: 503, outcome: 'rejected' } }); await failed;
  assert.equal(client.ready, true); client.close();
});

test('control records preserve bounded UTF-8 and escaped clipboard text across small SCTP messages', () => {
  for (const value of [{ id: 1, body: { text: '中文😀\r\n$(literal)' } }, { id: 2, text: '\x01'.repeat(32768) }]) {
    const wire = channel(); sendControl(wire, value);
    let received, errors = 0;
    const decoder = controlDecoder(result => { received = result; }, () => errors++);
    for (const packet of wire.packets) { assert.ok(packet.length <= 16384); decoder.push(packet); }
    assert.deepEqual(received, value); assert.equal(errors, 0);
  }
  assert.throws(() => sendControl(channel(), { text: 'x'.repeat(CONTROL_LIMIT) }));
  const blocked = channel(); blocked.bufferedAmount = 512 * 1024;
  assert.throws(() => sendControl(blocked, { id: 1 }));
});

test('malformed, oversized and invalid UTF-8 control frames are discarded and release their buffers', () => {
  let errors = 0, messages = 0;
  const decoder = controlDecoder(() => messages++, () => errors++);
  for (const frame of [Buffer.alloc(0), Buffer.alloc(16385), Buffer.from([0, 0, 0, 0]), Buffer.from([0, 4, 0, 1]), Buffer.from([0, 0, 0, 1, 255])]) decoder.push(frame);
  assert.equal(errors, 5); assert.equal(messages, 0);
  const wire = channel(); sendControl(wire, { id: 3 }); wire.packets.forEach(packet => decoder.push(packet));
  assert.equal(messages, 1);
});

test('control authorization, exclusivity and monotonic IDs prevent execution after revocation or replay', async () => {
  let calls = 0, release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = channel(); let valid = true;
  attachRTCControl(first, { valid: () => valid, perform: async (_action, _body, live) => { calls++; await hold; assert.equal(live(), false); return { text: 'private result' }; } });
  receive(first, { id: 1, action: 'clipboard', body: {} });
  assert.equal(calls, 1); valid = false; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.readyState, 'closed'); assert.equal(first.packets.length, 0);
  const revoked = channel(); attachRTCControl(revoked, { valid: () => false, perform: () => { calls++; } });
  receive(revoked, { id: 2 }); assert.equal(calls, 1); assert.equal(revoked.readyState, 'closed');
  const replay = channel(); attachRTCControl(replay, { valid: () => true, perform: async () => { calls++; return { ok: true }; } });
  receive(replay, { id: 1 }); await new Promise(resolve => setImmediate(resolve));
  receive(replay, { id: 1 }); assert.equal(calls, 2); assert.equal(replay.readyState, 'closed');
  const busy = channel(); attachRTCControl(busy, { valid: () => true, perform: () => { calls++; return new Promise(() => {}); } });
  receive(busy, { id: 1 }); receive(busy, { id: 2 });
  assert.equal(calls, 3); assert.equal(busy.readyState, 'closed');
});
