import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfferQueue, createOfferBridge, OFFER_LIMITS } from '../panel/public/rtc-offers.js';

test('offer admission is bounded, FIFO within live priority, and queued cancellation frees capacity', async () => {
  const queue = createOfferQueue(), order = [];
  const release = await queue.acquire();
  let standbyPriority = 2;
  const standby = queue.acquire({ priority: () => standbyPriority }).then(done => { order.push('standby'); done(); });
  const service = queue.acquire({ priority: () => 1 }).then(done => { order.push('service'); done(); });
  const controller = new AbortController();
  const canceled = queue.acquire({ signal: controller.signal });
  assert.equal(queue.size, OFFER_LIMITS.requests);
  await assert.rejects(queue.acquire(), { reason: 'busy' });
  controller.abort(); await assert.rejects(canceled, { name: 'AbortError' });
  const active = queue.acquire({ priority: () => 0 }).then(done => { order.push('active'); done(); });
  standbyPriority = 0; // A foreground swap updates a request already in queue.
  release(); await Promise.all([standby, service, active]);
  assert.deepEqual(order, ['standby', 'active', 'service']); assert.equal(queue.size, 0);
});

test('offer cancellation and lease expiry release the active permit exactly once', async () => {
  const queue = createOfferQueue({ leaseMs: 30 }); let expired = 0;
  const release = await queue.acquire({ expired: () => expired++ });
  const second = queue.acquire(); const releaseSecond = await second;
  assert.equal(expired, 1); release(); assert.equal(queue.size, 1);
  releaseSecond(); assert.equal(queue.size, 0);
  const controller = new AbortController(); await queue.acquire({ signal: controller.signal });
  controller.abort(); assert.equal(queue.size, 0);
  const bounded = createOfferQueue({ waitMs: 10, leaseMs: 100 });
  const done = await bounded.acquire(); await assert.rejects(bounded.acquire(), { reason: 'queue-timeout' }); done();
  assert.equal(bounded.size, 0);
});

test('frame bridge ignores malformed and stale releases, refuses duplicates, and clears retired frames', async () => {
  const replies = [], entry = { epoch: 1 }, other = { epoch: 2 };
  const bridge = createOfferBridge({ reply: (entry, value) => replies.push({ entry, ...value }) });
  const request = (entry, id, type = 'request') => bridge.message(entry, { type: 'codex-rtc-offer-' + type, id });
  assert.equal(request(entry, -1), true); assert.equal(replies.length, 0);
  request(entry, 1); await Promise.resolve(); assert.equal(replies[0].ok, true);
  request(entry, 2); assert.equal(replies.at(-1).ok, false);
  request(entry, 99, 'release'); request(other, 3); await Promise.resolve();
  assert.equal(replies.some(value => value.id === 3), false);
  bridge.cancel(entry); await Promise.resolve(); assert.equal(replies.at(-1).id, 3); assert.equal(replies.at(-1).ok, true);
  bridge.clear();
});

test('frame admission reports queue expiry distinctly from an immediate capacity refusal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replies = [], active = { epoch: 1 }, queued = { epoch: 2 };
  const bridge = createOfferBridge({ reply: (entry, value) => replies.push({ entry, ...value }) });
  try {
    bridge.message(active, { type: 'codex-rtc-offer-request', id: 1 }); await Promise.resolve();
    bridge.message(queued, { type: 'codex-rtc-offer-request', id: 2 });
    t.mock.timers.tick(OFFER_LIMITS.waitMs); await Promise.resolve();
    assert.deepEqual(replies.at(-1), { entry: queued, type: 'codex-rtc-offer-result', frame: '2', id: 2, ok: false, reason: 'queue-timeout' });
  } finally { bridge.clear(); }
});
