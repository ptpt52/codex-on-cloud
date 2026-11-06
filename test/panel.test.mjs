import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import http from 'node:http';
import { fixture } from './fixture.mjs';

test('authentication, host/origin checks and CSRF protect both API and desktop', async t => {
  const app = await fixture(); t.after(() => app.close());
  assert.equal((await app.request('/api/state')).status, 401);
  assert.equal((await app.request('/desktop/index.html')).status, 401);
  assert.equal((await app.request('/desktop/first-frame.js')).status, 401);
  const badHost = await new Promise(resolve => http.get(app.config.origin + '/healthz', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }));
  assert.equal(badHost, 400);
  assert.equal((await app.request('/api/login', { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await app.request('/api/login', { method: 'POST', body: null })).status, 400);
  await app.login();
  assert.equal((await app.request('/api/desktop/claim', { method: 'POST', body: { viewer: app.viewer }, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 409);
  assert.equal((await app.claim()).status, 200);
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' } })).status, 200);
  assert.equal((await app.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await app.request('/api/me')).status, 401);
});

test('desktop resources require login, serve noVNC locally and reject traversal', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  const response = await app.request('/desktop/index.html', { headers: { authorization: 'Bearer attacker', 'cf-access-jwt-assertion': 'private-login-token' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.match(await response.text(), /viewer.js/);
  assert.equal((await app.request('/desktop/novnc/core/rfb.js')).status, 200);
  assert.equal((await app.request('/desktop/first-frame.js')).status, 200);
  assert.equal((await app.request('/desktop/novnc/core/%2e%2e%2f%2e%2e%2fpackage.json')).status, 404);
  assert.equal(app.received.length, 0);
});

test('WebSocket upgrade enforces origin, login and viewer; takeover closes the old connection', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const wsUrl = app.config.origin.replace('http:', 'ws:') + `/desktop/websockify?viewer=${app.viewer}`;
  const connection = new WebSocket(wsUrl, { origin: app.config.origin, headers: { cookie: app.cookie } });
  await once(connection, 'open');
  connection.send('frame');
  assert.equal((await once(connection, 'message'))[0].toString(), 'frame');
  const upstream = app.received.find(item => item.method === 'VNC');
  assert.equal(upstream.bytes.toString(), 'frame');
  const denied = async (options, status) => {
    const ws = new WebSocket(wsUrl, options);
    const code = await new Promise(resolve => {
      ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.on('error', () => {});
    });
    assert.equal(code, status);
  };
  await denied({ origin: 'https://attacker.example', headers: { cookie: app.cookie } }, 403);
  await denied({ origin: app.config.origin }, 401);
  const closed = once(connection, 'close');
  await app.claim('22222222-2222-4222-8222-222222222222');
  await closed;
  await denied({ origin: app.config.origin, headers: { cookie: app.cookie } }, 409);
  assert.equal((await app.request('/api/paste', { method: 'POST', body: { text: 'do not send', target: 'terminal' } })).status, 409);
});

test('Chinese input crosses the authenticated helper without shell interpretation or automatic Enter', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const text = '请检查项目\n`touch /tmp/never` $(echo 原样文字)';
  const response = await app.request('/api/paste', { method: 'POST', body: { text, target: 'terminal' } });
  assert.equal(response.status, 200);
  assert.deepEqual(app.inputCalls, [{ action: 'paste', text, target: 'terminal' }]);
  assert.equal(app.received.some(item => ['/paste', '/key', '/terminal'].includes(item.url)), false);
});

test('streamed uploads and downloads preserve bytes and reject traversal/oversized requests', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login();
  const bytes = Buffer.from('中文文件\0\xff');
  const name = encodeURIComponent('项目资料.txt');
  assert.equal((await app.request(`/api/files/${name}`, { method: 'PUT', raw: bytes })).status, 200);
  const response = await app.request(`/api/files/${name}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal((await app.request('/api/files/a%2Fb', { method: 'PUT', raw: bytes })).status, 400);
  assert.equal((await app.request(`/api/files/${name}`, { method: 'PUT', raw: bytes, headers: { 'x-csrf-token': '' } })).status, 403);
  const oversized = await new Promise(resolve => {
    const request = http.request(app.config.origin + '/api/files/large', { method: 'PUT', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf,
      'content-length': String(50 * 1024 * 1024 + 1), connection: 'close',
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.end();
  });
  assert.equal(oversized, 413);
});

test('login survives a gateway restart; raw session tokens are not stored and password rotation revokes them', async () => {
  const first = await fixture(); const { cookie } = await first.login();
  const directory = first.directory;
  const stored = await readFile(join(directory, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(cookie.split('=')[1]));
  await first.close({ preserve: true });
  const second = await fixture({ dataDir: directory });
  assert.equal((await second.request('/api/me', { headers: { cookie } })).status, 200);
  await second.close({ preserve: true });
  const third = await fixture({ dataDir: directory, password: 'a_new_password_for_rotation_123' });
  try { assert.equal((await third.request('/api/me', { headers: { cookie } })).status, 401); }
  finally { await third.close(); await rm(directory, { recursive: true, force: true }); }
});

test('expired sessions and repeated failed logins are rejected', async t => {
  const app = await fixture({ sessionMs: 20 }); t.after(() => app.close());
  await app.login(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await app.request('/api/me')).status, 401);
  for (let index = 0; index < 10; index++) assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 429);
});

test('delayed login bodies share the verification limit and concurrent failures are counted', { timeout: 5000 }, async t => {
  const app = await fixture(); t.after(() => app.close());
  const body = JSON.stringify({ username: 'admin', password: 'wrong' });
  const requests = [];
  t.after(() => requests.forEach(request => request.destroy()));
  const reading = new Promise(resolve => {
    let count = 0;
    app.panel.server.on('request', () => { if (++count === 6) resolve(); });
  });
  const responses = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const request = http.request(app.config.origin + '/api/login', { method: 'POST', headers: {
      origin: app.config.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    requests.push(request);
    request.write(body.slice(0, 1));
  }));
  // Every handler is waiting for its body before any password verification starts.
  await reading;
  for (const request of requests) request.end(body.slice(1));
  assert.deepEqual((await Promise.all(responses)).sort(), [401, 401, 429, 429, 429, 429]);
  for (let index = 0; index < 8; index++) assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  const limited = await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /登录尝试过多/);
});

test('a delayed login body cannot bypass a newer failed-attempt limit', { timeout: 5000 }, async t => {
  const app = await fixture(); t.after(() => app.close());
  const body = JSON.stringify({ username: 'admin', password: 'wrong' });
  const reading = once(app.panel.server, 'request');
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/login', { method: 'POST', headers: {
      origin: app.config.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, result => { result.resume(); result.once('end', () => resolve(result.statusCode)); });
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  t.after(() => request.destroy());
  await reading;
  for (let index = 0; index < 10; index++) assert.equal((await app.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  request.end(body.slice(1));
  assert.equal(await response, 429);
});
