import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './forward-transport.mjs';

const [directory, phase, fault] = process.argv.slice(2), sockets = new Set(), connections = new Set();
async function until(probe) {
  for (let n = 0; n < 250; n++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('helper error cleanup deadline');
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const target = net.createServer(socket => {
  connections.add(socket); socket.on('error', () => {}); socket.once('close', () => connections.delete(socket));
  socket.on('data', bytes => socket.write(bytes));
});
let app;
try {
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  app = await fixture({ dataDir: directory, forwardPorts: '*' });
  async function open(path, token, headers = {}) {
    const ws = new WebSocket(app.config.origin.replace('http:', 'ws:') + path, 'codex-forward-v1', {
      headers: { origin: app.config.origin, authorization: 'Bearer ' + token, ...headers },
    });
    sockets.add(ws); ws.on('error', () => {});
    const records = []; ws.on('message', (data, binary) => { assert.ok(records.length < 32); records.push(binary ? Buffer.from(data) : JSON.parse(data)); });
    await once(ws, 'open'); await until(() => records.length === 1); return { ws, records, ready: records[0] };
  }
  async function create(body, headers) {
    const response = await app.request('mapping', { method: 'POST', body, headers }); assert.equal(response.status, 200); return response.json();
  }
  const healthy = await create({ localPort: await freePort(), targetPort: target.address().port });
  const control = await open('/forward/helper', healthy.code); control.ws.send('{"type":"listening"}');
  await until(() => control.records.some(value => value.type === 'listening'));
  const data = await open('/forward/data', control.ready.streamToken);
  data.ws.send('before fault', { binary: true });
  await until(() => data.records.some(value => Buffer.isBuffer(value) && value.toString() === 'before fault'));

  const headers = {};
  const localPort = await freePort(), serial = phase === 'serial-pair';
  const mapping = await create({ direction: 'reverse', deviceName: 'test device', localPort, ...(serial ? {
    protocol: 'serial', serial: { path: 'COM3', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false },
  } : { protocol: 'tcp', targetHost: '127.0.0.1', targetPort: target.address().port }) }, headers);
  const capability = { 'x-codex-forward-reverse': '1', 'x-codex-forward-resume': '1', ...(serial ? { 'x-codex-forward-serial': '1' } : {}) };
  let bad = await open('/forward/helper', mapping.code, capability);
  const resumeToken = bad.ready.resumeToken;
  const state = async () => (await (await app.request('mapping')).json());
  if (phase === 'tcp-resume') {
    bad.ws.send('{"type":"listening"}'); await until(() => bad.records.some(value => value.type === 'listening'));
    bad.ws.terminate(); await until(async () => (await state()).mappings.find(value => value.id === mapping.id)?.state === 'recovering');
    bad = await open('/forward/resume', resumeToken, capability);
  }
  assert.equal((await state()).mappings.find(value => value.id === mapping.id)?.state, 'connecting');
  const closed = new Promise(resolve => bad.ws.once('close', resolve));
  if (fault === 'unmasked') bad.ws._socket.write(Buffer.from([0x81, 0x00]));
  else bad.ws.send(Buffer.alloc(48 * 1024 + 1));
  await closed;
  await until(async () => {
    const value = (await state()).mappings.find(value => value.id === mapping.id);
    return phase === 'tcp-resume' ? value?.state === 'recovering' : !value;
  });
  if (phase === 'tcp-resume') {
    const resumed = await open('/forward/resume', resumeToken, capability);
    resumed.ws.send('{"type":"listening"}');
    await until(() => resumed.records.some(value => value.type === 'listening'));
  }
  assert.equal((await fetch(app.config.origin + '/healthz')).status, 200);
  assert.equal(control.ws.readyState, WebSocket.OPEN); assert.equal(data.ws.readyState, WebSocket.OPEN);
  data.ws.send('after fault', { binary: true });
  await until(() => data.records.some(value => Buffer.isBuffer(value) && value.toString() === 'after fault'));
  assert.equal((await state()).mappings.find(value => value.id === healthy.id)?.state, 'active');
  assert.deepEqual(app.inputCalls, []); assert.deepEqual(app.terminalInputs, []); assert.equal(app.managementStats.restarts, 0);
  console.log('isolated helper error; panel and existing TCP stream preserved');
} finally {
  for (const socket of sockets) socket.terminate();
  for (const socket of connections) socket.destroy();
  await app?.close(); await new Promise(resolve => target.close(resolve));
}
