import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionTrace, createTraceReporter, connectionProgress, TRACE_LIMITS, TRACE_STORAGE_KEY, traceDescription } from '../panel/public/connection-trace.js';

test('recheck completion restores automatic probe status without confusing candidate failure with retry policy', () => {
  assert.deepEqual(connectionProgress('recheck-ended', { path: 'direct', reason: 'connection', probe: 'stopped', probeReason: 'auth' }), { probe: 'stopped', probeReason: 'auth' });
  assert.deepEqual(connectionProgress('recheck-ended', { path: 'direct', reason: 'auth', probe: 'ready', probeReason: 'PRIVATE' }), { probe: 'ready' });
  const trace = createConnectionTrace(undefined, { enabled: true });
  trace.add({ type: 'recheck-ended', probe: 'PRIVATE', probeReason: 'PRIVATE' }, { mode: 'terminal' });
  trace.add({ type: 'heartbeat-ok', probe: 'stopped', probeReason: 'auth' }, { mode: 'terminal' });
  assert.ok(trace.snapshot().every(event => !Object.hasOwn(event, 'probe') && !Object.hasOwn(event, 'probeReason')));
  assert.ok(!trace.text().includes('PRIVATE'));
});
test('routine samples cannot evict fault and lifecycle evidence; operational progress remains payload-free', () => {
  let time = 1700000000000;
  const trace = createConnectionTrace(() => time, { enabled: true, wallNow: () => time });
  const milestones = ['view-start', 'probe-stopped', 'session-ended', 'path-active', 'first-frame', 'heartbeat-timeout', 'input-pressure'];
  for (const type of milestones) {
    time++; trace.add({ type, path: 'direct', reason: 'auth' }, { mode: 'terminal', view: 1 });
  }
  for (let n = 0; n < 600; n++) { time++; trace.add({ type: 'heartbeat-ok', rttMs: n }, { mode: 'service' }); }
  const events = trace.snapshot();
  assert.equal(events.length, TRACE_LIMITS.events); assert.deepEqual(events.slice(0, milestones.length).map(value => value.type), milestones);
  assert.equal(events.at(-1).rttMs, 599); assert.ok(Buffer.byteLength(trace.text()) <= TRACE_LIMITS.bytes);
  assert.deepEqual(connectionProgress('probe-stopped', { path: 'direct', reason: 'auth', error: 'PRIVATE_ERROR' }), { probe: 'stopped', probeReason: 'auth' });
  assert.equal(connectionProgress('heartbeat-ok', { path: 'direct' }), null);
  const current = JSON.parse(trace.text({ views: [{ mode: 'terminal', moduleReady: true, firstFrame: false, probe: 'stopped', probeReason: 'auth', text: 'PRIVATE_TEXT' }, { mode: 'desktop', probe: 'PRIVATE_STATE', probeReason: 'PRIVATE_REASON' }] })).current;
  assert.equal(current.views[0].moduleReady, true); assert.equal(current.views[0].firstFrame, false); assert.equal(current.views[0].probe, 'stopped');
  assert.equal(current.views[1].probe, undefined); assert.equal(JSON.stringify(current).includes('PRIVATE_'), false);
  time += TRACE_LIMITS.ageMs + 1; assert.deepEqual(trace.snapshot(), []);
});
test('recheck phases and results are whitelisted, readable and cannot expose raw errors', () => {
  const trace = createConnectionTrace(undefined, { enabled: true });
  trace.add({ type: 'recheck-ended', step: 'commit', result: 'failed', outcome: 'unknown', reason: 'rpc-timeout', durationMs: 8000, error: 'PRIVATE_ERROR', candidate: 'PRIVATE_ADDRESS' }, { mode: 'service' });
  trace.add({ type: 'recheck-ended', step: 'PRIVATE_STEP', result: 'PRIVATE_RESULT', reason: 'PRIVATE_REASON', status: 409 }, { mode: 'terminal' });
  trace.add({ type: 'path-lost', step: 'commit', result: 'failed' }, { mode: 'desktop' });
  const events = trace.snapshot();
  assert.match(traceDescription(events[0]), /开始提交切换.*本次重测失败.*结果未知/);
  assert.equal(events[1].step, undefined); assert.equal(events[1].result, undefined);
  assert.equal(events[2].step, undefined); assert.equal(events[2].result, undefined);
  assert.equal(trace.text().includes('PRIVATE_'), false);
});
test('RPC reasons and fixed action names survive export while arbitrary actions and sensitive fields do not', () => {
  const trace = createConnectionTrace(undefined, { enabled: true });
  trace.add({ type: 'rpc-failed', path: 'direct', reason: 'local-http-timeout', action: 'diagnostics', status: 504, outcome: 'unknown', durationMs: 6000, body: 'PRIVATE_BODY', error: 'PRIVATE_MESSAGE' }, { mode: 'service' });
  trace.add({ type: 'rpc-recovered', reason: 'late-reply', action: 'file-delete' }, { mode: 'service' });
  trace.add({ type: 'control-closed', reason: 'peer-closed', action: 'PRIVATE_ACTION' }, { mode: 'service' });
  const events = trace.snapshot(); assert.equal(events[0].action, 'diagnostics'); assert.equal(events[2].action, undefined);
  assert.match(traceDescription(events[0]), /节点本机服务请求超时.*连接诊断.*HTTP 504/);
  assert.match(traceDescription(events[1]), /删除文件/); assert.equal(trace.text().includes('PRIVATE_'), false);
});
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

for (const reason of ['file_read_failed', 'file_ack_timeout', 'file_buffer_timeout']) test(`${reason} survives private log persistence with a distinct readable cause`, () => {
  let saved;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const trace = createConnectionTrace(undefined, { enabled: true, storage, scope: 'node:fixture' });
  trace.add({ type: 'file-ended', route: 'direct', reason, outcome: 'unknown', loadedBytes: 0, totalBytes: 4,
    filename: 'PRIVATE_FILENAME', error: 'PRIVATE_PROVIDER_DETAIL', provider: 'PRIVATE_PROVIDER' }, { mode: 'service' });
  trace.flush();
  const restored = createConnectionTrace(undefined, { enabled: true, storage, scope: 'node:fixture' });
  const event = restored.snapshot().find(value => value.type === 'file-ended');
  assert.equal(event.reason, reason); assert.match(traceDescription(event), /本机文件读取失败|文件分块确认超时|文件发送缓冲超时/);
  assert.ok(!restored.text().includes('PRIVATE_'));
  trace.setEnabled(false); restored.setEnabled(false);
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
