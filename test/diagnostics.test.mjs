import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createTunnelDiagnostics } from '../panel/diagnostics.mjs';
import { fixture } from './fixture.mjs';

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/diag/tunnel`;
}

test('diagnostics require login and expose only active connection counts', async t => {
  const app = await fixture(); t.after(() => app.close());
  assert.equal((await app.request('/api/diagnostics')).status, 401);
  assert.equal(app.received.filter(item => item.url === '/diag/tunnel').length, 0);
  await app.login();
  const response = await app.request('/api/diagnostics');
  assert.equal(response.status, 200);
  const { tunnel } = await response.json();
  assert.deepEqual({ ...tunnel, checkedAt: 0 }, { available: true, connections: 3, ipv4: 1, ipv6: 2, checkedAt: 0 });
  assert.ok(tunnel.checkedAt > 0);
  const serialized = JSON.stringify(tunnel);
  assert.ok(!serialized.includes('private-') && !serialized.includes('2001:db8') && !serialized.includes('192.0.2'));
  const upstream = app.received.find(item => item.url === '/diag/tunnel');
  assert.equal(upstream.headers.cookie, undefined);
  assert.equal(upstream.headers.authorization, undefined);
});

test('concurrent diagnostic reads share a bounded single request and cache', async t => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const url = await endpoint(t, async (_req, res) => {
    calls++; await gate;
    res.end(JSON.stringify({ connections: [] }));
  });
  const read = createTunnelDiagnostics(url);
  const pending = Array.from({ length: 12 }, () => read());
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(results[0].connections, 0);
  assert.deepEqual(await read(), results[0]);
  assert.equal(calls, 1);
});

test('the native empty-connection response is reported as zero instead of unavailable', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify({
    tunnelID: '00000000-0000-0000-0000-000000000001', connectorID: '00000000-0000-0000-0000-000000000002',
  })));
  const result = await createTunnelDiagnostics(url)();
  assert.deepEqual({ ...result, checkedAt: 0 }, { available: true, connections: 0, ipv4: 0, ipv6: 0, checkedAt: 0 });
});

test('invalid and oversized diagnostic responses remain unknown instead of reporting disconnected', async t => {
  for (const body of ['not json', JSON.stringify({ connections: Array(65).fill({}) }), JSON.stringify({ connections: [{}] }), JSON.stringify({ connections: [{ isConnected: true, edgeAddress: 'invalid' }] }), 'x'.repeat(32 * 1024 + 1)]) {
    const url = await endpoint(t, (_req, res) => res.end(body));
    const result = await createTunnelDiagnostics(url)();
    assert.equal(result.available, false);
    assert.equal(result.connections, null);
    assert.equal(result.ipv6, null);
  }
});

test('diagnostics reject arbitrary endpoints and do not follow redirects', async t => {
  for (const url of ['https://127.0.0.1/diag/tunnel', 'http://example.com/diag/tunnel', 'http://127.0.0.1/config', 'http://user:password@127.0.0.1/diag/tunnel', 'http://127.0.0.1/diag/tunnel?url=http://example.com']) assert.throws(() => createTunnelDiagnostics(url));
  let calls = 0;
  const target = await endpoint(t, (_req, res) => { calls++; res.end('{}'); });
  const source = await endpoint(t, (_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  assert.equal((await createTunnelDiagnostics(source)()).available, false);
  assert.equal(calls, 0);
});

test('slow or missing diagnostics do not block other panel requests', { timeout: 5000 }, async t => {
  const url = await endpoint(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const app = await fixture({ tunnelDiagnosticsUrl: url }); t.after(() => app.close());
  await app.login();
  const pending = app.request('/api/diagnostics');
  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal((await (await pending).json()).tunnel.available, false);
  assert.equal((await createTunnelDiagnostics()()).available, false);
});
