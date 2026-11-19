// Actual built gateway and workerd socket; registry/upstream stalls are local
// HTTP fixtures. No synthetic AbortController, CF account or production input.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition, message) {
  const deadline = performance.now() + 2000;
  while (!await condition() && performance.now() < deadline) await delay(10);
  assert(await condition(), typeof message === 'function' ? message() : message);
}

export async function verifyGatewayCancellation({ Miniflare, Log, LogLevel, convertV4MiniflareOptions, output, origin, config }) {
  assert(config.compatibility_flags.includes('enable_request_signal'));
  assert(config.compatibility_flags.includes('request_signal_passthrough'));
  const requests = new Set(); let runtime, mode, entered = 0, released = 0, nodeRequests = 0, uploadedBytes = 0;
  const node = { id: 'a'.repeat(32), secret: 'b'.repeat(64), name: 'Cancellation fixture', mode: 'terminal' };
  const upstream = http.createServer((req, res) => {
    req.on('data', bytes => { uploadedBytes += bytes.length; }); req.on('error', () => {});
    if (req.url === '/registry/route' && !mode.startsWith('route-')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(node)); return;
    }
    if (!req.url.startsWith('/registry/')) nodeRequests++;
    if (mode === 'healthy') { res.setHeader('x-codex-node-id', node.id); res.end('available'); return; }
    entered++; res.once('close', () => released++);
    if (mode.endsWith('-body')) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"pending":'); }
    if (mode === 'download-stream') { res.writeHead(200, { 'x-codex-node-id': node.id, 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(1024, 97)); }
  });
  upstream.maxConnections = 16;
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const target = 'http://127.0.0.1:' + upstream.address().port; node.backendOrigin = target;
    // The wrapper observes native events and substitutes only DO transport.
    // All deadline, body reading, routing and node fetch code is the artifact.
    const wrapper = join(output, 'cancellation-fixture.mjs');
    await writeFile(wrapper, `import gateway from './worker.mjs';
const stats = { aborted: 0, settled: 0 };
const registry = { idFromName: () => 'fixture', get: () => ({ fetch(request) {
  return fetch(${JSON.stringify(target)} + '/registry' + new URL(request.url).pathname, {
    method: request.method, headers: request.headers, body: request.body, signal: request.signal
  });
} }) };
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__cancel-stats') return Response.json(stats);
  request.signal.addEventListener('abort', () => { stats.aborted++; }, { once: true });
  const operation = gateway.fetch(request, { ...env, GATEWAY_REGISTRY: registry }).finally(() => { stats.settled++; });
  // Keep this audit invocation observable after a disconnect. Otherwise the
  // runtime may end the invocation before finally counters can be inspected.
  ctx.waitUntil(operation.then(() => {}));
  return operation;
} };
`, { mode: 0o600 });
    const start = async flags => {
      runtime = new Miniflare(convertV4MiniflareOptions({ name: 'gateway-cancellation', host: '127.0.0.1', port: 0, cf: false,
        unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: [{ type: 'ESModule', path: wrapper }, { type: 'ESModule', path: join(output, 'worker.mjs') }], modulesRoot: output,
        compatibilityDate: config.compatibility_date, compatibilityFlags: flags, log: new Log(LogLevel.ERROR) }));
      await runtime.ready; return runtime.unsafeGetDirectURL('gateway-cancellation');
    };
    const stats = async entry => (await fetch(new URL('/__cancel-stats', entry), { signal: AbortSignal.timeout(2000) })).json();
    const hold = (entry, path, streaming = false) => {
      const upload = mode.startsWith('upload-'), partial = mode === 'upload-partial';
      let request;
      const chunk = new Promise((resolve, reject) => {
        request = http.request(new URL(path, entry), { agent: false, method: upload ? 'PUT' : 'GET', headers: { host: new URL(origin).host, ...(upload ? { 'content-type': 'application/octet-stream', 'content-length': '32768' } : {}) } }, response => {
          response.on('error', () => {});
          if (streaming) response.once('data', resolve);
          else { response.resume(); response.once('end', () => reject(Error('held request completed before cancellation: ' + response.statusCode))); }
        });
        request.on('error', reject); request.setTimeout(4000, () => request.destroy(Error('isolated request deadline')));
        if (partial) request.write(Buffer.alloc(1024, 97));
        else request.end(upload ? Buffer.alloc(32768, 97) : undefined);
      });
      void chunk.catch(() => {}); requests.add(request); request.once('close', () => requests.delete(request));
      return { request, chunk };
    };
    const reset = async request => {
      const closed = new Promise(resolve => request.once('close', resolve));
      // FIN is a valid HTTP half-close and does not prove client abandonment.
      // RST bypasses Miniflare's HTTP frontend and reaches workerd directly.
      request.socket.resetAndDestroy(); await closed;
    };

    // Removing either flag must reproduce its distinct missing behavior.
    let entry, held;
    for (const omitted of ['enable_request_signal', 'request_signal_passthrough']) {
      mode = omitted === 'enable_request_signal' ? 'control-header' : 'download-header';
      entered = released = 0;
      entry = await start(config.compatibility_flags.filter(flag => flag !== omitted));
      held = hold(entry, mode === 'control-header' ? '/__nodes/api/nodes' : '/api/files/held');
      await until(() => entered === 1, omitted + ' negative control did not reach upstream');
      await reset(held.request); await delay(200);
      const observed = await stats(entry);
      assert.equal(observed.aborted, omitted === 'enable_request_signal' ? 0 : 1);
      assert.equal(observed.settled, 0); assert.equal(released, 0, omitted + ' negative control unexpectedly canceled upstream');
      await runtime.dispose(); runtime = undefined;
      await until(() => released === 1, 'negative control upstream was not cleaned up');
    }

    entry = await start(config.compatibility_flags);
    for (const scenario of ['control-header', 'control-body', 'route-header', 'route-body', 'download-header', 'download-stream', 'upload-header', 'upload-partial']) {
      mode = scenario; entered = released = nodeRequests = uploadedBytes = 0;
      const before = await stats(entry);
      held = hold(entry, scenario.startsWith('control-') ? '/__nodes/api/nodes' : '/api/files/held', scenario === 'download-stream');
      await until(() => entered === 1, scenario + ' did not reach upstream');
      if (scenario === 'download-stream') assert((await held.chunk).length > 0);
      if (scenario.startsWith('upload-')) await until(() => uploadedBytes === (scenario === 'upload-partial' ? 1024 : 32768), scenario + ' did not reach the intended upload boundary');
      await reset(held.request);
      let state;
      await until(async () => {
        state = await stats(entry);
        // After returning a streaming Response, workerd cancels its body even
        // if the JS invocation has already ended and cannot observe an event.
        const signaled = scenario === 'download-stream' || state.aborted === before.aborted + 1;
        return signaled && state.settled === before.settled + 1 && released === 1;
      }, () => scenario + ' cancellation did not settle within two seconds: ' + JSON.stringify({ before, state, entered, released }));
      assert.equal(entered, 1, 'canceled operation replayed');
      assert.equal(nodeRequests, /^(download|upload)-/.test(scenario) ? 1 : 0, 'canceled control/route dispatched to a node');
    }
    mode = 'healthy';
    const healthy = await new Promise((resolve, reject) => http.get(new URL('/api/files/available', entry), { headers: { host: new URL(origin).host } }, response => {
      let body = ''; response.on('data', bytes => body += bytes); response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject).setTimeout(2000, function () { this.destroy(Error('healthy request deadline')); }));
    assert.deepEqual(healthy, { status: 200, body: 'available' });
    console.log('✓ actual workerd: generated flags cancel control/route headers and bodies, pending/streaming downloads and complete/partial uploads without replay; both missing-flag negative controls and subsequent healthy request verified');
  } finally {
    for (const request of requests) request.destroy(); upstream.closeAllConnections(); await runtime?.dispose();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
}
