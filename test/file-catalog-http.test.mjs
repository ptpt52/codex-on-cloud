import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';

async function upstream(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('cancelling paged HTTP reads closes the helper before headers and releases both admission slots', async t => {
  const app = await fixture(); t.after(() => app.close()); const credentials = await app.login();
  let entered, closed, calls = 0;
  app.config.fileAgentUrl = await upstream(t, (req, res) => { calls++; entered(); res.once('close', closed); });
  for (let n = 0; n < 3; n++) {
    const arrived = new Promise(resolve => { entered = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
    const controller = new AbortController(), response = fetch(app.config.origin + '/api/files?page=1', { headers: { cookie: credentials.cookie }, signal: controller.signal });
    const rejected = assert.rejects(response, { name: 'AbortError' });
    await arrived; controller.abort(); await rejected;
    await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('helper did not close before headers')), 1000); timer.unref(); })]);
  }
  assert.equal(calls, 3); app.config.fileAgentUrl = app.config.agentUrl;
  assert.equal((await app.request('/api/files?page=1')).status, 200);
});

test('paged HTTP rechecks login after a delayed census and never returns revoked metadata', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); let entered, finish;
  const arrived = new Promise(resolve => { entered = resolve; });
  app.config.fileAgentUrl = await upstream(t, (_req, res) => { finish = () => res.end(JSON.stringify({ files: [{ name: 'private.txt', size: 1 }] })); entered(); });
  const response = app.request('/api/files?page=1'); await arrived;
  await app.request('/api/logout', { method: 'POST' }); finish();
  const denied = await response; assert.equal(denied.status, 401); assert.equal((await denied.text()).includes('private.txt'), false);
});

test('oversized helper metadata is bounded before it can fill a directory snapshot', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  app.config.fileAgentUrl = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 3 * 1024 * 1024 });
    res.write('{"files":[');
  });
  const response = await app.request('/api/files?page=1'); assert.equal(response.status, 502);
  app.config.fileAgentUrl = app.config.agentUrl;
  assert.equal((await app.request('/api/files?page=1')).status, 200);
});
