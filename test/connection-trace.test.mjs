import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionTrace, TRACE_LIMITS } from '../panel/public/connection-trace.js';
test('connection diagnostics retain bounded whitelisted events without payloads or endpoint information', () => {
  let now = 100; const trace = createConnectionTrace(() => now);
  assert.equal(trace.add({ type: 'unknown', text: 'secret' }, { mode: 'terminal' }), false);
  assert.equal(trace.add({ type: 'path-active' }, { mode: 'unknown' }), false);
  for (let i = 0; i < 1000; i++) {
    now += 10;
    trace.add({ type: 'rtc-stage', path: 'direct', stage: 'signaling', durationMs: i, waitMs: 60000, queuedBytes: 1048576,
      reason: 'secret address and password', sdp: 'secret', text: 'secret' }, { mode: 'terminal', standby: true });
  }
  assert.equal(trace.snapshot().length, TRACE_LIMITS.events);
  assert.ok(Buffer.byteLength(trace.text()) <= TRACE_LIMITS.bytes); assert.ok(!trace.text().includes('secret'));
  const event = trace.snapshot()[0]; assert.equal(event.standby, true); assert.equal(event.durationMs, 950);
  event.durationMs = -1; assert.equal(trace.snapshot()[0].durationMs, 950);
  trace.clear(); assert.deepEqual(trace.snapshot(), []); now += 11;
  trace.add({ type: 'retry', durationMs: -1, waitMs: NaN, reason: 'busy' }, { mode: 'service' });
  assert.deepEqual(trace.snapshot(), [{ atMs: 11, mode: 'service', standby: false, type: 'retry', reason: 'busy' }]);
});
