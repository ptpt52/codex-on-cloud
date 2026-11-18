import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createJSONBodies, JSON_BODY_LIMITS } from '../panel/json-body.mjs';
import { fixture } from './fixture.mjs';

function bodyStream() {
  const req = new PassThrough(); req.headers = { 'content-type': 'application/json' }; return req;
}

test('JSON body slots release on every termination and trickled data does not extend the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = createJSONBodies({ pending: 1, timeoutMs: 100 }), separate = createJSONBodies({ pending: 1 });
  const slow = bodyStream(), timed = assert.rejects(bodies.read(slow), { status: 408 });
  slow.write('{'); t.mock.timers.tick(90); slow.write(' ');
  const excess = bodyStream(); await assert.rejects(bodies.read(excess), { status: 429 }); excess.destroy();
  // A second panel's admission is independent.
  const other = bodyStream(), completed = separate.read(other); other.end('{}'); assert.deepEqual(await completed, {});
  t.mock.timers.tick(10); await timed; slow.destroy();
  for (const raw of ['{', '[]', 'null']) {
    const req = bodyStream(), result = assert.rejects(bodies.read(req), { status: 400 }); req.end(raw); await result;
  }
  const oversized = bodyStream(), large = assert.rejects(bodies.read(oversized, 4), { status: 413 }); oversized.write('12345'); await large; oversized.destroy();
  const disconnected = bodyStream(), aborted = assert.rejects(bodies.read(disconnected), { status: 400 }); disconnected.destroy(); await aborted;
  const good = bodyStream(), parsed = bodies.read(good); good.end('{"text":"中文"}'); assert.deepEqual(await parsed, { text: '中文' });
  const pending = bodyStream(), canceled = assert.rejects(bodies.read(pending), { status: 503 }); bodies.close(); await canceled; pending.destroy();
  const stopped = bodyStream(); await assert.rejects(bodies.read(stopped), { status: 503 }); stopped.destroy(); separate.close();
});

function incomplete(app, path = '/api/login', headers = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + path, { method: 'POST', headers: {
      origin: app.config.origin, 'content-type': 'application/json', 'content-length': 100, ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
      res.once('error', reject);
    });
    request.once('error', reject); request.write('{');
  });
  // Some tests deliberately disconnect before a response exists.
  void response.catch(() => {});
  return { request, response };
}

test('panel limits incomplete JSON bodies, closes overflow sockets and admits login after disconnect', { timeout: 5000 }, async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close());
  const pending = [], received = [];
  app.panel.server.on('request', req => { if (req.url === '/api/login') received.push(req); });
  t.after(() => pending.forEach(item => item.request.destroy()));
  for (let index = 0; index < JSON_BODY_LIMITS.pending; index++) {
    const reading = once(app.panel.server, 'request'); pending.push(incomplete(app)); await reading;
  }
  const overflow = incomplete(app); pending.push(overflow);
  const closed = once(overflow.request, 'close'), result = await overflow.response;
  assert.equal(result.status, 429); assert.equal(result.body.outcome, 'rejected'); assert.equal(result.headers.connection, 'close');
  await closed;
  assert.equal((await app.request('/healthz')).status, 200);
  const aborted = new Promise(resolve => received[0].once('close', resolve)); pending[0].request.destroy(); await aborted;
  assert.ok((await app.login()).csrf);
});

test('panel enforces the default absolute JSON deadline while raw file uploads keep their longer budget', { timeout: 18000 }, async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close()); await app.login();
  const idle = incomplete(app), trickle = incomplete(app), requests = [idle.request, trickle.request];
  const timer = setInterval(() => { if (!trickle.request.destroyed) trickle.request.write(' '); }, 500);
  t.after(() => { clearInterval(timer); for (const req of requests) req.destroy(); });
  const bytes = Buffer.from('file upload survives the control request deadline');
  let upload;
  const result = new Promise((resolve, reject) => {
    upload = http.request(app.config.origin + '/api/files/slow-body.bin', { method: 'PUT', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'content-length': bytes.length,
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    upload.once('error', reject); upload.write(bytes.subarray(0, 1)); requests.push(upload);
  });
  void result.catch(() => {});
  for (const response of await Promise.all([idle.response, trickle.response])) {
    assert.equal(response.status, 408); assert.equal(response.body.outcome, 'rejected'); assert.equal(response.headers.connection, 'close');
  }
  assert.equal(app.panel.server.requestTimeout, 310000);
  upload.end(bytes.subarray(1)); assert.equal(await result, 200);
  assert.deepEqual(Buffer.from(await (await app.request('/api/files/slow-body.bin')).arrayBuffer()), bytes);
  assert.ok((await app.login()).csrf);
});
