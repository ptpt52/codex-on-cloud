import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FILE_DOWNLOAD_MAX } from '../panel/public/file-wire.js';

const source = readFileSync(new URL('../panel/public/file-download/worker.js', import.meta.url), 'utf8');
function worker(t) {
  const handlers = {}, timers = new Map(); let next = 0;
  const self = { registration: { scope: 'https://desk.example/node/home/file-download/' }, clients: { claim: async () => {} }, addEventListener: (name, fn) => { handlers[name] = fn; } };
  vm.runInNewContext(source, { self, URL, Response, ReadableStream, TextEncoder, ArrayBuffer, Uint8Array, setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: id => timers.delete(id) });
  const open = (change = {}, owner = 'page-1', url = self.registration.scope + 'bridge.html') => {
    const sent = [], port = { closed: false, postMessage: value => sent.push(value), close() { this.closed = true; } };
    const value = { type: 'download-open', token: 'a'.repeat(32), name: '中文.bin', size: 262144, ...change };
    handlers.message({ data: value, ports: [port], source: { id: owner, url }, waitUntil() { throw Error('Download registration must not retain a long-running event'); } });
    return { value, sent, port, send: data => port.onmessage?.({ data }) };
  };
  const fetch = (entry, change = {}) => {
    let response;
    handlers.fetch({ request: { url: self.registration.scope + 'save/' + entry.value.token, method: 'GET', mode: 'navigate', referrer: self.registration.scope + 'bridge.html', ...change.request }, clientId: change.clientId ?? 'page-1', respondWith: value => { response = value; }, waitUntil() { throw Error('A complete transfer must not be an event lifetime promise'); } });
    return response;
  };
  t.after(() => { timers.clear(); });
  return { open, fetch, timers };
}

test('streaming worker denies unowned paths, different clients and replay while preserving the authorized job', async t => {
  const w = worker(t), entry = w.open();
  assert.equal(w.fetch(entry, { clientId: 'another-page' }).status, 404);
  assert.equal(w.fetch(entry, { clientId: '', request: { referrer: 'https://other.example/' } }).status, 404);
  const response = w.fetch(entry); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8/);
  assert.equal(w.fetch(entry).status, 404);
  const reader = response.body.getReader(), pending = reader.read(); await new Promise(setImmediate);
  assert.equal(entry.sent.filter(value => value.type === 'pull').length, 1);
  entry.send({ type: 'chunk', bytes: new Uint8Array(262144).fill(37).buffer });
  const first = await pending; assert.equal(first.value.length, 262144); assert.equal(first.value[0], 37);
  entry.send({ type: 'end' }); assert.equal((await reader.read()).done, true);
  assert.equal(entry.sent.at(-1).type, 'done'); assert.equal(entry.port.closed, true); assert.equal(w.timers.size, 0);
});

test('download navigations without a client ID require the exact originating bridge referrer', async t => {
  const w = worker(t), entry = w.open({ size: 0 });
  assert.equal(w.fetch(entry, { clientId: '', request: { mode: 'cors' } }).status, 404);
  assert.equal(w.fetch(entry, { clientId: '' }).status, 200);
  entry.send({ type: 'end' }); assert.equal(entry.sent.at(-1).type, 'done');
});

test('download grants are bounded to two jobs and one per client, and unused grants expire', t => {
  const w = worker(t), first = w.open(), duplicateOwner = w.open({ token: 'b'.repeat(32) });
  assert.equal(duplicateOwner.sent.at(-1).type, 'error'); assert.equal(duplicateOwner.port.closed, true);
  const second = w.open({ token: 'b'.repeat(32) }, 'page-2'); assert.equal(second.sent.at(-1).type, 'ready');
  const third = w.open({ token: 'c'.repeat(32) }, 'page-3'); assert.equal(third.sent.at(-1).type, 'error');
  [...w.timers.values()].find(value => value.ms === 10000).fn();
  assert.equal(first.port.closed, true);
  const fresh = w.open({ token: 'c'.repeat(32) }, 'page-3'); assert.equal(fresh.sent.at(-1).type, 'ready');
  second.send({ type: 'abort' }); fresh.send({ type: 'abort' }); assert.equal(w.timers.size, 0);
});

for (const change of [{ size: FILE_DOWNLOAD_MAX + 1 }, { size: -1 }, { name: 'bad\r\nname' }, { name: 'n'.repeat(256) }, { name: '\ud800' }, { token: 'invalid' }]) test('streaming worker rejects invalid metadata ' + JSON.stringify(change), t => {
  const w = worker(t), entry = w.open(change);
  assert.equal(entry.sent.at(-1).type, 'error'); assert.equal(entry.port.closed, true); assert.equal(w.timers.size, 0);
});

test('backpressure grants one block only after a reader pulls; cancellation frees its grant', async t => {
  const w = worker(t), entry = w.open({ size: 2 * 262144 }), response = w.fetch(entry);
  assert.equal(entry.sent.some(value => value.type === 'pull'), false);
  const reader = response.body.getReader(), pending = reader.read(); await new Promise(setImmediate);
  entry.send({ type: 'chunk', bytes: new ArrayBuffer(262144) }); await pending; await new Promise(setImmediate);
  assert.equal(entry.sent.filter(value => value.type === 'pull').length, 1, 'the worker must not prefetch another block');
  await reader.cancel(); assert.equal(entry.sent.at(-1).reason, 'consumer-cancel'); assert.equal(w.timers.size, 0);
});

test('unsolicited or oversized blocks and early end records fail the stream instead of growing a queue', async t => {
  for (const record of [{ type: 'chunk', bytes: new ArrayBuffer(1) }, { type: 'end' }]) {
    const w = worker(t), entry = w.open(), response = w.fetch(entry), reader = response.body.getReader();
    entry.send(record);
    await assert.rejects(reader.read()); assert.equal(entry.sent.at(-1).type, 'error'); assert.equal(w.timers.size, 0);
  }
});
