// Real Caddy TLS and center listeners; only the registry write wait is held.
// No actual frps process, public ACME service or production node is involved.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSelfhostCenter } from '../selfhost/center.mjs';
import { listenCenter } from '../selfhost/listeners.mjs';
import { caddyConfig } from '../selfhost/server-config.mjs';
import { ROUTE_AUTH_LIMITS } from '../selfhost/protocol.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
async function within(promise, message, milliseconds = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function verifyRouteAuthCapacity({ binary, directory, tlsDir, ca }) {
  const root = join(directory, 'route-capacity'); await mkdir(root);
  const gate = Promise.withResolvers(), admitted = Promise.withResolvers(), pingEntered = Promise.withResolvers();
  const requests = new Set(), routeSockets = new Set(); let center, child, upstream, checks = 0;
  const exchange = (transport, options, body) => new Promise((resolve, reject) => {
    const request = transport.request({ host: '127.0.0.1', agent: false, ...options }, response => {
      const parts = []; let size = 0;
      response.on('data', part => { size += part.length; if (size > 4096) response.destroy(Error('response limit')); else parts.push(part); });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() }));
    });
    requests.add(request); request.once('close', () => requests.delete(request));
    request.once('error', reject); request.setTimeout(6000, () => request.destroy(Error('isolated request deadline'))); request.end(body);
  });
  try {
    const port = await freePort(), internalPort = await freePort(), edgePort = await freePort(), origin = `https://127.0.0.1:${edgePort}`;
    center = await createSelfhostCenter({ origin, port, internalPort, dataDir: join(root, 'state'), password: 'isolated_capacity_test_password', frpToken: 'isolated_capacity_frp_test_token' });
    await listenCenter(center, { port, internalPort });
    const key = await center.registry.createKey({ name: 'Callback capacity', slug: 'capacity' });
    const joined = await center.registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
    const metas = { slug: key.slug, credential: joined.credential, nodeId: 'a'.repeat(32), mode: 'terminal' }, runId = 'capacity-run';
    assert.equal(await center.registry.authorizeLogin({ metas, runId }), true);
    assert.equal(await center.registry.authorizeProxy({ metas, runId, name: 'node-capacity', type: 'http', customDomains: ['127.0.0.1'], locations: ['/node/capacity/'] }), true);
    const body = JSON.stringify({ content: { user: { metas, run_id: runId } } });
    const ping = () => exchange(http, { port: internalPort, path: '/internal/frp-plugin?op=Ping', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, body);
    assert.equal(JSON.parse((await ping()).body).reject, false);

    const routeAllowed = center.registry.routeAllowed.bind(center.registry), authorizePing = center.registry.authorizePing.bind(center.registry);
    center.registry.routeAllowed = (...args) => { if (++checks === ROUTE_AUTH_LIMITS.requests) admitted.resolve(); return routeAllowed(...args); };
    center.registry.authorizePing = (...args) => { pingEntered.resolve(); return authorizePing(...args); };
    center.internalServer.on('request', request => {
      if (!request.url.startsWith('/internal/route-auth') || routeSockets.has(request.socket)) return;
      routeSockets.add(request.socket); request.socket.once('close', () => routeSockets.delete(request.socket));
    });
    upstream = http.createServer((_request, response) => response.end('isolated node'));
    const upstreamPort = await listen(upstream), file = join(root, 'Caddyfile');
    await writeFile(file, caddyConfig('desk.example.test', { tlsDirectory: tlsDir, webroot: root, centerPort: port, internalPort, frpHttpPort: upstreamPort, redirectHttp: false }).replaceAll('https://desk.example.test', origin));
    child = spawn(binary, ['run', '--config', file, '--adapter', 'caddyfile'], { cwd: root, env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root }, stdio: 'ignore' });
    const get = path => exchange(https, { port: edgePort, path, ca });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await get('/healthz')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(ready, 'isolated capacity Caddy did not start');
    center.registry.queue = gate.promise;
    const held = Array.from({ length: 32 }, () => get('/node/capacity/'));
    for (const request of held) void request.catch(() => {});
    await within(admitted.promise, 'route checks did not enter');
    assert.equal(routeSockets.size, ROUTE_AUTH_LIMITS.connections);
    const callback = ping(); void callback.catch(() => {});
    await within(pingEntered.promise, 'saturated public route checks blocked a legitimate frps callback');
    const excess = await within(Promise.all(Array.from({ length: 8 }, () => get('/node/capacity/'))), 'overloaded checks did not fail promptly');
    assert(excess.every(response => response.status === 503));
    // Let response_header_timeout expire while storage is still held. The
    // center must not grant another set of retained reads after those closes.
    const expired = await within(Promise.all(held), 'Caddy did not bound authorization response headers');
    assert(expired.some(response => [502, 504].includes(response.status)), JSON.stringify(expired.map(response => response.status)));
    assert(expired.every(response => [502, 503, 504].includes(response.status)));
    assert.equal((await get('/node/capacity/')).status, 503);
    assert.equal(checks, ROUTE_AUTH_LIMITS.requests);
    gate.resolve();
    const heartbeat = await within(callback, 'admitted callback did not recover after storage resumed');
    assert.equal(heartbeat.status, 200); assert.equal(JSON.parse(heartbeat.body).reject, false);
    assert.equal((await get('/node/capacity/')).status, 200);
    console.log('✓ actual Caddy bounds route-auth sockets, rejects overload, expires stalled headers and preserves authenticated frps callback capacity');
  } finally {
    gate.resolve(); for (const request of requests) request.destroy();
    if (child?.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await within(stopped, 'capacity Caddy did not stop'); }
    await center?.close();
    if (upstream) await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
}
