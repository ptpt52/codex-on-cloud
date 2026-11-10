import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { gatewayHTTPFixture } from './gateway-http-fixture.mjs';
import { gatewayProxyHeaders } from '../gateway/protocol.mjs';

const raw = (options, body) => new Promise((resolve, reject) => { const req = http.request({ ...options, signal: AbortSignal.timeout(5000) }, res => { const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() })); }); req.on('error', reject); req.end(body); });

test('a fixed gateway reaches a private node with its public Host while preserving authentication, Origin and CSRF checks', async t => {
  const gateway = await gatewayHTTPFixture(); t.after(() => gateway.close()); const app = await gateway.add(1), node = app.gatewayEntry;
  assert.equal((await gateway.select(node.id)).status, 200);
  const html = await gateway.fetch(gateway.origin + '/'); assert.equal(html.status, 200); assert.match(await html.text(), /name="gateway-entry"/);
  const login = await gateway.fetch(gateway.origin + '/api/login', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json', 'x-codex-node': node.id }, body: JSON.stringify({ username: 'admin', password: app.config.password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
  const headers = { origin: gateway.origin, cookie, 'x-codex-node': node.id, 'content-type': 'application/json', 'x-csrf-token': csrf };
  assert.equal((await gateway.fetch(gateway.origin + '/api/me', { headers })).status, 200);
  assert.equal((await gateway.fetch(gateway.origin + '/api/logout', { method: 'POST', headers: { ...headers, origin: 'http://untrusted.invalid' }, body: '{}' })).status, 403);
  assert.equal((await gateway.fetch(gateway.origin + '/api/logout', { method: 'POST', headers: { ...headers, 'x-csrf-token': 'wrong' }, body: '{}' })).status, 403);
  assert.equal((await gateway.fetch(gateway.origin + '/api/me', { headers: { ...headers, 'x-codex-node': 'b'.repeat(32) } })).status, 409);
  assert.equal((await gateway.fetch(gateway.origin + '/api/me', { headers: { ...headers, cookie: '' } })).status, 401);
  assert.equal((await gateway.fetch(gateway.origin + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
});

test('gateway identity headers confer no trust over loopback TCP, a wrong backend Host, or a wrong private credential', async t => {
  const gateway = await gatewayHTTPFixture(); t.after(() => gateway.close()); const app = await gateway.add(2), node = app.gatewayEntry;
  const headers = { host: new URL(node.backendOrigin).host, ...gatewayProxyHeaders(node, gateway.origin) };
  const tcp = await raw({ hostname: '127.0.0.1', port: new URL(app.bindingOrigin).port, path: '/readyz', headers }); assert.equal(tcp.status, 403);
  const untrusted = await raw({ socketPath: app.tunnelSocket, path: '/readyz', headers: { ...headers, 'x-codex-gateway-secret': 'bad' } }); assert.equal(untrusted.status, 403);
  const wrongHost = await raw({ socketPath: app.tunnelSocket, path: '/readyz', headers: { ...headers, host: new URL(gateway.origin).host } }); assert.equal(wrongHost.status, 403);
  const absent = await raw({ socketPath: app.tunnelSocket, path: '/readyz', headers: { host: new URL(node.backendOrigin).host } }); assert.equal(absent.status, 400);
  const accepted = await raw({ socketPath: app.tunnelSocket, path: '/readyz', headers }); assert.equal(accepted.status, 200); assert.equal(JSON.parse(accepted.text).nodeId, node.id);
});

test('gateway preserves WebSocket authentication, Origin and stale-node denials without reporting a backend outage', async t => {
  const gateway = await gatewayHTTPFixture(); t.after(() => gateway.close()); const app = await gateway.add(3); await gateway.select(app.gatewayEntry.id);
  for (const [node, origin, expected] of [[app.gatewayEntry.id, gateway.origin, 401], ['f'.repeat(32), gateway.origin, 409], [app.gatewayEntry.id, 'http://untrusted.invalid', 403]]) {
    const status = await new Promise((resolve, reject) => {
      const socket = new WebSocket(gateway.origin.replace(/^http/, 'ws') + '/session/connect?node=' + node, { origin, handshakeTimeout: 5000 });
      const timer = setTimeout(() => { socket.terminate(); reject(Error('WebSocket denial timed out')); }, 6000);
      socket.on('error', () => {});
      socket.once('open', () => { clearTimeout(timer); socket.terminate(); reject(Error('Unauthenticated upgrade accepted')); });
      socket.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode); });
    });
    assert.equal(status, expected);
  }
  assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
});
