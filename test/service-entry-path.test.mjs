// Exercise the service adapters with real loopback HTTP and an in-memory file
// channel. ICE/DTLS and desktop processes are outside these regression tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { localServiceRequest } from '../panel/service-rtc.mjs';
import { attachServiceFiles } from '../panel/service-files.mjs';
import { createFileClient } from '../panel/public/file-client.js';

async function setup(t, entryBasePath) {
  const app = await fixture({ entryBasePath, nodeId: 'a'.repeat(32), sharedEntry: entryBasePath === '/', forwardPorts: '*' });
  t.after(() => app.close());
  const { cookie, csrf } = await app.login(); await app.claim();
  const headers = { host: new URL(app.config.origin).host, origin: app.config.origin, cookie,
    'x-csrf-token': csrf, 'x-viewer-id': app.viewer, 'x-codex-node': app.config.nodeId };
  const signal = new AbortController().signal, port = app.panel.server.address().port;
  const rpc = (action, body = {}, extra = {}) => localServiceRequest(port, { ...headers, ...extra }, action, body, signal, entryBasePath);
  return { app, headers, rpc, signal, port };
}

for (const base of ['/', '/node/service-test/']) {
  test(`service mapping grants at ${base} retain entry routing and HTTP authorization`, async t => {
    const { app, rpc } = await setup(t, base);
    assert.equal((await rpc('state')).mine, true);
    assert.deepEqual((await rpc('forward-list')).mappings, []);
    await assert.rejects(rpc('forward-create', { localPort: 2222, targetPort: 22 }, { 'x-csrf-token': '' }), { status: 403 });
    await assert.rejects(rpc('forward-create', { localPort: 2222, targetPort: 22 }, { origin: 'https://evil.example' }), { status: 403 });
    for (const body of [{ localPort: 2222, targetPort: 22 },
      { direction: 'reverse', localPort: 22001, targetHost: '192.168.1.1', targetPort: 22, deviceName: 'router', protocol: 'ssh' }]) {
      const created = await rpc('forward-create', body);
      assert.equal(created.code.length, 43);
      assert.equal((await rpc('forward-list')).mappings[0].id, created.id);
      assert.equal((await rpc('forward-hints', { id: created.id, hints: {} })).ok, true);
      assert.equal((await rpc('forward-stop', { id: created.id })).ok, true);
    }
    assert.deepEqual((await rpc('forward-list')).mappings, []);
    await assert.rejects(rpc('__proto__'), { status: 400 });
    await app.request('/api/logout', { method: 'POST', body: {} });
    await assert.rejects(rpc('forward-create', { localPort: 2222, targetPort: 22 }), { status: 401 });
    assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
  });
}

test('prefixed service file transfers use the same entry for uploads, downloads and conflict checks', async t => {
  const base = '/node/service-files/', { app, headers, signal, port, rpc } = await setup(t, base);
  const listeners = {}, events = new EventTarget(); let closed = false;
  const close = () => { if (closed) return; closed = true; events.dispatchEvent(new Event('close')); listeners.state?.('closed'); };
  const serverChannel = { readyState: 'open', bufferedAmount: 0, close: () => setImmediate(close),
    send: data => setImmediate(() => { if (!closed) events.dispatchEvent(new MessageEvent('message', { data })); }),
    onMessage: { subscribe: fn => { listeners.message = fn; } }, stateChange: { subscribe: fn => { listeners.state = fn; } }, error: { subscribe() {} } };
  const server = attachServiceFiles(serverChannel, { valid: () => true, headers, port: () => port, signal, fail() {}, entryBasePath: base });
  const client = createFileClient({ get readyState() { return closed ? 'closed' : 'open'; }, bufferedAmount: 0, close,
    send: data => setImmediate(() => { if (!closed) listeners.message(data); }), addEventListener: (...args) => events.addEventListener(...args) });
  t.after(() => { client.close(); server.close(); });
  const bytes = Buffer.alloc(64 * 1024, 173);
  await client.upload(new File([bytes], '入口 中文.bin'));
  assert.deepEqual(app.files.get('入口 中文.bin'), bytes);
  assert.deepEqual(Buffer.from(await (await client.download('入口 中文.bin', bytes.length)).arrayBuffer()), bytes);
  const file = (await rpc('files')).files[0];
  await client.upload(new File(['replacement'], file.name), { mode: 'replace', version: file.version });
  await assert.rejects(client.upload(new File(['stale'], file.name), { mode: 'replace', version: file.version }), { status: 412 });
  assert.equal(app.files.get(file.name).toString(), 'replacement');
  assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
});

test('prefixed service requests keep temporary accounts restricted to their own reverse grants', async t => {
  const base = '/node/guest/', { app, headers, signal, port } = await setup(t, base);
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 300000 } })).status, 200);
  const response = await app.request('/api/login', { method: 'POST', headers: { cookie: '' }, body: { username: 'visitor', password: 'temporary-test-password' } });
  assert.equal(response.status, 200);
  const guest = { ...headers, cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await response.json()).csrf };
  const rpc = (action, body = {}) => localServiceRequest(port, guest, action, body, signal, base);
  assert.equal((await rpc('state')).access.role, 'temporary');
  await assert.rejects(rpc('forward-create', { localPort: 2222, targetPort: 22 }), { status: 403 });
  const created = await rpc('forward-create', { direction: 'reverse', localPort: 22001, targetPort: 22, deviceName: 'guest device', protocol: 'ssh' });
  assert.equal(created.code.length, 43);
  assert.equal((await rpc('forward-stop', { id: created.id })).ok, true);
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: false } })).status, 200);
  await assert.rejects(rpc('forward-list'), { status: 401 });
  assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
});
