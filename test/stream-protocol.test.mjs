import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
const id = 'c'.repeat(32);
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('stream protocol timeout'); }
function path(app, suffix = '', target) {
  const query = new URLSearchParams({ viewer: app.viewer, streamId: id, mode: target ? 'terminal' : 'desktop', ...(target || {}) });
  return app.config.origin.replace('http:', 'ws:') + '/session/connect?' + query + suffix;
}
async function connected(app, auth = true, target) {
  const ws = new WebSocket(path(app, '', target), { origin: app.config.origin, headers: { cookie: app.cookie } }), records = [];
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
test('authenticated terminal creation uses the retained stream, validates fixed parameters and switches to the created identity', async t => {
  const app = await fixture({ seamless: true, maxTerminals: 2 }); t.after(() => app.close()); await app.login(); await app.claim();
  const main = (await app.controls.listTerminals()).terminals[0], target = { terminalId: main.id, terminalToken: main.token };
  const peer = await connected(app, true, target); t.after(() => peer.ws.terminate());
  assert.equal(peer.records[0].terminalCreate, 1);
  peer.ws.send(JSON.stringify({ type: 'activate', epoch: 0, out: 0, input: 0 })); await until(() => peer.records.some(v => v.type === 'active'));
  peer.ws.send(JSON.stringify({ type: 'panel', id: 1, epoch: 1, action: 'create-terminal', body: { name: 'new shell', terminalId: 'aux1', action: 'close' } }));
  await until(() => peer.records.some(v => v.type === 'panel-result' && v.id === 1));
  assert.equal(peer.records.find(v => v.type === 'panel-result' && v.id === 1).error.status, 400); assert.equal((await app.controls.listTerminals()).terminals.length, 1);
  peer.ws.send(JSON.stringify({ type: 'panel', id: 2, epoch: 1, action: 'create-terminal', body: { name: 'new shell', terminalId: 'aux1' } }));
  await until(() => peer.records.some(v => v.type === 'panel-result' && v.id === 2));
  const result = peer.records.find(v => v.type === 'panel-result' && v.id === 2); assert.equal(result.ok, true); assert.equal(result.value.created, 'aux1');
  const created = result.value.terminals.find(v => v.id === result.value.created); assert.equal(created.name, 'new shell');
  peer.ws.send(JSON.stringify({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { terminalId: created.id, terminalToken: created.token } }));
  await until(() => peer.records.some(v => v.type === 'switched')); await until(() => app.terminalConnections === 2);
  peer.ws.send(JSON.stringify({ type: 'panel', id: 3, epoch: 2, action: 'create-terminal', body: { name: 'over capacity' } }));
  await until(() => peer.records.some(v => v.type === 'panel-result' && v.id === 3));
  assert.equal(peer.records.find(v => v.type === 'panel-result' && v.id === 3).error.outcome, 'rejected');
  assert.equal((await app.controls.listTerminals()).terminals.length, 2); assert.deepEqual(app.terminalInputs, []); assert.equal(app.managementStats.restarts, 0);
});
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
test('standby opt-in retains at most one stream per mode and takeover revokes both', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  assert.equal((await (await app.request('/api/me')).json()).modeStandby, 1);
  const terminal = (await app.controls.listTerminals()).terminals[0];
  const target = { terminalId: terminal.id, terminalToken: terminal.token };
  async function open(streamId, target) {
    const url = path(app, '&standby=1', target).replace(id, streamId);
    const ws = new WebSocket(url, { origin: app.config.origin, headers: { cookie: app.cookie } }), records = [];
    ws.on('message', bytes => records.push(JSON.parse(bytes.toString()))); ws.on('error', () => {}); t.after(() => ws.terminate());
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf })); await until(() => records.some(x => x.type === 'welcome'));
    return { ws, records };
  }
  const desktop = await open('a'.repeat(32)), oldTerminal = await open('b'.repeat(32), target);
  const replaced = once(oldTerminal.ws, 'close'), terminalPeer = await open('d'.repeat(32), target); await replaced;
  for (const peer of [desktop, terminalPeer]) {
    peer.ws.send(JSON.stringify({ type: 'activate', epoch: 0, out: 0, input: 0 }));
    await until(() => peer.records.some(x => x.type === 'active'));
    peer.ws.send(JSON.stringify({ type: 'ping', id: 2 })); await until(() => peer.records.some(x => x.type === 'pong'));
  }
  assert.equal(app.vncConnections, 1); assert.equal(app.terminalConnections, 1);
  const closed = [desktop, terminalPeer].map(peer => once(peer.ws, 'close'));
  await app.claim('e'.repeat(32)); await Promise.all(closed);
  assert.equal(app.managementStats.restarts, 0); assert.deepEqual(app.terminalInputs, []);
});
test('a normal stream releases both standby modes instead of expanding the stream bound', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const terminal = (await app.controls.listTerminals()).terminals[0];
  const target = { terminalId: terminal.id, terminalToken: terminal.token };
  const peers = [];
  for (const [streamId, value] of [['a'.repeat(32)], ['b'.repeat(32), target]]) {
    const ws = new WebSocket(path(app, '&standby=1', value).replace(id, streamId), { origin: app.config.origin, headers: { cookie: app.cookie } });
    ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open');
    const welcome = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf })); await welcome; peers.push(ws);
  }
  const closed = peers.map(ws => once(ws, 'close')), normal = await connected(app); t.after(() => normal.ws.terminate()); await Promise.all(closed);
  normal.ws.send(JSON.stringify({ type: 'ping', id: 1 })); await until(() => normal.records.some(x => x.type === 'pong'));
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

test('an authenticated relay switches exact terminal identities without reconnecting and rejects delayed old-target authentication', async t => {
  const app = await fixture({ seamless: true }); t.after(() => app.close()); await app.login(); await app.claim();
  await app.controls.manageTerminals({ action: 'create', name: 'relay target', view: 'terminal' });
  const catalog = await app.controls.listTerminals(), target = terminal => ({ terminalId: terminal.id, terminalToken: terminal.token });
  const main = target(catalog.terminals.find(item => item.id === 'main')), auxiliary = target(catalog.terminals.find(item => item.id === 'aux1'));
  const peer = await connected(app, true, main); t.after(() => peer.ws.terminate());
  assert.equal(peer.records[0].terminalSwitchRelay, 1);
  peer.ws.send(JSON.stringify({ type: 'activate', epoch: 0, out: 0, input: 0 })); await until(() => peer.records.some(value => value.type === 'chunk'));
  peer.ws.send(JSON.stringify({ type: 'switch-terminal', id: 1, epoch: 1, input: 0, target: { ...auxiliary, terminalToken: '%1:999999' } }));
  await until(() => peer.records.some(value => value.type === 'switch-result'));
  assert.equal(peer.records.find(value => value.type === 'switch-result').error.status, 409); assert.equal(app.terminalConnections, 1);
  const delayed = await connected(app, false, main); t.after(() => delayed.ws.terminate());
  peer.ws.send(JSON.stringify({ type: 'switch-terminal', id: 2, epoch: 1, input: 0, target: auxiliary }));
  await until(() => peer.records.some(value => value.type === 'switched')); await until(() => app.terminalConnections === 2);
  const switched = peer.records.find(value => value.type === 'switched'); assert.deepEqual(switched.target, auxiliary);
  await until(() => peer.records.some(value => value.type === 'chunk' && value.epoch === switched.epoch));
  const closed = once(delayed.ws, 'close'); delayed.ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf })); await closed;
  const data = Buffer.from(JSON.stringify({ type: 'control', id: 1, action: 'paste', text: '仅辅助终端', bracketed: true }) + '\n').toString('base64');
  peer.ws.send(JSON.stringify({ type: 'input', epoch: switched.epoch, id: 1, part: 0, parts: 1, data }));
  await until(() => app.terminalInputs.length === 1);
  assert.deepEqual(app.terminalInputs, [{ terminalId: 'aux1', text: '\x1b[200~仅辅助终端\x1b[201~' }]);
  assert.equal(peer.ws.readyState, WebSocket.OPEN); assert.equal(app.managementStats.restarts, 0);
  const revoked = once(peer.ws, 'close'); await app.claim('d'.repeat(32)); await revoked;
});
