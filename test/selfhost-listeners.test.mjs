import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSelfhostCenter } from '../selfhost/center.mjs';
import { centerListenerConfig, listenCenter, checkCenterRollbackListeners } from '../selfhost/listeners.mjs';

test('center listener configuration retains legacy environments and rejects invalid or duplicate ports', () => {
  assert.deepEqual(centerListenerConfig({ SELFHOST_CENTER_PORT: '36180' }), { port: 36180, internalPort: undefined });
  assert.deepEqual(centerListenerConfig({ SELFHOST_CENTER_PORT: '36180', SELFHOST_INTERNAL_PORT: '36181' }), { port: 36180, internalPort: 36181 });
  for (const value of ['', '0', '65536', '36180', '1.5', ' 36181', '36181\n']) assert.throws(() => centerListenerConfig({ SELFHOST_CENTER_PORT: '36180', SELFHOST_INTERNAL_PORT: value }), /端口/);
});

async function centerFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-listeners-'));
  const center = await createSelfhostCenter({ origin: 'https://desk.example.test', port: 0, internalPort: 0,
    dataDir: directory, password: 'isolated_listener_test_password', frpToken: 'isolated_frp_test_token_long', ...options });
  t.after(async () => { await center.close(); await rm(directory, { recursive: true, force: true }); });
  return center;
}

test('center starts both listeners only on loopback and closes them together', async t => {
  const center = await centerFixture(t); await listenCenter(center, { port: 0, internalPort: 0 });
  assert.equal(center.server.address().address, '127.0.0.1'); assert.equal(center.internalServer.address().address, '127.0.0.1');
  assert.notEqual(center.server.address().port, center.internalServer.address().port);
  for (const [server, path] of [[center.server, '/healthz'], [center.internalServer, '/internal/healthz']]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { host: 'desk.example.test' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
      });
      request.once('error', reject);
    });
    assert.equal(response.status, 200); assert.equal(response.value.ok, true);
  }
  await center.close(); assert.equal(center.server.listening, false); assert.equal(center.internalServer.listening, false);
});

for (const occupied of ['public', 'internal']) test(`failed ${occupied} bind closes all center listeners before reporting startup failure`, async t => {
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  t.after(() => new Promise(resolve => reservation.close(resolve)));
  const port = occupied === 'public' ? reservation.address().port : 0, internalPort = occupied === 'internal' ? reservation.address().port : 0;
  const center = await centerFixture(t, { port, internalPort });
  await assert.rejects(listenCenter(center, { port, internalPort }), { code: 'EADDRINUSE' });
  assert.equal(center.server.listening, false); assert.equal(center.internalServer.listening, false);
});

test('application-only rollback cannot silently remove an internal listener required by current configs', async t => {
  const previous = await mkdtemp(join(tmpdir(), 'codex-listener-rollback-'));
  t.after(() => rm(previous, { recursive: true, force: true }));
  await checkCenterRollbackListeners(previous, { SELFHOST_CENTER_PORT: '36180' });
  const env = { SELFHOST_CENTER_PORT: '36180', SELFHOST_INTERNAL_PORT: '36181' };
  await assert.rejects(checkCenterRollbackListeners(previous, env), /不支持独立内部监听/);
  await mkdir(join(previous, 'selfhost'));
  await copyFile(new URL('../selfhost/listeners.mjs', import.meta.url), join(previous, 'selfhost/listeners.mjs'));
  await checkCenterRollbackListeners(previous, env);
});
