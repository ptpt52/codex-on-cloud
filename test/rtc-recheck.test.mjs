import test from 'node:test';
import assert from 'node:assert/strict';
import { createRTCRecheck } from '../panel/public/rtc-recheck.js';
import { createConnectionTrace } from '../panel/public/connection-trace.js';

function browser(t) {
  for (const [name, value] of Object.entries({ document: { hidden: false }, navigator: { onLine: true } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; });
  }
}
function probe(t, overrides = {}) {
  browser(t);
  const trace = createConnectionTrace(undefined, { enabled: true }); let closes = 0;
  const candidate = { start: async () => {}, health: { ping: async () => {}, rttMs: 1 }, stats: async () => null, close: () => closes++ };
  const recheck = createRTCRecheck({ open: async () => candidate, current: () => null, allowed: () => true, idle: () => true,
    replace: async () => ({ retained: true, state: 'selected' }), trace: (type, value) => trace.add({ type, ...value }, { mode: 'terminal' }), ...overrides });
  return { recheck, candidate, trace, get closes() { return closes; } };
}

test('failed manual candidates report the unchanged automatic probe state separately', async t => {
  const p = probe(t, { probeStatus: () => ({ probe: 'stopped', probeReason: 'auth' }),
    open: async () => { throw Object.assign(Error('denied'), { reason: 'auth', status: 403 }); } });
  await p.recheck.run();
  assert.deepEqual({ ...p.trace.snapshot().at(-1), atMs: 0, time: 0, durationMs: 0 }, {
    atMs: 0, time: 0, page: 1, mode: 'terminal', standby: false, type: 'recheck-ended', path: 'direct', step: 'candidate',
    result: 'failed', reason: 'auth', status: 403, outcome: 'rejected', durationMs: 0, probe: 'stopped', probeReason: 'auth',
  });
});

for (const step of ['candidate', 'connect', 'health', 'stats', 'switch', 'commit']) test(`recheck failure at ${step} records its phase and preserves uncertainty after dispatch`, async t => {
  const p = probe(t), error = Object.assign(Error('PRIVATE_ERROR_BODY'), { code: step === 'health' ? 'heartbeat_timeout' : step === 'commit' ? 'rpc_timeout' : 'PRIVATE_CODE', reason: 'PRIVATE_REASON' });
  const fail = async () => { throw error; };
  if (step === 'candidate') p.recheck = createRTCRecheck({ open: fail, current: () => null, allowed: () => true, idle: () => true, replace: fail,
    trace: (type, value) => p.trace.add({ type, ...value }, { mode: 'terminal' }) });
  else if (step === 'connect') p.candidate.start = fail;
  else if (step === 'health') p.candidate.health.ping = fail;
  else if (step === 'stats') p.candidate.stats = fail;
  else p.recheck = createRTCRecheck({ open: async () => p.candidate, current: () => null, allowed: () => true, idle: () => true,
    replace: async (_candidate, _signal, commit) => { if (step === 'commit') assert.equal(commit(), true); throw error; },
    trace: (type, value) => p.trace.add({ type, ...value }, { mode: 'terminal' }) });
  const reports = []; await p.recheck.run(value => reports.push(value));
  const end = p.trace.snapshot().at(-1);
  assert.equal(end.type, 'recheck-ended'); assert.equal(end.step, step); assert.equal(end.result, 'failed');
  assert.equal(end.outcome, ['switch', 'commit'].includes(step) ? 'unknown' : 'rejected');
  assert.equal(end.reason, step === 'health' ? 'heartbeat' : step === 'commit' ? 'rpc-timeout' : 'connection');
  assert.equal(p.closes, step === 'candidate' ? 0 : 1); assert.equal(p.recheck.running, false);
  assert.equal(reports.at(-1).state, 'failed'); assert.equal(p.trace.text().includes('PRIVATE_'), false);
  assert.ok(p.trace.snapshot().length <= 3);
});

test('a refused activation keeps its explicit rejected result rather than reporting an unknown commit', async t => {
  const p = probe(t, { replace: async (_candidate, _signal, commit) => { commit(); throw Object.assign(Error('PRIVATE_REFUSAL'), { status: 409, outcome: 'rejected' }); } });
  await p.recheck.run(); const end = p.trace.snapshot().at(-1);
  assert.equal(end.step, 'commit'); assert.equal(end.status, 409); assert.equal(end.reason, 'http-status'); assert.equal(end.outcome, 'rejected');
  assert.equal(p.trace.text().includes('PRIVATE_'), false);
});

test('recheck cancellation before a handoff is canceled while cancellation after dispatch stays unknown', async t => {
  browser(t);
  for (const committed of [false, true]) {
    const events = []; let recheck;
    recheck = createRTCRecheck({ allowed: () => true, idle: () => true, current: () => null,
      open: async () => ({ start: async () => {}, health: { ping: async () => {} }, stats: async () => { if (!committed) recheck.cancel(); }, close() {} }),
      replace: async (_candidate, _signal, commit) => { commit(); recheck.cancel({ force: true }); throw Error('cancelled'); },
      trace: (type, value) => events.push({ type, ...value }) });
    await recheck.run(); const end = events.at(-1);
    assert.equal(end.result, 'cancelled'); assert.equal(end.reason, 'aborted'); assert.equal(end.outcome, committed ? 'unknown' : 'canceled');
  }
});

test('a failing diagnostic sink cannot stop a successful candidate adoption', async t => {
  const p = probe(t, { trace() { throw Error('diagnostic sink unavailable'); } });
  const reports = []; await p.recheck.run(value => reports.push(value));
  assert.equal(p.closes, 0); assert.equal(p.recheck.running, false); assert.equal(reports.at(-1).state, 'selected');
});

for (const step of ['candidate', 'connect', 'health', 'stats', 'current']) test(`cancellation releases a recheck blocked at ${step} and ignores late completion`, { timeout: 2000 }, async t => {
  let entered, release, pings = 0, stats = 0, replacements = 0;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const block = () => { entered(); return held; };
  const p = probe(t, { replace: async () => { replacements++; return { retained: true, state: 'selected' }; },
    ...(step === 'current' ? { current: block } : {}) });
  p.candidate.health.ping = () => { pings++; return step === 'health' ? block() : Promise.resolve(); };
  p.candidate.stats = () => { stats++; return step === 'stats' ? block() : Promise.resolve(null); };
  if (step === 'connect') p.candidate.start = block;
  if (step === 'candidate') p.recheck = createRTCRecheck({ allowed: () => true, idle: () => true, current: () => null,
    open: async () => { await block(); return p.candidate; }, replace: async () => { replacements++; } });
  const pending = p.recheck.run(); await started; p.recheck.cancel(); await pending;
  assert.equal(p.recheck.running, false); assert.equal(p.closes, step === 'candidate' ? 0 : 1);
  if (step === 'health') { assert.equal(pings, 1); assert.equal(stats, 0); }
  release(null); await new Promise(setImmediate);
  assert.equal(p.closes, 1); assert.equal(replacements, 0);
});

test('a late canceled open cannot replace or close a newly adopted candidate', async t => {
  browser(t); let entered, release, opens = 0, oldCloses = 0, newCloses = 0;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const fresh = { start: async () => {}, health: { ping: async () => {} }, stats: async () => null, close: () => newCloses++ };
  const recheck = createRTCRecheck({ allowed: () => true, idle: () => true, current: () => null,
    open: async () => { if (++opens === 1) { entered(); await gate; return { close: () => oldCloses++ }; } return fresh; },
    replace: async candidate => { assert.equal(candidate, fresh); return { retained: true, state: 'selected' }; } });
  const old = recheck.run(); await started; recheck.cancel(); await old; await recheck.run();
  release(); await new Promise(setImmediate);
  assert.equal(opens, 2); assert.equal(oldCloses, 1); assert.equal(newCloses, 0);
});

test('soft cancellation preserves a committed promotion and forced shutdown waits for its cleanup', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const p = probe(t, { replace: async (_candidate, _signal, commit) => { assert.equal(commit(), true); entered(); await gate; return undefined; } });
  const pending = p.recheck.run(); await started; p.recheck.cancel();
  assert.equal(p.recheck.running, true); assert.equal(p.closes, 0);
  p.recheck.cancel({ force: true }); assert.equal(p.recheck.running, true); assert.equal(p.closes, 1);
  release(); await pending; assert.equal(p.recheck.running, false); assert.equal(p.closes, 1);
  assert.equal(p.trace.snapshot().at(-1).result, 'cancelled'); assert.equal(p.trace.snapshot().at(-1).outcome, 'unknown');
});
