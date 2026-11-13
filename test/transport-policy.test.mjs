import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectGrace, routePolicy, ROUTE_COOLDOWN, NETWORK_PROBE_INTERVAL, rtcFailureStatus, directRetry, createPathQuality, pathPreferred } from '../panel/public/transport-policy.js';
test('path quality uses fresh repeated samples, favors comparable direct paths and requires a margin for TURN or switching back', () => {
  let time = 1000; const quality = createPathQuality(() => time);
  quality.sample(100); assert.equal(quality.rttMs, null); quality.sample(120); assert.equal(quality.rttMs, 110);
  time += 10001; assert.equal(quality.rttMs, null); quality.clear(); quality.sample(5); assert.equal(quality.rttMs, null);
  for (const [candidateMs, currentMs, candidate, turn, expected] of [[15, 10, 'direct', false, true], [200, 20, 'direct', false, false],
    [20, 20, 'direct', true, false], [20, 100, 'direct', true, true], [10, 20, 'relay', false, false], [20, 100, 'relay', false, true], [null, 20, 'direct', false, false]]) {
    assert.equal(pathPreferred({ candidateMs, currentMs, candidate, turn }), expected);
  }
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
