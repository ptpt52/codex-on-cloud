import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionTrace, createTraceReporter, TRACE_LIMITS, TRACE_STORAGE_KEY, traceDescription } from '../panel/public/connection-trace.js';
test('connection diagnostics retain bounded whitelisted events without payloads or endpoint information', () => {
  let now = 100; const trace = createConnectionTrace(() => now, { enabled: true, wallNow: () => 1700000000000 + now });
  assert.equal(trace.add({ type: 'unknown', text: 'secret' }, { mode: 'terminal' }), false);
  assert.equal(trace.add({ type: 'path-active' }, { mode: 'unknown' }), false);
  for (let i = 0; i < 1000; i++) {
    now += 10;
    trace.add({ type: 'rtc-stage', path: 'direct', stage: 'signaling', durationMs: i, waitMs: 60000, queuedBytes: 1048576,
      reason: 'secret address and password', sdp: 'secret', text: 'secret' }, { mode: 'terminal', standby: true });
  }
  assert.equal(trace.snapshot().length, TRACE_LIMITS.events);
  assert.ok(Buffer.byteLength(trace.text()) <= TRACE_LIMITS.bytes); assert.ok(!trace.text().includes('secret'));
  const event = trace.snapshot()[0]; assert.equal(event.standby, true); assert.equal(event.durationMs, 1000 - TRACE_LIMITS.events);
  event.durationMs = -1; assert.equal(trace.snapshot()[0].durationMs, 1000 - TRACE_LIMITS.events);
  trace.clear(); assert.deepEqual(trace.snapshot(), []); now += 11;
  trace.add({ type: 'retry', durationMs: -1, waitMs: NaN, reason: 'busy' }, { mode: 'service' });
  assert.deepEqual(trace.snapshot(), [{ atMs: 11, time: 1700000000000 + now, page: 1, mode: 'service', standby: false, type: 'retry', reason: 'busy' }]);
});

test('network logs restore only the same node, keep old events separate from current progress, expire and bound storage', () => {
  let time = 1700000000000, saved; const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const make = scope => createConnectionTrace(() => time, { enabled: true, storage, scope, wallNow: () => time });
  const trace = make('node:a');
  trace.add({ type: 'probe-stopped', path: 'direct', reason: 'target', status: 409, text: 'SECRET', sdp: 'SECRET' }, { mode: 'terminal', view: 1 });
  trace.flush();
  time += 5000; const restored = make('node:a');
  assert.equal(restored.snapshot().length, 1); assert.equal(restored.latest('terminal', 1), undefined);
  restored.add({ type: 'retry', path: 'direct', waitMs: 1000 }, { mode: 'terminal', view: 2 });
  restored.flush();
  assert.equal(restored.snapshot()[1].atMs, 5000); assert.equal(restored.latest('terminal', 2).waitMs, 1000);
  assert.equal(make('node:b').snapshot().length, 0);
  for (let n = 0; n < 8; n++) { time++; const entry = make('node:' + n); entry.add({ type: 'path-active', path: 'direct' }, { mode: 'desktop' }); entry.flush(); }
  assert.equal(JSON.parse(saved).entries.length, TRACE_LIMITS.scopes); assert.ok(Buffer.byteLength(saved) <= TRACE_LIMITS.storageBytes);
  assert.ok(!saved.includes('SECRET')); time += TRACE_LIMITS.ageMs + 1; assert.deepEqual(make('node:7').snapshot(), []);
  saved = JSON.stringify({ version: 2, entries: [{ scope: 'node:a', at: time, events: [{ type: 'path-active', atMs: 0, time, mode: 'terminal', text: 'SECRET', address: 'SECRET' }] }] });
  const sanitized = make('node:a'); assert.ok(!sanitized.text({ token: 'SECRET', views: [{ mode: 'terminal', state: 'connected', path: 'direct', password: 'SECRET' }] }).includes('SECRET'));
  sanitized.clear(); assert.equal(make('node:a').snapshot().length, 0);
  const broken = createConnectionTrace(undefined, { enabled: true, storage: { getItem() { throw Error(); }, setItem() { throw Error(); } }, scope: 'node:a' });
  broken.add({ type: 'path-active' }, { mode: 'terminal' }); assert.equal(broken.persisted, false);
  assert.equal(TRACE_STORAGE_KEY, 'codex-cloud.network-log.v2');
});

test('logs explain exact wait and stop causes with HTTP status and a live retry countdown', () => {
  const event = { type: 'retry', reason: 'cooldown', waitMs: 30000, time: 1000 };
  assert.match(traceDescription(event, 11000), /剩余 20 秒/);
  assert.match(traceDescription({ type: 'probe-waiting', reason: 'standby' }), /后台待命/);
  assert.match(traceDescription({ type: 'probe-stopped', reason: 'target', status: 409 }), /HTTP 409/);
  const trace = createConnectionTrace(undefined, { enabled: true });
  trace.add({ type: 'probe-waiting', path: 'direct', reason: 'input-unconfirmed', pendingInputs: 3, inputAgeMs: 2000, queuedBytes: 100,
    text: 'PRIVATE_TEXT' }, { mode: 'terminal' });
  assert.match(traceDescription(trace.latest('terminal')), /等待已发送数据确认.*待确认 3 项 \/ 2000 ms/);
  assert.ok(!trace.text().includes('PRIVATE_TEXT'));
  assert.match(traceDescription({ type: 'rtc-stats-timeout', durationMs: 1000 }), /继续按心跳/);
  trace.add({ type: 'rtc-route', path: 'direct', route: 'turn', address: 'SECRET' }, { mode: 'terminal' });
  assert.match(traceDescription(trace.snapshot().at(-1)), /TURN 中继/);
  const value = JSON.parse(trace.text({ views: [{ mode: 'terminal', state: 'connected', path: 'direct', route: 'turn', address: 'SECRET' }] }));
  assert.equal(value.current.views[0].route, 'turn'); assert.ok(!JSON.stringify(value).includes('SECRET'));
});

test('debugging defaults off, disabling cancels queued persistence and clears only the current node', async () => {
  let saved, writes = 0;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; writes++; }, removeItem: () => { saved = undefined; writes++; } };
  const trace = createConnectionTrace(undefined, { storage, scope: 'node:a' });
  assert.equal(trace.enabled, false); assert.equal(trace.add({ type: 'path-active' }, { mode: 'terminal' }), false);
  assert.equal(writes, 0); assert.deepEqual(trace.snapshot(), []);
  // The disabled reporter must not even access a browser message target.
  assert.doesNotThrow(() => createTraceReporter('frame')('heartbeat-ok', { rttMs: 10 }));
  trace.setEnabled(true); trace.add({ type: 'path-active' }, { mode: 'terminal' }); trace.flush();
  const other = createConnectionTrace(undefined, { enabled: true, storage, scope: 'node:b' });
  other.add({ type: 'path-active' }, { mode: 'service' }); other.flush();
  trace.add({ type: 'heartbeat-ok' }, { mode: 'terminal' }); trace.setEnabled(false);
  const afterDisable = writes; await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes, afterDisable); assert.deepEqual(trace.snapshot(), []);
  assert.deepEqual(JSON.parse(saved).entries.map(entry => entry.scope), ['node:b']);
  assert.equal(JSON.parse(trace.text()).capture.enabled, false);
  trace.setEnabled(true); assert.deepEqual(trace.snapshot(), []);
});

test('upload logs expose transport, byte counts, deadline or HTTP failure without file names or error bodies', () => {
  const trace = createConnectionTrace(undefined, { enabled: true });
  trace.add({ type: 'file-ended', route: 'https', loadedBytes: 1048576, totalBytes: 5242880, durationMs: 30000, reason: 'http-status', status: 524, outcome: 'unknown', windowChunks:16, chunkAckMs:100, chunkMaxAckMs:300, bufferWaitMs:5, fileReadMs:12, name: 'PRIVATE_FILENAME', error: 'PRIVATE_RESPONSE', content: 'PRIVATE_BYTES' }, { mode: 'service' });
  const event = trace.snapshot()[0];
  assert.match(traceDescription(event), /HTTPS.*1048576 \/ 5242880.*结果未知/);
  assert.equal(event.status, 524); assert.equal(event.durationMs, 30000);
  assert.match(traceDescription(event), /分块确认 100 ms.*文件读取 12 ms/);
  assert.ok(!trace.text().includes('PRIVATE_'));
});

test('capture metadata explains bounded history, duplicate lifecycle events and page reloads', () => {
  let time = 1700000000000, saved;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const trace = createConnectionTrace(() => time, { enabled: true, storage, scope: 'node:a', wallNow: () => time });
  assert.equal(trace.add({ type: 'network-change', reason: 'hidden' }, { mode: 'terminal', view: 2 }), true);
  time += 20; assert.equal(trace.add({ type: 'network-change', reason: 'hidden' }, { mode: 'terminal', view: 2 }), false);
  trace.add({ type: 'network-change', reason: 'visible' }, { mode: 'terminal', view: 2 }); trace.flush();
  assert.equal(JSON.parse(trace.text()).capture.suppressedEvents, 1);
  const restored = createConnectionTrace(() => time, { enabled: true, storage, scope: 'node:a', wallNow: () => time });
  restored.add({ type: 'path-active', path: 'direct' }, { mode: 'terminal', view: 2 }); restored.flush();
  assert.equal(restored.snapshot().at(-1).page, 2); assert.equal(JSON.parse(restored.text()).capture.page, 2);
  for (let i = 0; i < 500; i++) { time++; restored.add({ type: 'heartbeat-ok', rttMs: i }, { mode: 'service' }); }
  assert.ok(JSON.parse(restored.text()).capture.droppedEvents > 0);
  assert.equal(restored.snapshot().length, TRACE_LIMITS.events); assert.ok(Buffer.byteLength(restored.text()) <= TRACE_LIMITS.bytes);
  time += TRACE_LIMITS.ageMs + 1; assert.deepEqual(restored.snapshot(), []); assert.equal(restored.latest('terminal', 2), undefined);
  restored.clear();
});
