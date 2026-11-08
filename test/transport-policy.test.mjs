import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectGrace, routePolicy, ROUTE_COOLDOWN, NETWORK_PROBE_INTERVAL } from '../panel/public/transport-policy.js';
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
