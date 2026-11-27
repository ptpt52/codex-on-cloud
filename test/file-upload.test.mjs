import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { uploadOptions, uploadHeaders, readUploadHeaders, uploadResult, validTransferName, transferFilePath, quoteFilePath } from '../panel/public/file-upload.js';
import { settings } from '../native/config.mjs';

test('transfer paths are absolute, bounded and quoted as literal shell arguments', () => {
  const name = "中 文'$(never)`echo no`.txt", path = transferFilePath('/work dir/transfer///', name);
  assert.equal(path, '/work dir/transfer/' + name);
  assert.equal(quoteFilePath(path), "'/work dir/transfer/中 文'\\''$(never)`echo no`.txt'");
  assert.equal(transferFilePath('/', 'root.txt'), '/root.txt');
  for (const directory of ['', 'relative/path', '/path\nsecret', '/' + '中'.repeat(1400)]) assert.throws(() => transferFilePath(directory, 'ok.txt'));
  for (const invalid of ['../escape', '.', '..', 'newline\n', '中'.repeat(86)]) assert.throws(() => transferFilePath('/safe', invalid));
});

test('existing filename validation accepts Unix names while uploads retain portable bounds', () => {
  for (const name of ['中'.repeat(81) + '.txt', 'x'.repeat(255), 'literal\\backslash']) {
    assert.equal(validTransferName(name), true);
    assert.equal(validTransferName(name, true), false);
    assert.equal(transferFilePath('/safe', name), '/safe/' + name);
  }
  assert.equal(validTransferName('\ufeffbom'), true);
  for (const name of ['x'.repeat(256), 'bad\nname', 'bad\udcff', '../outside', '.upload-private']) assert.equal(validTransferName(name), false);
});

test('HTTP downloads accept existing long and backslash names but uploads remain restricted', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  for (const name of ['中'.repeat(81) + '.txt', 'literal\\backslash']) {
    app.files.set(name, Buffer.from('kept'));
    const path = '/api/files/' + encodeURIComponent(name), response = await app.request(path);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'kept');
    assert.equal((await app.request(path, { method: 'PUT', raw: 'changed' })).status, 400);
    assert.equal(app.files.get(name).toString(), 'kept');
  }
});

test('independent file helper port defaults to the desktop helper and rejects invalid ports', () => {
  assert.equal(settings({ AGENT_PORT: '31001' }).fileAgentPort, 31001);
  assert.equal(settings({ FILE_AGENT_PORT: '31002' }).fileAgentPort, 31002);
  for (const value of ['-1', '22', '65536', '1.5', 'url']) assert.throws(() => settings({ FILE_AGENT_PORT: value }), /FILE_AGENT_PORT/);
});

test('an independent file helper serves every file route while desktop health retains its original helper', async t => {
  const app = await fixture(); t.after(() => app.close()); const files = await fixture(); t.after(() => files.close());
  await app.login(); app.config.fileAgentUrl = files.config.agentUrl;
  const result = await app.request('/api/files/independent.txt', { method: 'PUT', raw: 'independent files' });
  assert.equal(result.status, 200); assert.equal(files.files.get('independent.txt').toString(), 'independent files'); assert.equal(app.files.size, 0);
  assert.equal((await (await app.request('/api/files')).json()).files[0].name, 'independent.txt');
  assert.equal(await (await app.request('/api/files/independent.txt')).text(), 'independent files');
  assert.equal((await (await app.request('/api/state')).json()).desktop.ready, true);
  assert.equal(app.received.some(r => r.url === '/health'), true); assert.equal(files.received.some(r => r.url === '/health'), false);
  await files.close(); app.files.set('must-not-read', Buffer.from('old helper'));
  assert.equal((await app.request('/api/files')).status, 502); assert.equal(app.received.some(r => r.url === '/files'), false, 'unavailable file helper cannot fall back to the old helper');
});

test('upload conditions default to create and require an exact version for replacement', () => {
  const version = 'a'.repeat(64);
  for (const policy of [{ mode: 'create' }, { mode: 'rename' }, { mode: 'replace', version }]) {
    assert.deepEqual(readUploadHeaders(uploadHeaders(policy)), policy);
  }
  assert.deepEqual(readUploadHeaders({}), { mode: 'create' });
  for (const value of [null, {}, { mode: 'replace' }, { mode: 'replace', version: '*' }, { mode: 'create', version }, { mode: 'rename', extra: true }]) assert.throws(() => uploadOptions(value), { status: 400 });
  for (const headers of [{ 'if-match': '"' + version + '"' }, { 'x-codex-upload-mode': 'replace', 'if-match': '*' }, { 'x-codex-upload-mode': 'rename', 'if-none-match': '*' }, { 'if-none-match': 'anything' }, { 'x-codex-upload-mode': 'replace', 'if-match': '"' + version + '"', 'if-none-match': '*' }]) assert.throws(() => readUploadHeaders(headers), { status: 400 });
});

test('upload completion requires a valid actual filename and reports incomplete replies as unknown', () => {
  assert.equal(uploadResult({ ok: true, name: '资料 (2).txt' }).name, '资料 (2).txt');
  for (const value of [null, {}, { ok: true }, { name: 'missing-ok' }, { ok: true, name: '' }, { ok: true, name: '../outside' }, { ok: true, name: '.upload-private' }, { ok: true, name: '资'.repeat(81) }]) assert.throws(() => uploadResult(value), { status: 502, outcome: 'unknown' });
});

test('HTTP uploads preserve same-name content, enforce versions, rename and retain write authentication', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  app.files.set('keep.txt', Buffer.from('original'));
  const version = (await (await app.request('/api/files')).json()).files[0].version;
  const put = (mode, bytes, extra = {}) => app.request('/api/files/keep.txt', { method: 'PUT', raw: bytes, headers: { ...uploadHeaders(mode), ...extra } });
  assert.equal((await put({ mode: 'create' }, 'unconfirmed')).status, 409);
  const rejection = await (await put({ mode: 'create' }, 'unconfirmed')).json();
  assert.equal(rejection.outcome, 'rejected'); assert.equal(rejection.fileCode, 'file_exists');
  assert.equal(app.files.get('keep.txt').toString(), 'original');
  assert.equal(app.received.filter(r => r.method === 'PUT').length, 0);
  assert.equal((await put({ mode: 'replace', version }, 'blocked', { 'x-csrf-token': '' })).status, 403);
  assert.equal((await put({ mode: 'replace', version }, 'blocked', { origin: 'https://attacker.example' })).status, 403);
  const renamed = await put({ mode: 'rename' }, 'another'); assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, 'keep (2).txt'); assert.equal(app.files.get('keep (2).txt').toString(), 'another');
  assert.equal(app.files.get('keep.txt').toString(), 'original');
  assert.equal((await put({ mode: 'replace', version }, 'confirmed')).status, 200);
  assert.equal((await put({ mode: 'replace', version }, 'stale')).status, 412);
  assert.equal(app.files.get('keep.txt').toString(), 'confirmed');
  assert.match((await app.request('/api/files/keep.txt')).headers.get('etag'), /^"[a-f0-9]{64}"$/);
});

test('HTTP helper busy errors are rejected without losing structured reasons or retrying content', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); let puts = 0;
  const busy = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PUT') { puts++; for await (const _chunk of req) {} res.writeHead(409); return res.end(JSON.stringify({ error: '正在上传其他文件，请稍后重试', fileCode: 'file_busy' })); }
    res.end(JSON.stringify({ uploadProtocol: 1, files: [] }));
  });
  busy.listen(0, '127.0.0.1'); await once(busy, 'listening'); t.after(() => new Promise(resolve => { busy.close(resolve); busy.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + busy.address().port;
  const result = await app.request('/api/files/new', { method: 'PUT', raw: 'test' });
  assert.equal(result.status, 409); const body = await result.json(); assert.equal(body.outcome, 'rejected'); assert.equal(body.fileCode, 'file_busy'); assert.equal(puts, 1);
});

for (const status of [409, 507]) test(`early HTTP helper rejection ${status} flushes its result and closes incomplete uploads`, { timeout: 15000 }, async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close()); await app.login();
  const outgoing = [], incoming = []; let puts = 0;
  t.after(() => { for (const req of outgoing) req.destroy(); });
  app.panel.server.on('request', req => {
    if (req.method === 'PUT') incoming.push({ req, closed: new Promise(resolve => req.once('close', resolve)) });
  });
  const helper = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'PUT') return res.end(JSON.stringify({ uploadProtocol: 1, files: [] }));
    puts++;
    // Native quota/disk checks can reject before reading any of the body.
    res.writeHead(status); res.end(JSON.stringify({ error: 'early rejection', ...(status === 409 ? { fileCode: 'file_busy' } : {}) }));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening');
  t.after(() => new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  for (let index = 0; index < 8; index++) {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(app.config.origin + '/api/files/incomplete-' + index, { method: 'PUT', agent: false, headers: {
        origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'content-length': 1024 * 1024, connection: 'keep-alive',
      } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      outgoing.push(req); req.on('error', reject); req.write('a'); // Deliberately never finish the body.
    });
    assert.equal(result.status, status); assert.equal(result.connection, 'close');
    assert.equal(result.body.error, 'early rejection'); assert.equal(result.body.outcome, 'rejected');
    if (status === 409) assert.equal(result.body.fileCode, 'file_busy');
  }
  let timer;
  try {
    await Promise.race([Promise.all(incoming.map(item => item.closed)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('incomplete upload connections remained open')), 3000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(incoming.length, 8); assert.equal(puts, 8, 'one helper write per upload, without replay');
  assert.ok(incoming.every(({ req }) => req.destroyed && req.socket.destroyed && !req.complete));
  assert.ok(incoming.every(({ req }) => req.listenerCount('data') === 0), 'upload transforms must be unpiped');
});

test('successful HTTP uploads preserve bytes and reuse their keep-alive connection', async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close()); await app.login();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  for (let index = 0; index < 2; index++) {
    const bytes = Buffer.alloc(64 * 1024, index + 1), name = 'complete-' + index;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(app.config.origin + '/api/files/' + name, { method: 'PUT', agent, headers: {
        origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'content-length': bytes.length,
      } }, res => {
        res.on('error', reject); res.resume();
        res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, reused: req.reusedSocket }));
      });
      req.on('error', reject); req.end(bytes);
    });
    assert.equal(result.status, 200); assert.equal(result.connection, 'keep-alive'); assert.equal(result.reused, index > 0);
    assert.deepEqual(app.files.get(name), bytes);
  }
});

test('an old helper cannot silently bypass safe uploads', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); let puts = 0;
  const old = http.createServer((req, res) => { if (req.method === 'PUT') puts++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ files: [] })); });
  old.listen(0, '127.0.0.1'); await once(old, 'listening'); t.after(() => new Promise(resolve => old.close(resolve)));
  app.config.agentUrl = 'http://127.0.0.1:' + old.address().port;
  const result = await app.request('/api/files/new', { method: 'PUT', raw: 'must not send' });
  assert.equal(result.status, 503); assert.match((await result.json()).error, /更新/); assert.equal(puts, 0);
});

test('HTTPS uploads require a complete success reply from the file helper', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  let uploads = 0, complete = false;
  const helper = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the admitted upload */ }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/files') return res.end(JSON.stringify({ files: [], uploadProtocol: 1 }));
    uploads++;
    res.end(JSON.stringify(complete ? { ok: true, name: 'upload (2).bin', size: 3 } : { ok: true }));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening');
  t.after(() => new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }));
  app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  const upload = () => app.request('/api/files/upload.bin', { method: 'PUT', raw: 'abc', headers: uploadHeaders({ mode: 'rename' }) });
  const unknown = await upload();
  assert.equal(unknown.status, 502);
  assert.equal((await unknown.json()).outcome, 'unknown');
  assert.equal(uploads, 1);
  complete = true;
  const saved = await upload();
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, name: 'upload (2).bin', size: 3 });
  assert.equal(uploads, 2);
});

test('guest rename consumes a new file quota while versioned replacement credits only its original file', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password' } })).status, 200);
  const login = await app.request('/api/login', { method: 'POST', body: { username: 'visitor', password: 'temporary-test-password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
  const put = policy => app.request('/api/files/keep', { method: 'PUT', raw: 'new', headers: { cookie, 'x-csrf-token': csrf, ...uploadHeaders(policy) } });
  app.files.set('keep', Buffer.from('old'));
  for (let index = 1; index < 1000; index++) app.files.set('item' + index, Buffer.alloc(0));
  let version = (await (await app.request('/api/files')).json()).files.find(file => file.name === 'keep').version;
  assert.equal((await put({ mode: 'rename' })).status, 413);
  assert.equal((await put({ mode: 'replace', version })).status, 200); assert.equal(app.files.size, 1000);
  app.files.clear(); app.files.set('keep', { length: 1024 * 1024 * 1024 });
  version = (await (await app.request('/api/files')).json()).files[0].version;
  assert.equal((await put({ mode: 'rename' })).status, 413);
  assert.equal((await put({ mode: 'replace', version })).status, 200); assert.equal(app.files.get('keep').toString(), 'new');
  app.files.clear(); app.files.set('keep', Buffer.from('original'));
  for (let index = 1; index < 1001; index++) app.files.set('item' + index, Buffer.alloc(0));
  const listing = (await (await app.request('/api/files')).json());
  assert.equal(listing.files.length, 1000); assert.equal(listing.truncated, true);
  version = listing.files[0].version;
  assert.equal((await put({ mode: 'replace', version })).status, 413);
  assert.equal(app.files.get('keep').toString(), 'original');
  assert.equal(app.received.filter(req => req.method === 'PUT').every(req => req.headers['x-codex-upload-quota'] === 'temporary-v1'), true);
});
