import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';

async function ingress(t, kind, options = {}) {
  const app = await fixture({ mode: 'terminal', ...options }); t.after(() => app.close());
  const url = new URL(app.bindingOrigin), path = join(app.directory, 'http-bounds.sock');
  if (kind === 'tunnel') await app.panel.startTunnel(path);
  const address = kind === 'tunnel' ? { path } : { host: url.hostname, port: Number(url.port) };
  const target = kind === 'tunnel' ? { socketPath: path } : { host: url.hostname, port: Number(url.port) };
  const requests = new Set(); t.after(() => { for (const req of requests) req.destroy(); });
  function request(path, { method = 'GET', headers = {}, agent = false, partial = false } = {}) {
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request({ ...target, path, method, agent, headers: { host: new URL(app.config.origin).host, ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), reused: req.reusedSocket }));
      });
      requests.add(req); req.once('error', reject);
    });
    const closed = new Promise(resolve => req.once('close', () => { requests.delete(req); resolve(); }));
    if (partial) req.write('a'); else req.end();
    return { response, closed };
  }
  return { app, address, request };
}

for (const kind of ['tcp', 'tunnel']) {
  test(`${kind} rejects declared GET/HEAD bodies before routing and closes their incomplete connections`, { timeout: 10000 }, async t => {
    const { app, request } = await ingress(t, kind);
    for (const method of ['GET', 'HEAD']) for (const framing of [{ 'content-length': 1024 * 1024 }, { 'transfer-encoding': 'chunked' }]) {
      for (const path of ['/healthz', '/ui-version', '/', '/readyz']) {
        const pending = request(path, { method, headers: { ...framing, connection: 'keep-alive' }, partial: true });
        const result = await pending.response;
        assert.equal(result.status, 400); assert.equal(result.headers.connection, 'close');
        if (method === 'GET') assert.equal(JSON.parse(result.text).outcome, 'rejected');
        await pending.closed;
      }
    }
    const upgrade = request('/session/connect', { partial: true, headers: {
      origin: app.config.origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16).toString('base64'), 'content-length': 1024 * 1024,
    } });
    assert.equal((await upgrade.response).status, 400); await upgrade.closed;
    assert.equal(app.received.length, 0, 'unexpected bodies must not reach any helper');
  });

  test(`${kind} closes unread bodies after a successful bodyless action and a prefix redirect`, { timeout: 10000 }, async t => {
    const { app, request } = await ingress(t, kind, { entryBasePath: '/node/body-check/' });
    await app.login();
    const logout = request('/node/body-check/api/logout', { method: 'POST', partial: true, headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'content-length': 1024 * 1024, connection: 'keep-alive',
    } });
    const result = await logout.response;
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).ok, true); assert.equal(result.headers.connection, 'close');
    await logout.closed;
    assert.equal((await app.request('/api/me')).status, 401);
    const redirect = request('/node/body-check', { method: 'POST', partial: true, headers: { 'content-length': 1024 * 1024, connection: 'keep-alive' } });
    const moved = await redirect.response;
    assert.equal(moved.status, 308); assert.equal(moved.headers.location, '/node/body-check/'); assert.equal(moved.headers.connection, 'close');
    await redirect.closed;
    if (kind === 'tunnel') {
      app.config.secureCookies = true;
      const secure = request('/node/body-check/healthz', { method: 'POST', partial: true, headers: {
        'content-length': 1024 * 1024, connection: 'keep-alive', 'cf-visitor': '{"scheme":"http"}',
      } });
      const upgraded = await secure.response;
      assert.equal(upgraded.status, 308); assert.ok(upgraded.headers.location.startsWith('https://')); assert.equal(upgraded.headers.connection, 'close');
      await secure.closed;
    }
  });

  test(`${kind} preserves keep-alive for ordinary bodyless GET/HEAD requests`, async t => {
    const { request } = await ingress(t, kind), agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
    for (const [index, method] of ['GET', 'HEAD', 'GET', 'HEAD'].entries()) {
      const { response } = request(method === 'HEAD' ? '/' : '/healthz', { method, agent, headers: index > 1 ? { 'content-length': 0 } : {} });
      const result = await response;
      assert.equal(result.status, 200); assert.equal(result.headers.connection, 'keep-alive'); assert.equal(result.reused, index > 0);
      if (method === 'HEAD') assert.equal(result.text, ''); else assert.equal(JSON.parse(result.text).ok, true);
    }
  });

  test(`${kind} bounds total HTTP connections and admits requests after capacity is released`, { timeout: 10000 }, async t => {
    const { app, address, request } = await ingress(t, kind), sockets = new Set();
    t.after(() => { for (const socket of sockets) socket.destroy(); });
    const connect = () => {
      const socket = net.createConnection(address); sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket)); return socket;
    };
    // Prove all 256 connections have been admitted and can exchange HTTP,
    // rather than merely counting successful client-side TCP connects.
    const held = await Promise.all(Array.from({ length: 256 }, async () => {
      const socket = connect(); await once(socket, 'connect');
      let response = '';
      const accepted = new Promise((resolve, reject) => {
        socket.on('data', bytes => { response += bytes; if (response.includes('\r\n\r\n')) resolve(); });
        socket.once('error', reject); socket.once('end', () => reject(Error('connection refused below capacity')));
      });
      socket.write(`GET /healthz HTTP/1.1\r\nHost: ${new URL(app.config.origin).host}\r\nConnection: keep-alive\r\n\r\n`);
      await accepted; assert.match(response, /^HTTP\/1\.1 200 /); return socket;
    }));
    const excess = connect(); let bytes = 0; excess.on('data', data => { bytes += data.length; });
    await once(excess, 'close', { signal: AbortSignal.timeout(3000) });
    assert.equal(bytes, 0, 'overflow must close without entering the HTTP handler');
    await Promise.all(held.map(socket => { const closed = once(socket, 'close'); socket.destroy(); return closed; }));
    await new Promise(setImmediate);
    assert.equal((await request('/healthz').response).status, 200);
  });
}
