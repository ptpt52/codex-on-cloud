import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSession, STREAM_LIMIT } from '../panel/stream-session.mjs';
const id = 'a'.repeat(32), tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  const writes = []; let callbacks, launches = 0, ended = 0;
  const session = createStreamSession({ id, valid: () => true, ...options,
    connect(value) { callbacks = value; launches++; return { write: bytes => writes.push(bytes.toString()), close: () => ended++, pause() {}, resume() {} }; } });
  const peer = kind => { const records = []; let closed = false; const entry = session.attach(kind, { send: value => records.push(value), buffered: () => 0, close: () => { closed = true; } }); return { entry, records, get closed() { return closed; } }; };
  return { session, peer, writes, push: text => callbacks.push(Buffer.from(text)), get launches() { return launches; }, get ended() { return ended; } };
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
