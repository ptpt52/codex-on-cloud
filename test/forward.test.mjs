import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { createForwarding, forwardPorts } from '../panel/forward.mjs';

const token = () => randomBytes(32).toString('base64url');
async function until(probe) {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('forward test deadline');
}
async function echo(t, options = {}) {
  const connections = new Set(); let count = 0;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    count++; connections.add(socket); socket.on('error', () => {}); socket.once('close', () => connections.delete(socket));
    if (options.onSocket) return options.onSocket(socket);
    socket.on('data', bytes => socket.write(bytes)); socket.on('end', () => socket.end());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, get count() { return count; } };
}
async function created(app, targetPort = app.config.forwardPorts[0], localPort = 2222) {
  const response = await app.request('/api/forward', { method: 'POST', body: { localPort, targetPort } });
  assert.equal(response.status, 200); return response.json();
}
async function socket(app, path, credential, headers = {}) {
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + credential, ...headers } });
  ws.on('error', () => {}); const records = [];
  ws.on('message', (data, binary) => { records.push({ data: binary ? Buffer.from(data) : JSON.parse(data.toString()), binary }); if (records.length > 1024) throw new Error('test record bound'); });
  await once(ws, 'open'); return { ws, records };
}
async function rejected(app, path, credential, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.config.origin.replace('http', 'ws') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + credential, ...headers } });
    ws.on('error', () => {}); ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected native authorization')); });
  });
}
async function helper(app, code) {
  const control = await socket(app, '/forward/helper', code);
  await until(() => control.records.length === 1); const ready = control.records[0].data;
  assert.equal(ready.type, 'ready'); control.ws.send('{"type":"listening"}');
  await until(() => control.records.length === 2);
  return { ...control, ready };
}

test('forward allowlists and pending authorizations are bounded, expire and never expose credentials in status', () => {
  assert.deepEqual(forwardPorts(), [22]); assert.deepEqual(forwardPorts('22,5432,22'), [22,5432]); assert.deepEqual(forwardPorts(''), []);
  for (const value of ['0', '65536', '-22', '22;echo x', '22,', Array(17).fill('22').join(',')]) assert.throws(() => forwardPorts(value));
  let time = 10, valid = true;
  const service = createForwarding({ forwardPorts: [22, 36080], port: 36080 }, { now: () => time }), owner = {};
  try {
    const first = service.create({ localPort: 2222, targetPort: 22 }, owner, () => valid);
    assert.equal(first.code.length, 43); assert.deepEqual(service.list(owner).ports, [22]);
    assert.equal(JSON.stringify(service.list(owner)).includes(first.code), false);
    assert.throws(() => service.create({ localPort: 2223, targetPort: 36080 }, owner, () => true), { status: 400 });
    assert.throws(() => service.create({ localPort: 2222, targetPort: 22 }, owner, () => true), { status: 409 });
    for (let i = 1; i <= 3; i++) service.create({ localPort: 2222 + i, targetPort: 22 }, owner, () => true);
    assert.throws(() => service.create({ localPort: 2230, targetPort: 22 }, owner, () => true), { status: 409 });
    time += 120001; assert.equal(service.list(owner).mappings.length, 0);
    service.create({ localPort: 2222, targetPort: 22 }, owner, () => valid);
    valid = false; service.refresh(); assert.equal(service.list(owner).mappings.length, 0);
  } finally { service.close(); }
});

test('forward APIs preserve login, ownership, Host, Origin and CSRF and accept only explicit loopback targets', async t => {
  const app = await fixture({ forwardPorts: [22,5432] }); t.after(() => app.close());
  assert.equal((await app.request('/api/forward')).status,401);
  await app.login(); assert.equal((await app.request('/api/forward')).status,409); await app.claim();
  assert.equal((await app.request('/api/forward')).status,200);
  const body = { localPort: 2222, targetPort: 22 };
  for (const headers of [{ origin: 'https://evil.test' }, { 'x-csrf-token': '' }]) assert.equal((await app.request('/api/forward', { method: 'POST', body, headers })).status,403);
  assert.equal(await new Promise((resolve,reject)=>{const req=http.get(app.config.origin+'/api/forward',{headers:{host:'evil.test',cookie:app.cookie}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);}),400);
  for (const invalid of [{ ...body, targetPort: 80 }, { ...body, targetHost: '192.168.1.1' }, { ...body, localPort: 0 }, { ...body, targetPort: '22' }]) assert.equal((await app.request('/api/forward', { method:'POST', body:invalid })).status,400);
  for (const id of [null, 12, {toString:null,valueOf:null}, '../22']) assert.equal((await app.request('/api/forward/stop',{method:'POST',body:{id}})).status,400);
  const mapping = await created(app);
  const listed = await (await app.request('/api/forward')).json(); assert.equal(listed.mappings.length,1); assert.equal(JSON.stringify(listed).includes(mapping.code),false);
  assert.deepEqual(app.inputCalls,[]); assert.deepEqual(app.terminalInputs,[]); assert.equal(app.managementStats.restarts,0);
});

test('native pairing is single-use and role-scoped, and forwards literal binary bytes without entering the terminal', async t => {
  const target = await echo(t), app = await fixture({ forwardPorts: [target.port] }); t.after(() => app.close()); await app.login(); await app.claim();
  const mapping = await created(app); assert.equal(target.count,0);
  assert.equal(await rejected(app,'/forward/helper',mapping.code,{origin:'https://evil.test'}),403);
  assert.equal(await rejected(app,'/forward/helper',token()),401);
  assert.equal(await rejected(app,'/forward/data',mapping.code),401);
  const control = await helper(app,mapping.code); t.after(() => control.ws.terminate()); assert.equal(target.count,0);
  assert.equal(await rejected(app,'/forward/helper',mapping.code),401);
  assert.equal(await rejected(app,'/forward/helper',control.ready.streamToken),401);
  const data = await socket(app,'/forward/data',control.ready.streamToken); t.after(() => data.ws.terminate());
  await until(() => data.records.some(record => record.data.type === 'ready'));
  const expected = Buffer.concat([Buffer.from('\0\r\n中文\x1b[31m'),randomBytes(512*1024)]);
  for (let offset=0;offset<expected.length;offset+=16384) data.ws.send(expected.subarray(offset,offset+16384));
  await until(() => Buffer.concat(data.records.filter(record=>record.binary).map(record=>record.data)).length===expected.length);
  assert.deepEqual(Buffer.concat(data.records.filter(record=>record.binary).map(record=>record.data)),expected);
  const closed = once(data.ws,'close'); data.ws.send('{"type":"fin"}'); await closed;
  assert.equal(target.count,1); assert.deepEqual(app.inputCalls,[]); assert.deepEqual(app.terminalInputs,[]);
});

test('TCP half-close preserves a response produced after the client finishes writing', async t => {
  const target = await echo(t,{onSocket(socket) {
    const chunks=[]; socket.on('data',bytes=>chunks.push(bytes)); socket.on('end',()=>socket.end(Buffer.concat([Buffer.from('after-fin:'),...chunks])));
  }}), app=await fixture({forwardPorts:[target.port]}); t.after(()=>app.close());await app.login();await app.claim();
  const control=await helper(app,(await created(app)).code);t.after(()=>control.ws.terminate());
  const data=await socket(app,'/forward/data',control.ready.streamToken);await until(()=>data.records.length===1);
  const closed=once(data.ws,'close');data.ws.send(Buffer.from('请求\0literal'));data.ws.send('{"type":"fin"}');await closed;
  assert.equal(Buffer.concat(data.records.filter(record=>record.binary).map(record=>record.data)).toString(),'after-fin:请求\0literal');
  assert.equal(data.records.some(record=>record.data.type==='fin'),true);
});

test('connection capacity, malformed records, stopping and takeover close only the authorized proxy sockets', async t => {
  const target=await echo(t),app=await fixture({forwardPorts:[target.port]});t.after(()=>app.close());await app.login();await app.claim();
  const mapping=await created(app),control=await helper(app,mapping.code),clients=[];
  t.after(()=>{control.ws.terminate();for(const client of clients)client.ws.terminate();});
  for(let i=0;i<8;i++){const data=await socket(app,'/forward/data',control.ready.streamToken);clients.push(data);await until(()=>data.records.length===1);}
  assert.equal(await rejected(app,'/forward/data',control.ready.streamToken),429);
  const malformed=once(clients[0].ws,'close');clients[0].ws.send('{"type":"connect","port":80}');await malformed;
  await until(async()=> (await (await app.request('/api/forward')).json()).mappings[0].connections===7);
  const closed=clients.slice(1).map(client=>once(client.ws,'close')),ended=once(control.ws,'close');
  assert.equal((await app.request('/api/forward/stop',{method:'POST',body:{id:mapping.id}})).status,200);
  await Promise.all([...closed,ended]);assert.equal(await rejected(app,'/forward/data',control.ready.streamToken),401);
  const next=await helper(app,(await created(app)).code);const revoked=once(next.ws,'close');
  await app.claim('22222222-2222-4222-8222-222222222222');await revoked;
  assert.equal(app.managementStats.restarts,0);assert.deepEqual(app.inputCalls,[]);
});

test('logout revokes both the helper and live TCP streams without consuming a new pairing',async t=>{
  const target=await echo(t),app=await fixture({forwardPorts:[target.port]});t.after(()=>app.close());await app.login();await app.claim();
  const control=await helper(app,(await created(app)).code),data=await socket(app,'/forward/data',control.ready.streamToken);
  await until(()=>data.records.length===1);
  const closed=[once(control.ws,'close'),once(data.ws,'close')];
  assert.equal((await app.request('/api/logout',{method:'POST',body:{}})).status,200);await Promise.all(closed);
  assert.equal(await rejected(app,'/forward/data',control.ready.streamToken),401);
});

test('a delayed forwarding body cannot create authorizations after takeover',async t=>{
  const app=await fixture();t.after(()=>app.close());await app.login();await app.claim();
  const body=JSON.stringify({localPort:2222,targetPort:22}),started=once(app.panel.server,'request');let pending;
  const response=new Promise((resolve,reject)=>{
    pending=http.request(app.config.origin+'/api/forward',{method:'POST',headers:{cookie:app.cookie,origin:app.config.origin,'x-csrf-token':app.csrf,'x-viewer-id':app.viewer,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
    pending.once('error',reject);pending.write(body.slice(0,1));
  });t.after(()=>pending.destroy());await started;
  const newViewer='22222222-2222-4222-8222-222222222222';await app.claim(newViewer);pending.end(body.slice(1));assert.equal(await response,409);
  const result=await(await app.request('/api/forward',{headers:{'x-viewer-id':newViewer}})).json();assert.deepEqual(result.mappings,[]);
});

test('oversized native frames close their stream and a gateway restart discards authorization without replay',async t=>{
  const target=await echo(t),app=await fixture({forwardPorts:[target.port]});let closed=false;t.after(async()=>{if(!closed)await app.close();});
  await app.login();await app.claim();const mapping=await created(app),control=await helper(app,mapping.code),data=await socket(app,'/forward/data',control.ready.streamToken);
  await until(()=>data.records.length===1);const oversized=once(data.ws,'close');data.ws.send(Buffer.alloc(16385));assert.equal((await oversized)[0],1009);
  const ended=once(control.ws,'close');await app.close({preserve:true});closed=true;await ended;
  const recovered=await fixture({dataDir:app.directory,forwardPorts:[target.port]});t.after(async()=>{await recovered.close();await rm(app.directory,{recursive:true,force:true});});
  await recovered.login();await recovered.claim();assert.deepEqual((await(await recovered.request('/api/forward')).json()).mappings,[]);
  assert.equal(await rejected(recovered,'/forward/helper',mapping.code),401);assert.equal(await rejected(recovered,'/forward/data',control.ready.streamToken),401);
});

test('helper downloads require authentication and use only fixed bounded regular files',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-forward-download-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const name='codex-cloud-forward-windows-amd64.exe',bytes=Buffer.from('MZ-test-only-not-a-real-binary'),sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory,name),bytes);await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,files:[{arch:'windows-amd64',name,size:bytes.length,sha256,build:'test'}]}));
  const app=await fixture({forwardDownloadDir:directory});t.after(()=>app.close());
  const path='/api/forward/download/windows-amd64';assert.equal((await app.request(path)).status,401);await app.login();await app.claim();
  const listing=await(await app.request('/api/forward')).json();assert.equal(listing.downloads[0].sha256,sha256);
  const download=await app.request(path);assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await app.request('/api/forward/download/unknown')).status,404);
  await rm(join(directory,name));await symlink(join(directory,'manifest.json'),join(directory,name));assert.equal((await app.request(path)).status,502);
});
