import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { createSelfhostCenter } from '../selfhost/center.mjs';
import { listenCenter } from '../selfhost/listeners.mjs';

// Real timers and real TCP/Unix sockets: changing headersTimeout alone passes
// property assertions but leaves the default 30-second native sweep in place.
test('idle and trickled headers expire at the default deadlines on every HTTP ingress', { timeout: 25000 }, async t => {
  const app = await fixture({ mode: 'terminal' }); t.after(() => app.close());
  const directory = await mkdtemp(join(tmpdir(), 'codex-header-deadlines-'));
  const center = await createSelfhostCenter({ origin: 'http://127.0.0.1', port: 0, internalPort: 0, dataDir: directory, password: 'isolated_header_test_password', frpToken: 'isolated_header_frp_test_token' });
  t.after(async () => { await center.close(); await rm(directory, { recursive: true, force: true }); });
  await listenCenter(center, { port: 0, internalPort: 0 });
  const socketPath = join(app.directory, 'header-deadline.sock'); await app.panel.startTunnel(socketPath);
  const panelURL = new URL(app.bindingOrigin), host = new URL(app.config.origin).host;
  const entries = [
    { label: 'panel TCP', address: { host: '127.0.0.1', port: Number(panelURL.port) }, host, path: '/healthz', deadline: 15000 },
    { label: 'panel private Tunnel', address: { path: socketPath }, host, path: '/healthz', deadline: 15000 },
    { label: 'center public', address: { host: '127.0.0.1', port: center.server.address().port }, host: '127.0.0.1', path: '/healthz', deadline: 10000 },
    { label: 'center internal', address: { host: '127.0.0.1', port: center.internalServer.address().port }, host: '127.0.0.1', path: '/internal/healthz', deadline: 10000 },
  ];
  const pending = entries.flatMap(entry => [false, true].map(async trickle => {
    const socket = net.createConnection(entry.address); socket.on('error', () => {}); socket.resume();
    t.after(() => socket.destroy()); await once(socket, 'connect');
    const started = performance.now(); socket.write(`GET ${entry.path} HTTP/1.1\r\nHost: ${entry.host}\r\nX-Slow: `);
    let interval, timer;
    if (trickle) interval = setInterval(() => { if (!socket.destroyed) socket.write(' '); }, 200);
    try {
      await Promise.race([new Promise(resolve => socket.once('close', resolve)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(entry.label + ' retained incomplete headers past its deadline')), entry.deadline + 5000); })]);
      const elapsed = performance.now() - started;
      assert(elapsed >= entry.deadline - 100, entry.label + ' closed before its configured header deadline');
      assert(elapsed < entry.deadline + 5000, entry.label + ' used a late native sweep');
    } finally { clearTimeout(timer); clearInterval(interval); socket.destroy(); }
  }));
  await Promise.all(pending);
  for (const entry of entries) {
    const address = entry.address.path ? { socketPath: entry.address.path } : entry.address;
    const status = await new Promise((resolve, reject) => {
      const request = http.get({ ...address, path: entry.path, headers: { host: entry.host }, agent: false }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject);
    });
    assert.equal(status, 200, entry.label + ' did not recover after header expiration');
  }
  assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
});
