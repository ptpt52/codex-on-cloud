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
  assert.throws(() => transfers.begin(next.req, next.res, () => true, true), /繁忙/);
  upload.finish();
  const replacement = transfers.begin(next.req, next.res, () => true, true); replacement.finish();
  for (const transfer of others) transfer.finish(); admin.res.emit('close'); assert.equal(persistent.signal.aborted, true);
});

test('caller cancellation hides progress and retains its slot until upstream cleanup finishes', t => {
  const transfers = createFileTransfers({ limit: 1 }); t.after(() => transfers.close());
  const first = channel(), second = channel(), id = 'a'.repeat(32);
  const transfer = transfers.begin(first.req, first.res, () => true, false, { owner: 'fixture', id, size: 4 });
  first.req.emit('aborted');
  assert.equal(transfer.signal.aborted, true); assert.throws(transfer.check, { status: 401 });
  assert.throws(() => transfers.progress('fixture', id), { status: 404 });
  assert.throws(() => transfers.begin(second.req, second.res, () => true), /繁忙/);
  transfer.advance(4); transfer.finish(); transfer.finish();
  transfers.begin(second.req, second.res, () => true).finish();
  assert.equal(first.req.listenerCount('aborted'), 0); assert.equal(first.res.listenerCount('close'), 0);
});

test('a transfer deadline closes a stalled response and releases its capacity', async t => {
  const transfers = createFileTransfers({ limit: 1, timeoutMs: 20 }); t.after(() => transfers.close());
  const first = channel(), transfer = transfers.begin(first.req, first.res, () => true);
  await Promise.race([once(first.res, 'close'), new Promise((_, reject) => setTimeout(() => reject(Error('deadline did not close response')), 500))]);
  assert.equal(transfer.signal.aborted, true); assert.equal(first.res.destroyed, true);
  const second = channel(); transfers.begin(second.req, second.res, () => true).finish();
});

test('large download deadlines cover the HTTP bridge while uploads retain their five-minute budget', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const transfers = createFileTransfers({ downloadTimeoutMs: 1800000 }); t.after(() => transfers.close());
  const download = channel(), small = channel(), upload = channel();
  download.req.method = small.req.method = 'GET'; upload.req.method = 'PUT';
  const downloading = transfers.begin(download.req, download.res, () => true);
  const smallDownload = transfers.begin(small.req, small.res, () => true);
  const uploading = transfers.begin(upload.req, upload.res, () => true);
  t.mock.timers.tick(1000);
  downloading.extendDownloadDeadline();
  t.mock.timers.tick(299000);
  assert.equal(uploading.signal.aborted, true); assert.equal(smallDownload.signal.aborted, true); assert.equal(downloading.signal.aborted, false);
  t.mock.timers.tick(1500000); assert.equal(downloading.signal.aborted, true); assert.equal(download.res.destroyed, true);
  assert.throws(() => createFileTransfers({ downloadTimeoutMs: 1800001 }));
});

test('stalled downloads keep one slot available for writes and release on idle after cleanup', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const transfers = createFileTransfers({ maxDownloads: 3, downloadIdleMs: 60_000 });
  t.after(() => transfers.close());
  const begin = method => {
    const { req, res } = channel(); req.method = method; res.headersSent = true;
    return transfers.begin(req, res, () => true);
  };
  const [active, ...stalled] = Array.from({ length: 3 }, () => begin('GET'));
  assert.throws(() => begin('GET'), { status: 503 });
  begin('PUT').finish(); begin('POST').finish();
  t.mock.timers.tick(50_000);
  active.downloadProgress();
  t.mock.timers.tick(10_000);
  assert.equal(active.signal.aborted, false);
  for (const transfer of stalled) assert.throws(transfer.check, { status: 408 });
  assert.throws(() => begin('GET'), { status: 503 });
  for (const transfer of stalled) transfer.finish();
  begin('GET').finish();
  t.mock.timers.tick(50_000);
  assert.throws(active.check, { status: 408 });
});
