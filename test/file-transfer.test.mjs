import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileDownload, observeUploadProgress } from '../panel/public/file-transfer.js';
import { createFileBuffer, FILE_MAX } from '../panel/public/file-wire.js';

test('file buffering handles tiny chunks, empty files and incomplete or oversized bodies with fixed byte bounds', async () => {
  const buffer = createFileBuffer(70000);
  for (let i = 0; i < 70000; i++) buffer.append(new Uint8Array([i % 251]));
  const bytes = new Uint8Array(await buffer.blob().arrayBuffer()); assert.equal(bytes.length, 70000);
  assert.ok(bytes.every((value, i) => value === i % 251));
  assert.equal(createFileBuffer(0).blob().size, 0);
  assert.throws(() => createFileBuffer(FILE_MAX + 1));
  assert.throws(() => createFileBuffer(2).append(new Uint8Array(3)));
  assert.throws(() => createFileBuffer(2).blob(), /不完整/);
});

test('HTTP download progress measures bytes read and never produces a truncated file', async () => {
  let controller; const progress = [];
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = readFileDownload(new Response(stream, { headers: { 'content-length': '6' } }), 6, undefined, n => progress.push(n));
  controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4, 5, 6])); controller.close();
  assert.deepEqual([...new Uint8Array(await (await pending).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(progress, [0, 2, 6]);
  await assert.rejects(readFileDownload(new Response(new Uint8Array(2)), 3), /不完整/);
  await assert.rejects(readFileDownload(new Response(new Uint8Array(4)), 3), /大小已变化/);
});

test('canceling a stalled HTTP body cancels its reader and never produces a download', async () => {
  const abort = new AbortController(); let canceled = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2)); }, cancel() { canceled++; } });
  const pending = readFileDownload(new Response(stream), 4, abort.signal, n => { if (n === 2) abort.abort(Error('user canceled')); });
  await assert.rejects(pending, /user canceled/); assert.equal(canceled, 1);
});

test('stopping progress observation aborts its one pending read and discards late results', async () => {
  let entered, finish, signal; const started = new Promise(resolve => { entered = resolve; }), values = [];
  const stop = observeUploadProgress(value => { signal = value; entered(); return new Promise(resolve => { finish = resolve; }); }, value => values.push(value));
  try { await started; stop(); assert.equal(signal.aborted, true); finish({ loaded: 1, total: 2 }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(values, []); }
  finally { stop(); }
});
