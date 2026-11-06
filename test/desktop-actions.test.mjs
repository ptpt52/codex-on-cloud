import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createDesktopActionServer, desktopActionClient } from '../native/desktop-actions.mjs';
import { executeInput } from '../native/input.mjs';
import { serviceUnits } from '../native/service-units.mjs';

test('desktop action socket authenticates, bounds bodies and admits only one action without a queue', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-actions-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release, entered; const hold = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const calls = [], secret = 'synthetic_desktop_secret', socketPath = join(dir, 'actions.sock');
  const server = createDesktopActionServer(secret, { async perform(path, body) { calls.push({ path, body }); entered(); await hold; return { ok: true }; } });
  server.listen(socketPath); await once(server, 'listening'); t.after(async () => { release(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  function request(path, body, auth = secret) { return new Promise((resolve, fail) => { const req = http.request({ socketPath, path, method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', fail); req.end(body); }); }
  assert.equal(await request('/terminal', '{}', 'wrong'), 401);
  assert.equal(await request('/shell', '{}'), 404);
  assert.equal(await request('/terminal', '[]'), 400);
  assert.equal(await request('/clipboard', 'x'.repeat(200 * 1024 + 1)), 413);
  const client = desktopActionClient(socketPath, secret), pending = client('/clipboard', { text: 'literal $(never) 中文' }); await started;
  assert.equal(await request('/terminal', '{"id":"main"}'), 409); assert.equal(calls.length, 1);
  release(); assert.deepEqual(await pending, { ok: true });
});

test('a failed desktop clipboard acknowledgement never sends the paste key or retries elsewhere', async () => {
  const commands = [], writes = [];
  await assert.rejects(executeInput({ action: 'paste', text: 'unchanged', target: 'terminal' }, {}, async (...args) => commands.push(args), async text => { writes.push(text); throw Error('lost acknowledgement'); }));
  assert.deepEqual(writes, ['unchanged']); assert.deepEqual(commands, []);
});

test('generated services separate desktop children and bound only panel failure recovery', () => {
  const units = serviceUnits('/workspace/a b%$literal', '/usr/bin', '/usr/bin/node');
  const panel = units.get('codex-cloud-panel.service'), worker = units.get('codex-cloud-actions.service');
  assert.match(panel, /StartLimitIntervalSec=60\nStartLimitBurst=3/); assert.match(panel, /Restart=on-failure\nRestartSec=5/);
  for (const key of ['desktop', 'manager', 'actions']) assert.match(units.get(`codex-cloud-${key}.service`), /Restart=no/);
  assert.match(worker, /Requisite=codex-cloud-desktop.service/); assert.match(worker, /PartOf=codex-cloud-desktop.service/);
  assert.match(units.get('codex-cloud-manager.service'), /Wants=codex-cloud-actions.service/);
  assert.ok(!worker.includes('BindsTo=')); assert.match(worker, /KillMode=control-group/);
  assert.ok(panel.includes('a b%%$$literal/panel/main.mjs')); assert.throws(() => serviceUnits('/workspace/\ninvalid', '/usr/bin'));
});
