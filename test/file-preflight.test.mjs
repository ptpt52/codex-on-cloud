import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';

test('cancelled HTTP upload preflights close their local queries and allow a fresh explicit upload', { timeout: 10000 }, async () => {
  const app = await fixture(), pending = new Set(), uploads = [], requests = [];
  let hold = true, queries = 0, maximum = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/files') {
      queries++; pending.add(res); maximum = Math.max(maximum, pending.size);
      res.once('close', () => pending.delete(res));
      if (!hold) res.end(JSON.stringify({ uploadProtocol: 1, quotaProtocol: 1, truncated: false, files: [] }));
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    uploads.push({ path: req.url, bytes: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify({ ok: true, name: 'manual.bin' }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!await predicate()) { assert(Date.now() < deadline, 'cancelled preflight retained its local HTTP query'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  try {
    await app.login(); app.config.fileAgentUrl = 'http://127.0.0.1:' + upstream.address().port;
    for (let n = 1; n <= 6; n++) {
      const id = n.toString(16).padStart(32, '0');
      const request = http.request(app.config.origin + '/api/files/cancelled-' + n + '.bin', { method: 'PUT', headers: {
        origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf,
        'content-type': 'application/octet-stream', 'content-length': 4, 'x-codex-transfer-id': id,
      } });
      requests.push(request); request.on('error', () => {}); request.flushHeaders();
      await until(() => queries === n); request.destroy();
      await until(() => pending.size === 0);
      await until(async () => (await app.request('/api/file-progress/' + id)).status === 404);
    }
    assert.equal(maximum, 1); assert.deepEqual(uploads, []);
    hold = false;
    const response = await app.request('/api/files/manual.bin', { method: 'PUT', raw: 'safe' });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.deepEqual(uploads, [{ path: '/files/manual.bin', bytes: 'safe' }]);
    assert.deepEqual(app.inputCalls, []); assert.equal(app.vncConnections, 0);
  } finally {
    for (const request of requests) request.destroy();
    for (const response of pending) response.destroy();
    await app.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
