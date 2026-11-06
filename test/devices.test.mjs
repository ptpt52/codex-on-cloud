import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceDirectory, DEVICE_FILE_LIMIT } from '../panel/devices.mjs';
import { fixture } from './fixture.mjs';
import http from 'node:http';
const body = { name: '家中路由器', targetHost: '192.168.1.1', targetPort: 22, localPort: 22001, protocol: 'ssh' };

test('device directory persists at most sixteen bounded address-only profiles atomically without following links or FIFOs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-devices-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createDeviceDirectory(directory), saved = store.save(body);
  assert.equal(createDeviceDirectory(directory).list().devices[0].id, saved.id);
  for (let n = 1; n < 16; n++) store.save({ ...body, name: '设备' + n });
  assert.throws(() => store.save(body), { status: 409 }); assert.throws(() => store.save({ ...body, password: 'do not store' }), { status: 400 });
  assert.throws(() => store.save({ ...body, name: 'bad\nname' }), { status: 400 });
  const file = join(directory, 'devices.json'); assert.ok((await readFile(file)).length <= DEVICE_FILE_LIMIT); assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const victim = join(directory, 'victim'); await writeFile(victim, 'keep'); await symlink(victim, file + '.tmp');
  assert.throws(() => store.save({ ...body, id: saved.id, name: 'changed' })); assert.equal(await readFile(victim, 'utf8'), 'keep'); assert.equal(store.find(saved.id).name, body.name);
  await rm(file + '.tmp'); await rm(file); await symlink(victim, file); assert.throws(() => createDeviceDirectory(directory), /无法读取/);
  await rm(file); await writeFile(file, 'x'.repeat(DEVICE_FILE_LIMIT + 1)); assert.throws(() => createDeviceDirectory(directory), /无法读取/);
  await rm(file); execFileSync('mkfifo', [file]); assert.throws(() => createDeviceDirectory(directory), /无法读取/);
});

test('device APIs authenticate mutations and profile changes cannot retarget or revoke an existing authorization', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());
  assert.equal((await app.request('/api/forward/devices')).status, 401); await app.login();
  for (const headers of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://evil.example' }]) assert.equal((await app.request('/api/forward/devices', { method: 'POST', body, headers })).status, 403);
  const response = await app.request('/api/forward/devices', { method: 'POST', body }); assert.equal(response.status, 200); const saved = await response.json();
  const request = { direction: 'reverse', deviceName: saved.name, deviceId: saved.id, protocol: saved.protocol, localPort: saved.localPort, targetHost: saved.targetHost, targetPort: saved.targetPort };
  const created = await app.request('/api/forward', { method: 'POST', body: request }); assert.equal(created.status, 200); const mapping = await created.json();
  await app.request('/api/forward/devices', { method: 'POST', body: { ...saved, targetHost: '192.168.1.2', name: '新的资料' } });
  let data = await (await app.request('/api/forward')).json(); assert.equal(data.mappings[0].targetHost, saved.targetHost); assert.equal(data.mappings[0].deviceName, saved.name); assert.equal(data.devices[0].targetHost, '192.168.1.2');
  assert.equal((await app.request('/api/forward', { method: 'POST', body: { ...request, localPort: 22002 } })).status, 409);
  await app.request('/api/forward/devices/remove', { method: 'POST', body: { id: saved.id } });
  data = await (await app.request('/api/forward')).json(); assert.equal(data.devices.length, 0); assert.equal(data.mappings[0].id, mapping.id); assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []);
});

for (const path of ['/api/forward/devices', '/api/forward/devices/remove']) test(`revoked login cannot complete a delayed ${path} write`, async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close()); await app.login();
  const saved = await (await app.request('/api/forward/devices', { method: 'POST', body })).json();
  const file = join(app.config.dataDir, 'devices.json'), before = await readFile(file);
  let arrived; const started = new Promise(resolve => { arrived = resolve; });
  const observed = req => { if (req.url === path && req.method === 'POST') arrived(); }; app.panel.server.on('request', observed);
  const text = JSON.stringify(path.endsWith('/remove') ? { id: saved.id } : { ...saved, name: '不应保存' });
  let request;
  const response = new Promise((resolve, reject) => { request = http.request(app.config.origin + path, { method: 'POST', headers: { origin: app.config.origin, cookie: app.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-csrf-token': app.csrf } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); request.on('error', reject); request.write(text.slice(0, 1)); });
  await started; app.panel.server.removeListener('request', observed);
  await app.request('/api/logout', { method: 'POST', body: {} }); request.end(text.slice(1));
  assert.equal(await response, 401); assert.deepEqual(await readFile(file), before);
});
