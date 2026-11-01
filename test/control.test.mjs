import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlDecoder, sendControl, CONTROL_LIMIT } from '../panel/public/control.js';
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
