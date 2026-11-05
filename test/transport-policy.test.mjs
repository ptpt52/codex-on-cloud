import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectGrace, routePolicy, ROUTE_COOLDOWN } from '../panel/public/transport-policy.js';
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
