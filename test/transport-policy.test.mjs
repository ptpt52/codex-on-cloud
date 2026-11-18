import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectGrace, routePolicy, ROUTE_COOLDOWN, NETWORK_PROBE_INTERVAL, rtcFailureStatus, directRetry, createPathQuality, pathPreferred, createRTCNativeWaiter, RTC_NATIVE_LIMIT } from '../panel/public/transport-policy.js';

test('aborted native waits release their caller while retaining bounded native slots until settlement', async () => {
  const native = createRTCNativeWaiter(), releases = [];
  for (let n = 0; n < RTC_NATIVE_LIMIT; n++) {
    const controller = new AbortController();
    const pending = native.wait(() => new Promise(resolve => releases.push(resolve)), controller.signal);
    await Promise.resolve(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  }
  assert.equal(native.pending, RTC_NATIVE_LIMIT);
  let invoked = false;
  await assert.rejects(native.wait(() => { invoked = true; }), { reason: 'native-busy' }); assert.equal(invoked, false);
  releases[0]('late'); await new Promise(setImmediate); assert.equal(native.pending, RTC_NATIVE_LIMIT - 1);
  assert.equal(await native.wait(() => 'new scope'), 'new scope');
  for (const release of releases.slice(1)) release(); await new Promise(setImmediate); assert.equal(native.pending, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(native.wait(() => { invoked = true; }, controller.signal), { name: 'AbortError' }); assert.equal(invoked, false);
  await assert.rejects(native.wait(() => { throw Error('native failure'); }), /native failure/); assert.equal(native.pending, 0);
});
test('local signaling queue timeouts use bounded admission backoff rather than a network failure delay', () => {
  assert.deepEqual(directRetry('queue-timeout', 0, () => 0), { stop: false, delay: 500 });
  assert.deepEqual(directRetry('queue-timeout', 8, () => 1), { stop: false, delay: 5000 });
  assert.deepEqual(directRetry('negotiation-timeout', 0, () => 0), { stop: false, delay: 15000 });
});
test('path quality uses fresh repeated samples, favors comparable direct paths and requires a margin for TURN or switching back', () => {
  let time = 1000; const quality = createPathQuality(() => time);
  quality.sample(100); assert.equal(quality.rttMs, null); quality.sample(120); assert.equal(quality.rttMs, 110);
  time += 10001; assert.equal(quality.rttMs, null); quality.clear(); quality.sample(5); assert.equal(quality.rttMs, null);
  for (const [candidateMs, currentMs, candidate, turn, expected] of [[15, 10, 'direct', false, true], [200, 20, 'direct', false, false],
    [20, 20, 'direct', true, false], [20, 100, 'direct', true, true], [10, 20, 'relay', false, false], [20, 100, 'relay', false, true], [null, 20, 'direct', false, false]]) {
    assert.equal(pathPreferred({ candidateMs, currentMs, candidate, turn }), expected);
  }
});
test('path cost distinguishes quiet applications from sustained transport queues and delayed transport ACKs', () => {
  let time = 1000; const direct = createPathQuality(() => time), relay = createPathQuality(() => time);
  for (let n = 0; n < 3; n++) { direct.sample(10); relay.sample(30); }
  time += 3000; assert.equal(direct.scoreMs, 10, 'no traffic does not mean a stalled connection');
  direct.buffered(32768); time += 500; direct.buffered(32768); assert.equal(direct.metrics.penaltyMs, 0);
  time += 600; direct.buffered(32768); assert.ok(direct.scoreMs > 200);
  assert.equal(pathPreferred({ candidateMs: relay.scoreMs, currentMs: direct.scoreMs, candidate: 'relay' }), true);
  direct.buffered(0); assert.equal(direct.scoreMs, 10);
  direct.acknowledge(1200); assert.ok(direct.metrics.penaltyMs > 500);
  time += 10001; direct.sample(10); assert.equal(direct.scoreMs, 10, 'old congestion cannot permanently penalize a path');
  direct.buffered(-1); direct.acknowledge(NaN); assert.equal(direct.scoreMs, 10);
  direct.clear(); assert.equal(direct.scoreMs, null); assert.equal(direct.metrics.queuedBytes, 0);
});
test('fresh RTT variation increases path cost while retaining the measured mean', () => {
  const steady = createPathQuality(), jittery = createPathQuality();
  for (const sample of [50, 50, 50]) steady.sample(sample);
  for (const sample of [10, 90, 50]) jittery.sample(sample);
  assert.equal(jittery.rttMs, steady.rttMs); assert.ok(jittery.scoreMs > steady.scoreMs);
});
test('a transient disconnect recovers without retirement; hard failure cancels the one deadline', () => {
  let expire, failed = 0, cancelled = 0;
  const grace = disconnectGrace(() => failed++, { schedule: fn => { expire = fn; return 1; }, cancel: () => cancelled++ });
  grace.state('disconnected'); grace.state('disconnected'); grace.state('connected');
  assert.equal(failed, 0); assert.equal(cancelled, 1);
  grace.state('disconnected'); grace.state('failed'); assert.equal(failed, 1); assert.equal(cancelled, 2);
  grace.state('disconnected'); expire(); assert.equal(failed, 2); grace.close();
});
test('a route change imposes a bounded cooldown that clock progress releases', () => {
  let time = 0; const policy = routePolicy(() => time);
  assert.equal(policy.remaining(), 0); policy.changed(); assert.equal(policy.remaining(), ROUTE_COOLDOWN);
  time += 1000; assert.equal(policy.remaining(), ROUTE_COOLDOWN - 1000);
  time += ROUTE_COOLDOWN; assert.equal(policy.remaining(), 0);
});
test('network probes have a separate bounded rate without weakening ordinary route cooldown', () => {
  let time = 1000; const policy = routePolicy(() => time); policy.changed();
  assert.equal(policy.networkWait(), 0); policy.networkProbeStarted();
  for (let i = 0; i < 100; i++) { time += 10; assert.ok(policy.networkWait() > 0); }
  assert.equal(policy.networkWait(), NETWORK_PROBE_INTERVAL - 1000);
  assert.equal(policy.remaining(), ROUTE_COOLDOWN - 1000);
  time += NETWORK_PROBE_INTERVAL; assert.equal(policy.networkWait(), 0);
  assert.ok(policy.remaining() > 0); policy.networkProbeStarted(); assert.equal(policy.networkWait(), NETWORK_PROBE_INTERVAL);
});
test('busy signaling retries promptly, network errors back off and invalid authorization or targets stop probing', () => {
  assert.equal(rtcFailureStatus(429), 'busy'); assert.equal(rtcFailureStatus(503), 'signal-failed');
  for (const status of [401, 403, 423, 409, 400, 404]) assert.equal(directRetry(rtcFailureStatus(status)).stop, true);
  for (let i = 0; i < 100; i++) {
    const busy = directRetry('busy', i, () => .5), network = directRetry('ice-timeout', i, () => .5);
    assert.ok(busy.delay >= 500 && busy.delay <= 5000); assert.ok(network.delay >= 15000 && network.delay <= 60000);
    assert.equal(busy.stop, false); assert.equal(network.stop, false);
  }
  assert.ok(directRetry('busy', 0, () => 0).delay < directRetry('ice-timeout', 0, () => 0).delay);
});
