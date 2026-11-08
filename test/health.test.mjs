import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthClient, createRoundTrip, createHeartbeatPolicy } from '../panel/public/health.js';
import { attachRTCHealth } from '../panel/rtc-health.mjs';

const packet = id => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(id); return bytes; };
test('heartbeat timing follows measured latency and variation with bounded confirmation and recovery', () => {
  const policy = createHeartbeatPolicy(); assert.equal(policy.timeoutMs, 2000); assert.equal(policy.confirmationMs, 1000);
  policy.sample(1400); assert.ok(policy.timeoutMs > 2000); assert.ok(policy.timeoutMs <= 6000);
  policy.miss(); assert.equal(policy.suspect, true); assert.ok(policy.confirmationMs <= 2000);
  policy.sample(250); assert.equal(policy.suspect, false);
  for (let i = 0; i < 100; i++) policy.sample(i % 2 ? 600000 : 0);
  assert.equal(policy.timeoutMs, 6000);
  assert.equal(policy.sample(NaN), false); assert.equal(policy.sample(-1), false);
  policy.miss(); policy.cancel(); assert.equal(policy.suspect, false);
});
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

test('round trips expire, reject invalid samples and retain a real zero millisecond result', () => {
  let now = 100;
  const latency = createRoundTrip(() => now);
  assert.equal(latency.value, null); latency.set(0); assert.equal(latency.value, 0);
  now += 10000; assert.equal(latency.value, 0); now++; assert.equal(latency.value, null);
  for (const invalid of [null, undefined, '12', NaN, Infinity, -1, 600001]) { latency.set(invalid); assert.equal(latency.value, null); }
  latency.set(23.6); assert.equal(latency.value, 24); latency.clear(); assert.equal(latency.value, null);
});

test('data channel latency starts at the actual send and ignores canceled and duplicate echoes', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const channel = new ClientChannel(); channel.readyState = 'connecting';
  const health = createHealthClient(channel), first = health.ping();
  now += 500; channel.readyState = 'open'; channel.dispatchEvent(new Event('open'));
  now += 37; channel.reply(1); assert.equal(await first, 37); assert.equal(health.rttMs, 37);
  const canceled = assert.rejects(health.ping(), /取消/); health.cancel(); await canceled;
  assert.equal(health.rttMs, null);
  const next = health.ping(); now += 42; channel.reply(2); assert.equal(health.rttMs, null);
  channel.reply(3); assert.equal(await next, 42);
  now += 100; channel.reply(3); assert.equal(health.rttMs, 42);
  now += 10001; assert.equal(health.rttMs, null); health.close();
});

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
