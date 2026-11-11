import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { fixture } from './support/forward-transport.mjs';

const capability = { 'x-codex-forward-resume': '1', 'x-codex-forward-reverse': '1' };
async function until(probe) { for (let n = 0; n < 250; n++) { if (await probe()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('reverse test deadline'); }
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const status = async app => (await (await app.request('mapping')).json());
async function create(app, extra = {}) {
  const body = { direction: 'reverse', deviceName: '本地路由器', protocol: 'ssh', localPort: await freePort(), targetHost: '127.0.0.2', targetPort: 22, ...extra };
  const response = await app.request('mapping', { method: 'POST', body }); assert.equal(response.status, 200); return response.json();
}
async function open(app, path, token, headers = {}) {
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
  const records = []; ws.on('error', () => {}); ws.on('message', (bytes, binary) => { records.push(binary ? Buffer.from(bytes) : JSON.parse(bytes)); assert.ok(records.length <= 512); }); await once(ws, 'open'); return { ws, records };
}
async function rejected(app, path, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...capability, ...headers } });
    ws.on('error', () => {}); ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode, code: res.headers['x-codex-forward-error'] }); }); ws.on('open', () => { ws.terminate(); reject(Error('unexpected reverse authorization')); });
  });
}
async function helper(app, code, path = '/forward/helper') { const result = await open(app, path, code); await until(() => result.records.length === 1); result.ready = result.records[0]; result.ws.send('{"type":"listening"}'); await until(() => result.records.some(x => x.type === 'listening')); return result; }
async function refused(port) { const tcp = net.createConnection({ host: '127.0.0.1', port }); tcp.on('error', () => {}); try { await once(tcp, 'connect'); tcp.destroy(); return false; } catch { return true; } }

test('reverse pairing requires an upgraded locally consenting helper and binds no port before consent', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());

  const mapping = await create(app); assert.equal(await refused(mapping.localPort), true);
  assert.deepEqual(await rejected(app, '/forward/helper', mapping.code, { 'x-codex-forward-reverse': '' }), { status: 426, code: 'reverse_upgrade_required' });
  const control = await open(app, '/forward/helper', mapping.code); t.after(() => control.ws.terminate()); await until(() => control.records.length === 1);
  assert.equal(control.records[0].direction, 'reverse'); assert.equal(control.records[0].reverseProtocol, 1); assert.equal(await refused(mapping.localPort), true);
  control.ws.send('{"type":"error","code":"reverse_denied"}'); await until(async () => (await status(app)).recent[0]?.code === 'reverse_denied');
  assert.equal(await refused(mapping.localPort), true); assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []);
  const unconfirmed = await create(app), abandoned = await open(app, '/forward/helper', unconfirmed.code);
  await until(() => abandoned.records.length === 1); abandoned.ws.terminate();
  await until(async () => (await status(app)).mappings.length === 0); assert.equal(await refused(unconfirmed.localPort), true);
});

test('reverse listener remains loopback-only, preserves bytes and half-close, and consumes each accepted stream once', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());
  const mapping = await create(app), control = await helper(app, mapping.code); t.after(() => control.ws.terminate());
  assert.equal((await status(app)).mappings[0].targetStatus.state, 'unverified');
  const tcp = net.createConnection({ host: '127.0.0.1', port: mapping.localPort, allowHalfOpen: true }); t.after(() => tcp.destroy()); tcp.on('error', () => {}); await once(tcp, 'connect');
  const received = []; tcp.on('data', bytes => received.push(bytes));
  const input = Buffer.concat([Buffer.from('中文\0\r\n'), randomBytes(65536)]); tcp.end(input);
  await until(() => control.records.some(x => x.type === 'reverse_open')); const id = control.records.find(x => x.type === 'reverse_open').id;
  assert.equal((await rejected(app, '/forward/data', control.ready.streamToken)).status, 401);
  assert.equal((await rejected(app, '/forward/data', mapping.code, { 'x-codex-reverse-stream': id })).status, 401);
  const data = await open(app, '/forward/data', control.ready.streamToken, { 'x-codex-reverse-stream': id }); t.after(() => data.ws.terminate());
  await until(() => data.records.length === 1); assert.equal(data.records[0].type, 'ready');
  assert.equal((await rejected(app, '/forward/data', control.ready.streamToken, { 'x-codex-reverse-stream': id })).status, 401);
  assert.equal(data.records.filter(Buffer.isBuffer).length, 0);
  data.ws.send('{"type":"target_ready"}'); await until(() => data.records.some(x => x.type === 'fin'));
  assert.deepEqual(Buffer.concat(data.records.filter(Buffer.isBuffer)), input);
  const reply = Buffer.from('device reply after client FIN'); const ended = once(tcp, 'end'); data.ws.send(reply); data.ws.send('{"type":"fin"}'); await ended;
  assert.deepEqual(Buffer.concat(received), reply); assert.equal((await status(app)).mappings[0].targetStatus.state, 'reachable');
  await app.request('stop', { method: 'POST', body: { id: mapping.id } }); assert.equal(await refused(mapping.localPort), true);
});

test('reverse mapping bounds pending sockets, invalidates old streams on recovery, and never replays bytes', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());  const mapping = await create(app), first = await helper(app, mapping.code);
  const clients = []; t.after(() => clients.forEach(tcp => tcp.destroy())); t.after(() => first.ws.terminate());
  for (let n = 0; n < 9; n++) { const tcp = net.createConnection({ host: '127.0.0.1', port: mapping.localPort }); tcp.on('error', () => {}); clients.push(tcp); await once(tcp, 'connect'); }
  await until(() => controlOpens(first).length === 8); await until(() => clients[8].destroyed); assert.equal((await status(app)).mappings[0].connections, 8);
  const stale = controlOpens(first)[0].id; first.ws.terminate(); await until(async () => (await status(app)).mappings[0]?.state === 'recovering');
  await until(() => clients.every(tcp => tcp.destroyed)); assert.equal(await refused(mapping.localPort), true);
  const next = await helper(app, first.ready.resumeToken, '/forward/resume'); t.after(() => next.ws.terminate());
  assert.equal(next.ready.id, mapping.id); assert.equal(next.ready.direction, 'reverse'); assert.equal(next.ready.targetHost, mapping.targetHost); assert.notEqual(next.ready.streamToken, first.ready.streamToken);
  assert.equal((await rejected(app, '/forward/data', first.ready.streamToken, { 'x-codex-reverse-stream': stale })).status, 401);
  assert.equal((await rejected(app, '/forward/data', next.ready.streamToken, { 'x-codex-reverse-stream': stale })).status, 401); assert.equal(controlOpens(next).length, 0);
  await app.request('revoke', { method: 'POST', body: {} }); await until(() => next.ws.readyState === 3); assert.equal(await refused(mapping.localPort), true);
});
function controlOpens(control) { return control.records.filter(x => x.type === 'reverse_open'); }


test('reverse validates identity and port scope, and reports listen collisions without reaching a device', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());
  const base = { direction: 'reverse', localPort: await freePort(), targetHost: '192.168.1.1', targetPort: 22, deviceName: '路由器' };
  for (const invalid of [{ ...base, localPort: app.config.port }, { ...base, targetHost: 'device.local' }, { ...base, deviceName: '\u001b[2J' }, { ...base, protocol: 'ssh;command' }, { ...base, deviceId: '../' }]) assert.equal((await app.request('mapping', { method: 'POST', body: invalid })).status, 400);
  const occupied = net.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening'); t.after(() => new Promise(r => occupied.close(r)));
  const mapping = await create(app, { localPort: occupied.address().port }), control = await open(app, '/forward/helper', mapping.code); t.after(() => control.ws.terminate()); await until(() => control.records.length === 1); control.ws.send('{"type":"listening"}');
  await until(async () => (await status(app)).recent[0]?.code === 'reverse_port_in_use'); assert.equal((await status(app)).mappings.length, 0); assert.deepEqual(app.inputCalls, []);
});
