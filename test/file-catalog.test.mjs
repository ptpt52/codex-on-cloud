import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createFileCatalog, FILE_CATALOG_LIMITS } from '../panel/file-catalog.mjs';
import { readFilePages, FILE_PAGE_LIMITS } from '../panel/public/file-list.js';
import { localServiceRequest } from '../panel/service-rtc.mjs';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';

const listing = (count = 1000, padding = 180) => ({ uploadProtocol: 1, deleteProtocol: 1, quotaProtocol: 1, truncated: false,
  files: Array.from({ length: count }, (_, n) => ({ name: String(n).padStart(4, '0') + '-' + 'x'.repeat(padding) + '.txt', size: 1, modified: 1, version: 'a'.repeat(64) })) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('large catalogs use one stable census, bounded RPC pages and preserve all protocol flags', async t => {
  const catalog = createFileCatalog(); t.after(() => catalog.close()); const original = listing(); let loads = 0, pages = 0;
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 240 * 1024);
  const result = await readFilePages(async page => {
    const value = await catalog.read('login', page, async () => { loads++; return original; }, undefined, FILE_PAGE_LIMITS.pageItems);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= FILE_PAGE_LIMITS.pageBytes); pages++;
    if (pages === 1) original.files[999].name = 'changed-outside-snapshot';
    return value;
  });
  assert.equal(loads, 1); assert.equal(pages, 2); assert.equal(result.files.length, 1000);
  assert.match(result.files[999].name, /^0999-x/); assert.equal(result.truncated, false); assert.equal(result.quotaProtocol, 1);
  const fresh = await readFilePages(page => catalog.read('login', page, async () => original));
  assert.equal(fresh.files[999].name, 'changed-outside-snapshot');
});

test('catalog cursors are isolated by login, expire and evict with bounded counts and bytes', async t => {
  let now = 0; const catalog = createFileCatalog(() => now); t.after(() => catalog.close());
  const load = async () => listing(129), start = owner => catalog.read(owner, '1', load);
  const a = await start('a');
  await assert.rejects(catalog.read('b', a.next, load), { status: 410 });
  await start('a'); await start('a'); await assert.rejects(catalog.read('a', a.next, load), { status: 410 });
  const b = await start('b'); await start('c'); await start('d'); await start('e'); await start('f');
  await assert.rejects(catalog.read('b', b.next, load), { status: 410 });
  const current = await start('now'); now += FILE_CATALOG_LIMITS.ageMs;
  await assert.rejects(catalog.read('now', current.next, load), { status: 410 });
  const heavy = async () => listing(1000, 1500), first = await catalog.read('one', '1', heavy);
  await catalog.read('two', '1', heavy); await catalog.read('three', '1', heavy);
  await assert.rejects(catalog.read('one', first.next, load), { status: 410 });
  for (const page of ['', '0', '../files', 'a'.repeat(32) + '.1000', first.snapshot + '.0']) await assert.rejects(catalog.read('one', page, load), { status: 400 });
});

test('unadvertised clients retain 128-item pages while large pages are byte-bounded', async t => {
  const catalog = createFileCatalog(); t.after(() => catalog.close());
  const original = listing(), old = await catalog.read('a', '1', async () => original);
  assert.equal(old.files.length, 128);
  const wide = await catalog.read('a', '1', async () => original, undefined, 1000);
  assert.ok(wide.files.length > 128); assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= FILE_PAGE_LIMITS.pageBytes);
  assert.equal((await catalog.read('a', old.next)).offset, 128);
  await assert.rejects(catalog.read('a', '1', async () => original, undefined, 1001), { status: 400 });
});

test('cancelled initial reads retain admission until settlement and shutdown prevents late snapshots', async () => {
  const catalog = createFileCatalog(), gate = deferred(), controller = new AbortController(); let loads = 0, scope;
  const load = signal => { loads++; scope = signal; return gate.promise; };
  const first = catalog.read('a', '1', load, controller.signal), second = catalog.read('b', '1', load);
  const settled = Promise.allSettled([first, second]); controller.abort();
  await assert.rejects(catalog.read('c', '1', load), { status: 429 }); assert.equal(loads, 2);
  catalog.close(); assert.equal(scope.aborted, true); gate.resolve(listing(129));
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.name, 'AbortError'); }
  await assert.rejects(catalog.read('d', '1', load), { status: 503 });
});

test('invalid or oversized catalogs cannot replace an existing snapshot', async t => {
  const catalog = createFileCatalog(); t.after(() => catalog.close());
  const first = await catalog.read('a', '1', async () => listing(129));
  for (const value of [{ files: [] , quotaProtocol: '1' }, listing(1001), listing(1000, 2200), listing(1, FILE_PAGE_LIMITS.pageBytes)]) {
    await assert.rejects(catalog.read('a', '1', async () => value), { status: 502 });
  }
  assert.equal((await catalog.read('a', first.next)).files.length, 1);
});

test('browser page assembly accepts legacy lists but never publishes partial or inconsistent catalogs', async () => {
  const legacy = listing(3); assert.equal(await readFilePages(async () => legacy), legacy);
  const first = { ...listing(1), filePageProtocol: 1, snapshot: 'a'.repeat(32), offset: 0, total: 2, next: 'a'.repeat(32) + '.1' };
  const last = { ...first, offset: 1, next: null };
  for (const changed of [{ snapshot: 'b'.repeat(32) }, { total: 3 }, { offset: 0 }, { quotaProtocol: 0 }, { files: [] }, { next: 'invalid' }, { filePageProtocol: undefined }]) {
    let calls = 0; await assert.rejects(readFilePages(async () => ++calls === 1 ? first : { ...last, ...changed })); assert.equal(calls, 2);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readFilePages(async () => { calls++; controller.abort(); return first; }, controller.signal), { name: 'AbortError' }); assert.equal(calls, 1);
  await assert.rejects(readFilePages(async page => page === '1' ? first : Promise.reject(Error('page lost'))), /page lost/);
});

test('service pagination accepts only validated cursors on its fixed entry path', async t => {
  const paths = [], capabilities = [], server = http.createServer((req, res) => { paths.push(req.url); capabilities.push(req.headers['x-codex-file-page-items']); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const read = body => localServiceRequest(server.address().port, {}, 'files', body, new AbortController().signal, '/node/example/');
  await read({ page: '1' }); await read({ page: 'a'.repeat(32) + '.128', pageItems: 1000 });
  for (const body of [{ page: '../../etc' }, { page: '1&url=/api/security' }, { page: 1 }, { page: '1', url: '/api/security' }, { page: '1', pageItems: 1001 }, { page: '1', pageItems: '1000' }]) await assert.rejects(read(body), { status: 400 });
  assert.deepEqual(paths, ['/node/example/api/files?page=1', '/node/example/api/files?page=' + 'a'.repeat(32) + '.128']); assert.deepEqual(capabilities, [undefined, '1000']);
});

test('1000 long filenames stay on real service DTLS, keep legacy HTTP and fresh upload quota checks', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close());
  for (const file of listing().files) app.files.set(file.name, Buffer.from('x'));
  await app.login(); await app.claim();
  await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
  const client = await serviceClient(app); t.after(() => client.close()); let pages = 0;
  const baseline = app.received.filter(req => req.url === '/files').length;
  const value = await readFilePages(async page => {
    const reply = await client.rpc('files', { page, pageItems: 1000 }); assert.equal(reply.ok, true); pages++;
    return reply.value;
  });
  assert.equal(pages, 2); assert.equal(value.files.length, 1000); assert.equal(app.received.filter(req => req.url === '/files').length - baseline, 1);
  assert.equal((await client.rpc('ping')).value.ready, true);
  const shared = await (await client.request('/api/files?page=1')).json();
  assert.equal((await client.rpc('files', { page: shared.next })).value.offset, 128);
  assert.equal((await (await app.request('/api/files')).json()).files.length, 1000);
  const first = await (await app.request('/api/files?page=1')).json();
  assert.equal((await client.request('/api/files?page=' + first.next)).status, 410);
  for (const suffix of ['?page=../x', '?page=1&page=1', '?page=1&url=state']) assert.equal((await app.request('/api/files' + suffix)).status, 400);
  // A cached, complete catalog must not hide a directory that has since grown.
  app.files.set('added-after-snapshot', Buffer.from('new'));
  const denied = await fetch(app.config.origin + '/api/files/new.txt', { method: 'PUT', headers: { ...client.headers, 'if-none-match': '*' }, body: 'must not be sent' });
  assert.equal(denied.status, 413); assert.equal(app.files.has('new.txt'), false);
  assert.equal((await (await app.request('/api/files')).json()).truncated, true);
  await app.request('/api/logout', { method: 'POST' });
  assert.equal((await app.request('/api/files?page=' + first.next)).status, 401);
  assert.deepEqual(app.inputCalls, []);
});
