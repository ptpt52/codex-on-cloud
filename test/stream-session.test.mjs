import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSession, STREAM_LIMIT } from '../panel/stream-session.mjs';
const id = 'a'.repeat(32), tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  const writes = [], connections = []; let callbacks, launches = 0, ended = 0;
  const session = createStreamSession({ id, valid: () => true, ...options,
    connect(value) { callbacks = value; connections.push(value); launches++; return { write: bytes => writes.push(bytes.toString()), close: () => ended++, pause() {}, resume() {} }; } });
  const peer = kind => { const records = []; let closed = false; const entry = session.attach(kind, { send: value => records.push(value), buffered: () => 0, close: () => { closed = true; } }); return { entry, records, get closed() { return closed; } }; };
  return { session, peer, writes, connections, push: text => callbacks.push(Buffer.from(text)), get launches() { return launches; }, get ended() { return ended; } };
}
async function activate(peer, epoch, out = 0, input = 0) { peer.entry.receive({ type: 'activate', epoch, out, input }); await tick(); }
const input = (epoch, id, data) => ({ type: 'input', epoch, id, part: 0, parts: 1, data: Buffer.from(data).toString('base64') });
test('one upstream survives relay/direct handoffs; standby gets no output and old epochs cannot write', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'), direct = app.peer('direct');
  await activate(relay, 0); app.push('first');
  assert.equal(app.launches, 1); assert.equal(direct.records.filter(x => x.type === 'chunk').length, 0);
  await activate(direct, 1); assert.equal(app.launches, 1);
  assert.equal(direct.records.find(x => x.type === 'chunk').data, Buffer.from('first').toString('base64'));
  relay.entry.receive(input(1, 1, 'never')); direct.entry.receive(input(2, 1, 'once')); await tick();
  assert.deepEqual(app.writes, ['once']);
  direct.entry.close(); await activate(relay, 2, 5, 1); app.push('second');
  assert.equal(app.launches, 1); assert.equal(app.ended, 0); assert.equal(relay.records.at(-1).at, 5);
});
test('acknowledged output is released, duplicate acknowledgements are safe, and missing input is never replayed', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay');
  await activate(relay, 0); app.push('abc'); relay.entry.receive({ type: 'ack', epoch: 1, at: 3 }); await tick();
  assert.equal(app.session.retained, 0);
  relay.entry.receive({ type: 'ack', epoch: 1, at: 3 }); await tick(); assert.equal(app.session.closed, false);
  const direct = app.peer('direct'); await activate(direct, 1, 3, 1);
  assert.equal(direct.records.find(x => x.type === 'reset').reason, 'input-unknown'); assert.equal(app.session.closed, true); assert.deepEqual(app.writes, []);
});
test('a partial fragmented input is bounded and is never forwarded or resumed as a prompt', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'); await activate(relay, 0);
  relay.entry.receive({ ...input(1, 1, 'half'), parts: 2 }); await tick(); assert.deepEqual(app.writes, []);
  relay.entry.close(); const direct = app.peer('direct'); await activate(direct, 1, 0, 1);
  assert.equal(app.session.closed, true); assert.deepEqual(app.writes, []);
});
test('orphan expiry and the output resource bound release the viewer, never restart its desktop', async () => {
  const app = setup({ ttl: 25 }); const relay = app.peer('relay'); await activate(relay, 0); relay.entry.close();
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(app.session.closed, true); assert.equal(app.ended, 1);
  const large = setup(); const next = large.peer('relay'); await activate(next, 0); large.push('x'.repeat(STREAM_LIMIT + 1)); assert.equal(large.session.closed, true);
});
test('delayed activation is rejected after authorization changes', async t => {
  let allowed = true, release; const hold = new Promise(resolve => { release = resolve; });
  const app = setup({ valid: () => allowed, canActivate: async () => { await hold; return true; } }); t.after(() => app.session.close());
  const relay = app.peer('relay'); relay.entry.receive({ type: 'activate', epoch: 0, out: 0, input: 0 }); allowed = false; release(); await tick();
  assert.equal(app.launches, 0); assert.equal(app.session.closed, true);
});
test('a resume offset acknowledges delivered output even when the old ACK was lost', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'); await activate(relay, 0);
  app.push('x'.repeat(256 * 1024)); assert.equal(app.session.retained, 256 * 1024);
  const direct = app.peer('direct'); await activate(direct, 1, 256 * 1024);
  assert.equal(app.session.retained, 0); app.push('live'); assert.equal(direct.records.at(-1).type, 'chunk'); assert.equal(app.launches, 1);
});
test('a planned hold buffers output until its new writer is committed, or cancellation restores the old writer', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'); await activate(relay, 0);
  relay.entry.receive({ type: 'hold', epoch: 1 }); await tick(); app.push('held');
  assert.equal(relay.records.at(-1).type, 'held');
  relay.entry.receive({ type: 'unhold', epoch: 1 }); await tick(); assert.equal(relay.records.at(-1).type, 'chunk');
  relay.entry.receive({ type: 'hold', epoch: 1 }); await tick(); app.push('next');
  const direct = app.peer('direct'); await activate(direct, 1, 4);
  assert.equal(Buffer.from(direct.records.at(-1).data, 'base64').toString(), 'next'); assert.equal(app.launches, 1);
});

test('the candidate fences the old writer without a relay acknowledgement and replays only undelivered output', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'), direct = app.peer('direct');
  await activate(relay, 0); app.push('seen'); relay.entry.receive({ type: 'ack', epoch: 1, at: 4 });
  app.push('in flight');
  direct.entry.receive({ type: 'prepare', id: 1, epoch: 1, out: 4, input: 0 }); await tick();
  assert.equal(direct.records.at(-1).type, 'prepared'); app.push(' after fence');
  assert.equal(relay.records.filter(v => v.type === 'chunk').length, 2);
  direct.entry.receive({ type: 'activate', epoch: 1, out: 4, input: 0, handoff: 1 }); await tick();
  assert.equal(direct.entry.active, true); assert.equal(app.launches, 1);
  assert.equal(direct.records.filter(v => v.type === 'chunk').map(v => Buffer.from(v.data, 'base64').toString()).join(''), 'in flight after fence');
  relay.entry.receive(input(1, 1, 'late old writer')); direct.entry.receive(input(2, 1, 'new writer')); await tick(); assert.deepEqual(app.writes, ['new writer']);
});

test('cancelling a candidate releases its fence, while stale tickets and a detached candidate cannot commit', async t => {
  const app = setup(); t.after(() => app.session.close()); const relay = app.peer('relay'), direct = app.peer('direct'); await activate(relay, 0);
  direct.entry.receive({ type: 'prepare', id: 1, epoch: 1, out: 0, input: 0 }); await tick(); app.push('buffered');
  relay.entry.receive({ type: 'cancel-prepare', id: 1, epoch: 1 }); await tick(); assert.equal(relay.records.at(-1).type, 'active');
  direct.entry.receive({ type: 'cancel-prepare', id: 1, epoch: 1 }); await tick(); assert.equal(relay.records.at(-1).type, 'chunk');
  direct.entry.receive({ type: 'activate', epoch: 1, out: 0, input: 0, handoff: 1 }); await tick(); assert.equal(direct.records.at(-1).type, 'wait'); assert.equal(relay.entry.active, true);
  direct.entry.receive({ type: 'prepare', id: 2, epoch: 1, out: 0, input: 0 }); await tick(); app.push('still live'); direct.entry.close();
  assert.equal(relay.records.at(-1).type, 'chunk'); assert.equal(relay.entry.active, true); assert.equal(app.ended, 0);
});

test('a delayed cancelled or revoked prepare cannot freeze or acquire the original stream', async t => {
  let release, delay = false, allowed = true; const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ valid: () => allowed, canActivate: async () => { if (delay) await gate; return true; } }); t.after(() => app.session.close());
  const relay = app.peer('relay'), direct = app.peer('direct'); await activate(relay, 0); delay = true;
  direct.entry.receive({ type: 'prepare', id: 1, epoch: 1, out: 0, input: 0 }); direct.entry.receive({ type: 'cancel-prepare', id: 1, epoch: 1 }); release(); await tick();
  app.push('not frozen'); assert.equal(relay.records.at(-1).type, 'chunk'); assert.equal(direct.records.at(-1).type, 'wait');
  allowed = false; direct.entry.receive({ type: 'prepare', id: 2, epoch: 1, out: 0, input: 0 }); await tick(); assert.equal(app.session.closed, true);
});

test('direct read RPC is bounded independently of input and never runs on a standby or relay', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ performPanel: async action => { calls++; if (action === 'state') await gate; return { available: true }; } }); t.after(() => app.session.close());
  const relay = app.peer('relay'), direct = app.peer('direct'); await activate(relay, 0);
  direct.entry.receive({ type: 'panel', id: 1, epoch: 1, action: 'state' }); await tick(); assert.equal(calls, 0);
  await activate(direct, 1); direct.entry.receive({ type: 'panel', id: 1, epoch: 2, action: 'state' }); direct.entry.receive({ type: 'panel', id: 2, epoch: 2, action: 'terminals' });
  direct.entry.receive({ type: 'panel', id: 3, epoch: 2, action: 'state' }); direct.entry.receive(input(2, 1, 'independent input')); await tick();
  assert.equal(calls, 2); assert.deepEqual(app.writes, ['independent input']); assert.equal(direct.records.find(v => v.type === 'panel-result' && v.id === 3).error.status, 429);
  release(); await tick(); assert.equal(direct.records.find(v => v.type === 'panel-result' && v.id === 1).ok, true);
  relay.entry.receive({ type: 'panel', id: 4, epoch: 2, action: 'state' }); await tick(); assert.equal(calls, 2); assert.equal(direct.entry.active, true);
});

for (const kind of ['direct', 'relay']) test(`${kind}: switching a terminal retires old output callbacks and preserves input sequencing on the same peer`, async t => {
  let target = 'main';
  const app = setup({ switchTarget: async next => ({ target: next, commit() { target = next.terminalId; } }) }); t.after(() => app.session.close());
  const direct = app.peer(kind); await activate(direct, 0); app.push('old screen');
  direct.entry.receive(input(1, 1, 'old input')); await tick();
  direct.entry.receive({ type: 'switch-terminal', id: 1, epoch: 1, input: 1, target: { terminalId: 'aux1', terminalToken: '%1:4100' } }); await tick();
  const switched = direct.records.find(v => v.type === 'switched'); assert.equal(switched.epoch, 2); assert.equal(switched.out, 10); assert.equal(target, 'aux1'); assert.equal(app.launches, 2);
  app.connections[0].push(Buffer.from('must not leak')); app.connections[0].close(); assert.equal(app.session.closed, false);
  app.push('new screen'); assert.equal(Buffer.from(direct.records.at(-1).data, 'base64').toString(), 'new screen');
  direct.entry.receive(input(1, 2, 'retired epoch')); direct.entry.receive(input(2, 2, 'new input')); await tick(); assert.deepEqual(app.writes, ['old input', 'new input']);
});

test('a rejected target or raced input keeps the original terminal; revoked asynchronous reads and switches cannot commit', async t => {
  let release, allowed = true, committed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ valid: () => allowed, performPanel: async () => { await gate; return { private: true }; }, switchTarget: async target => {
    if (target.terminalToken === 'stale') throw Object.assign(Error('identity changed'), { status: 409 });
    await gate; return { target, commit() { committed = true; } };
  } }); t.after(() => app.session.close()); const direct = app.peer('direct'); await activate(direct, 0);
  direct.entry.receive({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalToken: 'stale' } }); await tick(); assert.equal(direct.records.at(-1).type, 'switch-result'); assert.equal(app.ended, 0);
  direct.entry.receive({ type: 'panel', id: 1, epoch: 1, action: 'state' });
  direct.entry.receive({ type: 'switch-terminal', id: 2, epoch: 1, input: 0, target: { terminalId: 'aux1', terminalToken: '%1:4100' } }); await tick(); allowed = false; release(); await tick();
  assert.equal(committed, false); assert.equal(app.session.closed, true); assert.equal(direct.records.some(v => v.type === 'panel-result'), false); assert.deepEqual(app.writes, []);
});

test('read snapshots cannot cross a committed target epoch and oversized results cannot fill the stream', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ performPanel: async action => action === 'state' ? (await gate, { old: true }) : { data: 'x'.repeat(16384) }, switchTarget: async target => ({ target, commit() {} }) }); t.after(() => app.session.close());
  const direct = app.peer('direct'); await activate(direct, 0);
  direct.entry.receive({ type: 'panel', id: 1, epoch: 1, action: 'state' }); direct.entry.receive({ type: 'panel', id: 2, epoch: 1, action: 'terminals' }); await tick();
  assert.equal(direct.records.find(v => v.type === 'panel-result' && v.id === 2).error.status, 413);
  direct.entry.receive({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalId: 'aux1', terminalToken: '%1:4100' } }); await tick(); release(); await tick();
  assert.equal(direct.records.some(v => v.type === 'panel-result' && v.id === 1), false); assert.equal(app.session.closed, false);
});

for (const kind of ['direct', 'relay']) test(`${kind}: input arriving during target validation rejects the switch without losing or replaying that input`, async t => {
  let release, committed = false; const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ switchTarget: async target => { await gate; return { target, commit() { committed = true; } }; } }); t.after(() => app.session.close());
  const direct = app.peer(kind); await activate(direct, 0); direct.entry.receive({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalId: 'aux1', terminalToken: '%1:4100' } }); await tick();
  direct.entry.receive(input(1, 1, 'accepted once')); release(); await tick();
  assert.equal(committed, false); assert.equal(direct.records.at(-1).type, 'switch-result'); assert.deepEqual(app.writes, ['accepted once']); assert.equal(app.launches, 1);
});

test('a standby cannot switch targets and a revoked relay cannot commit its pending target change', async t => {
  let allowed = true, release, committed = false; const gate = new Promise(resolve => { release = resolve; });
  const app = setup({ valid: () => allowed, switchTarget: async target => { await gate; return { target, commit() { committed = true; } }; } });
  t.after(() => app.session.close()); const relay = app.peer('relay'), direct = app.peer('direct'); await activate(relay, 0);
  const request = { type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalId: 'aux1', terminalToken: '%1:4100' } };
  direct.entry.receive(request); await tick(); assert.equal(app.launches, 1); assert.equal(direct.records.length, 1);
  relay.entry.receive(request); await tick(); allowed = false; release(); await tick();
  assert.equal(committed, false); assert.equal(app.session.closed, true); assert.deepEqual(app.writes, []);
});

test('attachment failure after committing a target closes the viewer instead of reporting the old target as preserved', async t => {
  let launches = 0, committed = false; const records = [];
  const session = createStreamSession({ id, valid: () => true,
    switchTarget: async target => ({ target, commit() { committed = true; } }),
    connect() { if (++launches > 1) throw Error('attachment failed'); return { write() {}, close() {}, pause() {}, resume() {} }; } });
  t.after(() => session.close());
  const entry = session.attach('direct', { send: value => records.push(value), buffered: () => 0, close() {} });
  await activate({ entry }, 0);
  entry.receive({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalId: 'aux1', terminalToken: '%1:4100' } }); await tick();
  assert.equal(committed, true); assert.equal(session.closed, true);
  assert.equal(records.some(value => value.type === 'switch-result'), false); assert.equal(records.at(-1).type, 'switched');
});
