import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthClient } from '../panel/public/health.js';
import { attachRTCHealth } from '../panel/rtc-health.mjs';

const packet = id => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(id); return bytes; };
function serverChannel() {
  const handlers = {};
  const event = name => ({ subscribe(fn) { handlers[name] = fn; } });
  return { readyState: 'open', bufferedAmount: 0, packets: [], onMessage: event('message'), error: event('error'), stateChange: event('state'),
    send(bytes) { this.packets.push(Buffer.from(bytes)); }, close() { this.readyState = 'closed'; },
    emit(bytes) { handlers.message(bytes); },
  };
}
class ClientChannel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; packets = [];
  send(bytes) { this.packets.push(Buffer.from(bytes)); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  reply(id) { this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(packet(id)).buffer })); }
}

test('health echoes only authenticated, monotonic four-byte nonces with rate and buffer bounds', () => {
  const wire = serverChannel(); let valid = true, failures = 0;
  attachRTCHealth(wire, { valid: () => valid, fail: () => failures++ });
  wire.emit(packet(1)); assert.deepEqual(wire.packets, [packet(1)]);
  valid = false; wire.emit(packet(2));
  assert.equal(failures, 1); assert.equal(wire.packets.length, 1); assert.equal(wire.readyState, 'closed');
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(5), 'text', packet(0), packet(2147483648)]) {
    const bad = serverChannel(); attachRTCHealth(bad, { valid: () => true, fail() {} });
    bad.emit(bytes); assert.equal(bad.readyState, 'closed'); assert.equal(bad.packets.length, 0);
  }
  const replay = serverChannel(); attachRTCHealth(replay, { valid: () => true, fail() {} });
  replay.emit(packet(1)); replay.emit(packet(1)); assert.equal(replay.readyState, 'closed'); assert.equal(replay.packets.length, 1);
  const flood = serverChannel(); attachRTCHealth(flood, { valid: () => true, fail() {} });
  for (let id = 1; id <= 10; id++) flood.emit(packet(id));
  assert.equal(flood.packets.length, 8); assert.equal(flood.readyState, 'closed');
  const full = serverChannel(); full.bufferedAmount = 4097;
  attachRTCHealth(full, { valid: () => true, fail() {} }); full.emit(packet(1)); assert.equal(full.packets.length, 0); assert.equal(full.readyState, 'closed');
});

test('client health has one deadline, cancels old probes and ignores their late echoes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = new ClientChannel(), health = createHealthClient(channel);
  const first = health.ping(), canceled = assert.rejects(first, /取消/);
  await assert.rejects(health.ping(), /不可用/);
  health.cancel(); await canceled;
  let complete = false;
  const next = health.ping().then(() => { complete = true; });
  channel.reply(1); await Promise.resolve(); assert.equal(complete, false);
  channel.reply(2); await next;
  const timed = assert.rejects(health.ping(), /超时/);
  t.mock.timers.tick(2000); await timed;
  const late = health.ping(); channel.reply(3); channel.reply(4); await late;
  const closed = assert.rejects(health.ping(), /关闭/); health.close(); await closed;
  assert.equal(channel.readyState, 'closed'); assert.equal(channel.packets.length, 5);
});

test('client health bounds open waits and rejects malformed echoes and send backpressure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = new ClientChannel(); connecting.readyState = 'connecting';
  const waiting = createHealthClient(connecting), timeout = assert.rejects(waiting.ping(), /超时/);
  t.mock.timers.tick(2000); await timeout; assert.equal(connecting.packets.length, 0); waiting.close();
  const opening = new ClientChannel(); opening.readyState = 'connecting';
  const opened = createHealthClient(opening), probe = opened.ping();
  opening.readyState = 'open'; opening.dispatchEvent(new Event('open'));
  assert.equal(opening.packets.length, 1); opening.reply(1); await probe; opened.close();
  for (const data of [new ArrayBuffer(5), 'invalid', Uint8Array.from(packet(9)).buffer]) {
    const bad = new ClientChannel(), health = createHealthClient(bad), rejected = assert.rejects(health.ping(), /关闭/);
    bad.dispatchEvent(new MessageEvent('message', { data })); await rejected; assert.equal(bad.readyState, 'closed');
  }
  const full = new ClientChannel(); full.bufferedAmount = 4097;
  await assert.rejects(createHealthClient(full).ping(), /关闭/); assert.equal(full.packets.length, 0);
});
