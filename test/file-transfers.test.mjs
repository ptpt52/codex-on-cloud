import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFileTransfers } from '../panel/file-transfers.mjs';
import { once } from 'node:events';

function channel() {
  const req = new EventEmitter(), res = new EventEmitter();
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return { req, res };
}
test('file transfers cap concurrent streams, serialize temporary uploads, and revoke only the expired session', t => {
  const transfers = createFileTransfers(); t.after(() => transfers.close()); let guestValid = true;
  const guest = channel(), upload = transfers.begin(guest.req, guest.res, () => guestValid, true);
  const next = channel(); assert.throws(() => transfers.begin(next.req, next.res, () => true, true), /繁忙/);
  const admin = channel(), persistent = transfers.begin(admin.req, admin.res, () => true);
  const others = Array.from({ length: 2 }, () => { const c = channel(); return transfers.begin(c.req, c.res, () => true); });
  assert.throws(() => transfers.begin(next.req, next.res, () => true), /繁忙/);
  guestValid = false; transfers.revalidate(); assert.equal(upload.signal.aborted, true); assert.equal(guest.res.destroyed, true);
  assert.equal(persistent.signal.aborted, false); assert.throws(upload.check, { status: 401 });
  const replacement = transfers.begin(next.req, next.res, () => true, true); replacement.finish();
  for (const transfer of others) transfer.finish(); admin.res.emit('close'); assert.equal(persistent.signal.aborted, true);
});

test('a transfer deadline closes a stalled response and releases its capacity', async t => {
  const transfers = createFileTransfers({ limit: 1, timeoutMs: 20 }); t.after(() => transfers.close());
  const first = channel(), transfer = transfers.begin(first.req, first.res, () => true);
  await Promise.race([once(first.res, 'close'), new Promise((_, reject) => setTimeout(() => reject(Error('deadline did not close response')), 500))]);
  assert.equal(transfer.signal.aborted, true); assert.equal(first.res.destroyed, true);
  const second = channel(); transfers.begin(second.req, second.res, () => true).finish();
});
