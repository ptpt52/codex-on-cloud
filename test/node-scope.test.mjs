import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { cookieToken, sessionCookie } from '../panel/auth.mjs';

test('node cookies coexist on one origin and only the selected node cookie is read or cleared', () => {
  const a = { nodeId: 'a'.repeat(32), secureCookies: true, sessionMs: 10000 }, b = { ...a, nodeId: 'b'.repeat(32) };
  const header = sessionCookie('token-a', a).split(';')[0] + '; ' + sessionCookie('token-b', b).split(';')[0];
  assert.equal(cookieToken(header, a), 'token-a'); assert.equal(cookieToken(header, b), 'token-b'); assert.equal(cookieToken(header), undefined);
  assert(sessionCookie('', b, true).startsWith('coc_session_' + b.nodeId + '=;')); assert(!sessionCookie('', b, true).includes(a.nodeId));
});

test('shared node headers reject stale same-origin requests before login, reads, creation or input, preserving Host and Origin checks', async t => {
  const nodeId = 'b'.repeat(32), app = await fixture({ sharedEntry: true, nodeId, seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const original = await app.controls.listTerminals();
  for (const [path, method, body] of [['/api/me', 'GET'], ['/api/terminals', 'POST', { action: 'create', name: 'never create' }], ['/api/key', 'POST', { key: 'Enter' }]]) {
    const response = await app.request(path, { method, body, headers: { 'x-codex-node': 'a'.repeat(32) } }); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'node_changed');
  }
  assert.deepEqual(await app.controls.listTerminals(), original); assert.deepEqual(app.inputCalls, []);
  assert.equal((await app.request('/api/me', { headers: { 'x-codex-node': '' } })).status, 409);
  assert.equal((await app.request('/api/me')).status, 200);
  assert.equal((await app.request('/api/me', { headers: { origin: 'http://evil.test' } })).status, 200); // Reads still require their authenticated node; writes retain Origin checks.
  assert.equal((await app.request('/api/key', { method: 'POST', body: { key: 'Enter' }, headers: { origin: 'http://evil.test' } })).status, 403);
  const html = await (await app.request('/')).text(); assert(html.includes('name="node-id" content="' + nodeId + '"'));
  assert.equal((await (await app.request('/readyz')).json()).nodeId, nodeId);
});

test('a stale node cannot open a new WebSocket even when the browser also has the target node login', async t => {
  const nodeId = 'b'.repeat(32), app = await fixture({ mode: 'terminal', nodeId, sharedEntry: true, seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const target = (await app.controls.listTerminals()).terminals[0];
  const url = new URL('/session/connect', app.config.origin.replace('http:', 'ws:'));
  for (const [key, value] of Object.entries({ viewer: app.viewer, streamId: 'd'.repeat(32), mode: 'terminal', terminalId: target.id, terminalToken: target.token, node: 'a'.repeat(32) })) url.searchParams.set(key, value);
  const denied = await new Promise(resolve => { const ws = new WebSocket(url, { origin: app.config.origin, headers: { cookie: app.cookie } }); ws.on('error', () => {}); ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); }); });
  assert.equal(denied, 409); assert.equal(app.terminalConnections, 0);
  url.searchParams.set('node', nodeId); const ws = new WebSocket(url, { origin: app.config.origin, headers: { cookie: app.cookie } }); t.after(() => ws.terminate());
  const records = []; ws.on('message', bytes => records.push(JSON.parse(bytes))); await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf }));
  for (let n = 0; n < 100 && !records.length; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(records[0].type, 'welcome');
});
