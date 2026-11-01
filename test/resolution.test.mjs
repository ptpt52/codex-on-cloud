import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { fixture } from './fixture.mjs';

async function save(app, width, height) {
  const before = await app.controls.get();
  const response = await app.request('/api/desktop/settings', { method: 'POST', body: { ...before.saved, width, height, revision: before.revision } });
  assert.equal(response.status, 200);
  return app.controls.get();
}
const apply = (app, body, headers) => app.request('/api/desktop/resolution', { method: 'POST', body, headers });

test('manual live resolution requires login, owner, Origin, CSRF and current saved revision', async t => {
  const app = await fixture({ viewport: true }); t.after(() => app.close());
  assert.equal((await apply(app, {})).status, 401); await app.login();
  assert.equal((await apply(app, {})).status, 409); await app.claim();
  const view = await save(app, 1366, 777), body = { revision: view.revision };
  assert.equal(view.canResize, true); assert.equal(view.applyRequired, true); assert.equal(view.restartRequired, false);
  assert.equal((await apply(app, body, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await apply(app, body, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await apply(app, { revision: 'stale' })).status, 409);
  assert.equal((await apply(app, { padding: 'x'.repeat(1025) })).status, 413);
  assert.equal(app.managementStats.viewportResizes, 0); assert.equal(app.managementStats.restarts, 0);
});

test('manual resolution applies exact saved pixels and fixed target on the existing stream without restarting or input', async t => {
  const app = await fixture({ viewport: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const before = await app.controls.get(), view = await save(app, 1366, 777);
  assert.deepEqual(view.actual, before.actual); assert.deepEqual(app.controls.status().viewport.fixed, before.fixed);
  const socket = new WebSocket(app.config.origin.replace('http:', 'ws:') + `/desktop/websockify?viewer=${app.viewer}`, { origin: app.config.origin, headers: { cookie: app.cookie } });
  socket.on('error', () => {}); t.after(() => socket.terminate()); await once(socket, 'open');
  const response = await apply(app, { revision: view.revision }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).actual, { width: 1366, height: 777 });
  const echoed = once(socket, 'message'); socket.send('stream retained'); assert.equal((await echoed)[0].toString(), 'stream retained');
  const after = await app.controls.get();
  assert.deepEqual(after.actual, { width: 1366, height: 777 }); assert.deepEqual(after.fixed, after.actual);
  assert.equal(after.applyRequired, false); assert.equal(after.restartRequired, false);
  assert.equal(after.session.pid, before.session.pid); assert.deepEqual(after.saved, view.saved);
  assert.equal(app.managementStats.viewportResizes, 1); assert.equal(app.managementStats.restarts, 0); assert.equal(app.managementStats.resumes, 0); assert.deepEqual(app.inputCalls, []);
  await assert.rejects(app.controls.apply({ revision: after.revision, panePid: after.session.pid, resumeId: after.session.resumeId, confirm: true }), { status: 409 });
});

test('live resolution does not need a recoverable foreground session and never falls back to restart', async t => {
  const maximum = { width: 1600, height: 3200 };
  const app = await fixture({ viewport: true, viewportMaximum: maximum, desktopHook: (command, args) => {
    if (command === 'tmux' && args.includes('list-panes')) throw new Error('unrecognized foreground');
  } });
  t.after(() => app.close()); await app.login(); await app.claim();
  const view = await save(app, 1366, 777); assert.equal(view.session, null);
  assert.equal((await apply(app, { revision: view.revision })).status, 200);
  const pending = await save(app, 1440, 900); assert.equal(pending.canResize, true);
  maximum.width = 1280;
  assert.equal((await apply(app, { revision: pending.revision })).status, 409);
  assert.equal((await app.controls.get()).restartRequired, true);
  assert.equal(app.managementStats.viewportResizes, 1); assert.equal(app.managementStats.restarts, 0);
});

test('live apply excludes other work and an unknown result is not replayed or converted to restart', async t => {
  let release, started, fail = true, calls = 0;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const app = await fixture({ viewport: true, viewportHook: async () => { calls++; started(); await hold; if (fail) throw new Error('native resize failed'); } });
  t.after(() => app.close()); t.after(release); await app.login(); await app.claim();
  const view = await save(app, 1366, 777);
  const pending = apply(app, { revision: view.revision }); await entered;
  for (const [path, body] of [['/api/key', { key: 'Enter' }], ['/api/desktop/viewport', { width: 1280, height: 720 }], ['/api/desktop/resolution', { revision: view.revision }], ['/api/desktop/settings', { ...view.saved, revision: view.revision }]]) {
    assert.equal((await app.request(path, { method: 'POST', body })).status, 409);
  }
  release(); const response = await pending; assert.equal(response.status, 503); assert.equal((await response.json()).outcome, 'unknown');
  assert.deepEqual(app.controls.status().viewport.fixed, { width: 1600, height: 3200 });
  await app.controls.get(); await app.controls.get(); assert.equal(calls, 1); assert.equal(app.managementStats.restarts, 0);
  fail = false; assert.equal((await apply(app, { revision: view.revision })).status, 200); assert.equal(calls, 2);
});

test('a delayed manual resolution body cannot apply after takeover and reclaim', async t => {
  const app = await fixture({ viewport: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const view = await save(app, 1366, 777), body = JSON.stringify({ revision: view.revision });
  const reading = once(app.panel.server, 'request'); let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/desktop/resolution', { method: 'POST', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, result => { result.resume(); result.once('end', () => resolve(result.statusCode)); });
    request.on('error', reject); request.write(body.slice(0, 1));
  });
  t.after(() => request.destroy()); await reading;
  await app.claim('22222222-2222-4222-8222-222222222222'); await app.claim();
  request.end(body.slice(1)); assert.equal(await response, 409);
  assert.equal(app.managementStats.viewportResizes, 0); assert.equal(app.managementStats.restarts, 0);
});
