import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { frpsProxyProbe } from '../selfhost/frps-admin.mjs';

test('frps proxy probe distinguishes online, offline and missing proxies with loopback Basic auth', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/api/proxy/http/missing') { res.writeHead(404); return res.end('{}'); }
    if (req.url === '/api/proxy/http/broken') { res.writeHead(500); return res.end('{}'); }
    if (req.url === '/api/proxy/http/invalid') { res.writeHead(200); return res.end('not-json'); }
    if (req.url === '/api/proxy/http/unknown') { res.writeHead(200); return res.end('{"status":"pending"}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: req.url.endsWith('/offline') ? 'offline' : 'online' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const probe = frpsProxyProbe({ endpoint: `http://127.0.0.1:${server.address().port}`, password: 'frps_password_very_long_123' });
  assert.equal(await probe('node-a'), true);
  assert.equal(await probe('offline'), false);
  assert.equal(await probe('missing'), false);
  await assert.rejects(probe('broken'), /HTTP 500/);
  await assert.rejects(probe('invalid'), /格式无效/);
  await assert.rejects(probe('unknown'), /状态未知/);
  assert.equal(seen[0].path, '/api/proxy/http/node-a');
  assert.match(seen[0].authorization, /^Basic /);
  assert.throws(() => frpsProxyProbe({ endpoint: 'http://203.0.113.5:7500', password: 'frps_password_very_long_123' }), /回环/);
});

test('frps probe cancels an oversized streaming response before reading it all', async () => {
  let pulled = 0, cancelled = false;
  const probe = frpsProxyProbe({ endpoint: 'http://127.0.0.1:17500', password: 'frps_password_very_long_123', request: async () => new Response(new ReadableStream({
    pull(controller) { if (++pulled <= 40) controller.enqueue(new Uint8Array(1024)); else controller.close(); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(probe('node-a'), /超过大小上限/);
  assert.equal(cancelled, true); assert(pulled <= 18, 'only the limit, one excess chunk and at most one prefetched chunk may be read');
});
