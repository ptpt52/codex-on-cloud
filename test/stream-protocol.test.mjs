import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
const id = 'c'.repeat(32);
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('stream protocol timeout'); }
function path(app, suffix = '') { return app.config.origin.replace('http:', 'ws:') + `/session/connect?viewer=${app.viewer}&streamId=${id}&mode=desktop${suffix}`; }
async function connected(app, auth = true) {
  const ws = new WebSocket(path(app), { origin: app.config.origin, headers: { cookie: app.cookie } }), records = [];
  ws.on('message', bytes => records.push(JSON.parse(bytes.toString()))); ws.on('error', () => {});
  await once(ws, 'open'); if (auth) { ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf })); await until(() => records.some(x => x.type === 'welcome')); }
  return { ws, records };
}
async function denied(url, options) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, options); ws.on('error', () => {});
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
  });
}
test('stream paths enforce authentication, Origin, viewer ownership and CSRF before starting an upstream', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close());
  assert.equal(await denied(path(app), { origin: app.config.origin }), 401);
  await app.login(); await app.claim();
  assert.equal((await app.request('/desktop/stream-client.js', { headers: { cookie: '' } })).status, 401);
  assert.equal(await denied(path(app), { origin: 'https://attacker.example', headers: { cookie: app.cookie } }), 403);
  assert.equal(await denied(path(app).replace(app.viewer, 'f'.repeat(32)), { origin: app.config.origin, headers: { cookie: app.cookie } }), 409);
  let peer = await connected(app, false), closed = once(peer.ws, 'close'); peer.ws.send('null'); await closed;
  assert.equal((await app.request('/api/me')).status, 200);
  peer = await connected(app, false); closed = once(peer.ws, 'close'); peer.ws.send(JSON.stringify({ type: 'auth', csrf: 'wrong' })); await closed;
  assert.equal(app.vncConnections, 0); assert.equal(app.terminalConnections, 0);
});
test('a waiting relay uses no upstream; pending authentication is bounded and cannot replace the authenticated path', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const first = await connected(app), pending = await connected(app, false); t.after(() => first.ws.terminate()); t.after(() => pending.ws.terminate());
  assert.equal(await denied(path(app), { origin: app.config.origin, headers: { cookie: app.cookie } }), 429);
  first.ws.send(JSON.stringify({ type: 'ping', id: 1 })); await until(() => first.records.some(x => x.type === 'pong'));
  assert.equal(app.vncConnections, 0); assert.equal(app.terminalConnections, 0);
});
test('a lost relay resumes one upstream, only output is replayed, and takeover revokes both the lease and paths', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  let peer = await connected(app); peer.ws.send(JSON.stringify({ type: 'activate', epoch: 0, out: 0, input: 0 })); await until(() => peer.records.some(x => x.type === 'active'));
  peer.ws.send(JSON.stringify({ type: 'input', epoch: 1, id: 1, part: 0, parts: 1, data: Buffer.from('literal data').toString('base64') }));
  await until(() => peer.records.some(x => x.type === 'chunk')); peer.ws.terminate(); await once(peer.ws, 'close');
  peer = await connected(app); peer.ws.send(JSON.stringify({ type: 'activate', epoch: 1, out: 0, input: 1 })); await until(() => peer.records.some(x => x.type === 'chunk'));
  assert.equal(Buffer.from(peer.records.find(x => x.type === 'chunk').data, 'base64').toString(), 'literal data');
  assert.equal(app.vncConnections, 1); assert.equal(app.received.filter(x => x.method === 'VNC').length, 1);
  const closed = once(peer.ws, 'close'); await app.claim('d'.repeat(32)); await closed;
  assert.equal(await denied(path(app), { origin: app.config.origin, headers: { cookie: app.cookie } }), 409);
  assert.equal(app.managementStats.restarts, 0);
});
