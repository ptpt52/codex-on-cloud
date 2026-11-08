import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { managerRequest } from '../panel/manager-client.mjs';

test('writes with lost, partial or invalid replies remain unknown and are not replayed', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  let accepted = 0;
  const path = join(app.directory, 'lost-manager.sock');
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    accepted++;
    if (accepted === 1) req.socket.destroy();
    else if (accepted === 2) { res.writeHead(200, { 'content-length': '100' }); res.write('{'); setImmediate(() => res.destroy()); }
    else res.end('{"ok":');
  });
  server.listen(path); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  app.config.managerSocket = path;
  for (let count = 1; count <= 3; count++) {
    const response = await app.request('/api/terminals', { method: 'POST', body: { action: 'create', view: 'terminal' } });
    assert.equal(response.status, 503); assert.equal((await response.json()).outcome, 'unknown'); assert.equal(accepted, count);
  }
});

test('unconnected writes and explicit manager rejections stay rejected', async t => {
  const app = await fixture(); t.after(() => app.close());
  await assert.rejects(managerRequest({ ...app.config, managerSocket: join(app.directory, 'missing.sock') }, '/terminals', { action: 'create' }), { status: 503, outcome: 'rejected' });
  await app.login(); await app.claim();
  const response = await app.request('/api/terminals', { method: 'POST', body: { action: 'close', terminalId: 'main', terminalToken: '%999:1234', confirm: true } });
  assert.equal(response.status, 409); assert.equal((await response.json()).outcome, 'rejected');
});
