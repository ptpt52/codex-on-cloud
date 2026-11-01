import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { parseScreen, viewportSize } from '../native/viewport.mjs';
import { fixture } from './fixture.mjs';

test('viewport sizing respects current virtual limits and rejects invalid dimensions or physical outputs', () => {
  const screen = parseScreen('Screen 0: minimum 1 x 1, current 1600 x 900, maximum 1600 x 1600\nscreen connected 1600x900+0+0\n');
  assert.deepEqual(screen.actual, { width: 1600, height: 900 });
  const size = viewportSize({ width: 2560, height: 1200 }, screen.maximum);
  assert.ok(size.width <= 1600 && size.height <= 1600);
  assert.ok(Math.abs(size.width / size.height - 2560 / 1200) < 0.03);
  for (const value of [{ width: 159, height: 800 }, { width: 1024, height: 8193 }, { width: '1024', height: 800 }, { width: 1024, height: 800, command: 'never' }]) assert.throws(() => viewportSize(value, screen.maximum));
  assert.throws(() => parseScreen('Screen 0: minimum 1 x 1, current 1600 x 900, maximum 1600 x 1600\nHDMI-1 connected 1600x900+0+0\n'));
});

test('live viewport API is owner/Origin/CSRF protected, bounded and does not restart or save preferences', async t => {
  const app = await fixture({ viewport: true }); t.after(() => app.close());
  const post = options => app.request('/api/desktop/viewport', { method: 'POST', body: { width: 1366, height: 700 }, ...options });
  assert.equal((await post()).status, 401); await app.login();
  assert.equal((await post()).status, 409); await app.claim();
  assert.equal((await post({ headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await post({ headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await post({ body: { width: 9999999, height: 600 } })).status, 400);
  const before = await app.controls.get();
  const response = await post(); assert.equal(response.status, 200);
  const result = await response.json(); assert.ok(result.actual.width > result.actual.height);
  const after = await app.controls.get();
  assert.equal(after.session.pid, before.session.pid); assert.deepEqual(after.saved, before.saved);
  assert.equal(app.managementStats.restarts, 0); assert.equal(app.managementStats.resumes, 0); assert.deepEqual(app.inputCalls, []);
});

test('viewport updates serialize with inputs and stale delayed bodies cannot resize after reclaim', async t => {
  let release, started;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const app = await fixture({ viewport: true, viewportHook: async () => { started(); await hold; } });
  t.after(() => app.close()); t.after(release); await app.login(); await app.claim();
  const resizing = app.request('/api/desktop/viewport', { method: 'POST', body: { width: 1366, height: 700 } });
  await entered;
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 409);
  assert.equal((await app.request('/api/desktop/viewport', { method: 'POST', body: { width: 1280, height: 720 } })).status, 409);
  release(); assert.equal((await resizing).status, 200);
  const body = JSON.stringify({ width: 1280, height: 720 }), reading = once(app.panel.server, 'request');
  let request;
  const pending = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/desktop/viewport', { method: 'POST', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.write(body.slice(0, 1));
  });
  await reading; await app.claim('22222222-2222-4222-8222-222222222222'); await app.claim();
  request.end(body.slice(1)); assert.equal(await pending, 409);
  assert.equal(app.managementStats.viewportResizes, 1); assert.deepEqual(app.inputCalls, []);
});
