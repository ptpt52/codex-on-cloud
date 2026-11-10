// Actual Go helper -> prefixed panel WebSocket -> TCP target. Desktop is a fixture.
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixture.mjs';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-forward-entry-'));
let child, app, target, socket;
try {
  const binary = join(directory, 'helper');
  await exec('go', ['build', '-p', '2', '-mod=readonly', '-buildvcs=false', '-o', binary, '.'], { cwd: resolve('client/forward'), env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 180000, maxBuffer: 16384 });
  target = net.createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end()); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const localPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = '/node/entry-test/';
  app = await fixture({ entryBasePath: base, nodeId: 'a'.repeat(32), forwardPorts: '*' });
  await app.login(); await app.claim();
  const response = await app.request('/api/forward', { method: 'POST', body: { localPort, targetPort: target.address().port, targetHost: '127.0.0.1' } });
  assert.equal(response.status, 200); const mapping = await response.json();
  let output = '';
  child = spawn(binary, ['--server', app.config.origin + base], { stdio: ['pipe', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-16384); });
  child.stdin.end(mapping.code + '\n');
  const end = Date.now() + 15000;
  while (!output.includes('映射已开启') && child.exitCode === null && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert(output.includes('映射已开启'), output);
  socket = net.connect(localPort, '127.0.0.1'); const chunks = [];
  socket.on('data', bytes => chunks.push(bytes)); await once(socket, 'connect');
  const ended = once(socket, 'end'); socket.end('node-prefixed-helper'); await ended;
  assert.equal(Buffer.concat(chunks).toString(), 'node-prefixed-helper');
  assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.inputCalls, []);
  console.log('✓ actual Go helper pairing and data transfer through /node/<slug>/; no desktop restart');
} finally {
  socket?.destroy();
  if (child?.exitCode === null) { const end = once(child, 'exit'); child.kill('SIGTERM'); await end; }
  await app?.close(); if (target) await new Promise(resolve => target.close(resolve)); await rm(directory, { recursive: true, force: true });
}
