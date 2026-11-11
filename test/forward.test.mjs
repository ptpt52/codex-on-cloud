import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { fixture } from './support/forward-transport.mjs';
import { createForwarding, forwardPorts, forwardTargetHost } from '../panel/forward.mjs';

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
  server.listen(0, options.host || '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, get count() { return count; } };
}
async function created(app, targetPort = app.config.forwardPorts[0], localPort = 2222) {
  const response = await app.request('mapping', { method: 'POST', body: { localPort, targetPort } });
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
  assert.equal(forwardPorts(), '*'); assert.equal(forwardPorts('*'), '*'); assert.deepEqual(forwardPorts('22,5432,22'), [22,5432]); assert.deepEqual(forwardPorts(''), []);
  for (const value of ['0', '65536', '-22', '22;echo x', '22,', Array(17).fill('22').join(',')]) assert.throws(() => forwardPorts(value));
  let time = 10, invalid = '';
  const service = createForwarding({ forwardPorts: [22, 36080], port: 36080 }, { now: () => time }), owner = {};
  try {
    const first = service.create({ localPort: 2222, targetPort: 22 }, owner, () => invalid);
    assert.equal(first.code.length, 43); assert.deepEqual(service.list(owner).ports, [22]);
    assert.equal(JSON.stringify(service.list(owner)).includes(first.code), false);
    assert.throws(() => service.create({ localPort: 2223, targetPort: 36080 }, owner, () => ''), { status: 400 });
    assert.throws(() => service.create({ localPort: 2222, targetPort: 22 }, owner, () => ''), { status: 409 });
    let last = first; for (let i = 1; i <= 31; i++) last = service.create({ localPort: 2222 + i, targetPort: 22 }, owner, () => '');
    assert.throws(() => service.create({ localPort: 3333, targetPort: 22 }, owner, () => ''), { status: 409 });
    time += 120001; assert.equal(service.list(owner).mappings.length, 0);
    let denied='';service.upgrade({headers:{authorization:'Bearer '+last.code,'sec-websocket-protocol':'codex-forward-v1'}},{end:value=>{denied=value;}},Buffer.alloc(0),'/forward/helper');
    assert.match(denied,/410 Rejected/);assert.match(denied,/pair_expired/);
    service.create({ localPort: 2222, targetPort: 22 }, owner, () => invalid);
    invalid = 'authorization_expired'; service.refresh(); assert.equal(service.list(owner).mappings.length, 0);
    assert.equal(service.list().recent[0].code,'authorization_expired');
    for(let i=0;i<20;i++){const item=service.create({localPort:2222,targetPort:22},owner,()=> '');service.stop({id:item.id});}
    assert.equal(service.list().recent.length,8);assert.equal(JSON.stringify(service.list()).includes('pairHash'),false);
    time+=600001;assert.deepEqual(service.list().recent,[]);
  } finally { service.close(); }
});


test('custom targets accept literal IPv4 and IPv6 without DNS, normalize aliases and keep authorizations bound to one destination', () => {
  for (const [input, expected] of [[undefined, '127.0.0.1'], [' 192.168.1.10 ', '192.168.1.10'], ['[2001:DB8:0:0::1]', '2001:db8::1'], ['::1', '::1'], ['::ffff:127.0.0.2', '127.0.0.2']]) assert.equal(forwardTargetHost(input), expected);
  for (const host of [null, 123, '', 'localhost', '1.2.3', '010.0.0.1', 'https://192.168.1.1', '192.168.1.1:22', '192.168.1.1;echo x', '1.2.3.4\nX-Host: evil', 'fe80::1%eth0', '0.0.0.0', '::', '224.0.0.1', 'ff02::1', '::ffff:224.0.0.1', '255.255.255.255', 'a'.repeat(65)]) assert.throws(() => forwardTargetHost(host), { status:400 });
  const service = createForwarding({ forwardPorts:'*', port:36080, agentPort:36902, fileAgentPort:36904, tunnelMetricsPort:36903 });
  try {
    const body = { localPort:2222, targetHost:'192.168.1.10', targetPort:5432 }, item = service.create(body, {}, () => '');
    body.targetHost = '192.168.1.11'; body.targetPort = 3306;
    assert.equal(item.targetHost, '192.168.1.10'); assert.equal(service.list().allPorts, true);
    assert.equal(service.list().mappings[0].targetHost, '192.168.1.10'); assert.equal(service.list().mappings[0].targetPort, 5432);
    for (const targetPort of [0, 65536, 22.5, '22', 36080, 36902, 36903, 36904]) assert.throws(() => service.create({ localPort:2223, targetHost:'::1', targetPort }, {}, () => ''), { status:400 });
    service.stop({id:item.id}); assert.equal(service.list().recent[0].targetHost, '192.168.1.10');
    const old = service.create({ localPort:2222, targetPort:65535 }, {}, () => ''); assert.equal(old.targetHost, '127.0.0.1');
  } finally { service.close(); }
  const disabled = createForwarding({forwardPorts:[]});
  try { assert.throws(() => disabled.create({localPort:2222,targetHost:'192.168.1.10',targetPort:22}, {}, () => ''), {status:400}); } finally { disabled.close(); }
});

for (const host of ['127.0.0.2', '::1']) test(`custom ${host} destination receives binary data only when a client opens its authorized stream`, async t => {
  const target = await echo(t, {host}), app = await fixture({forwardPorts:'*'}); t.after(() => app.close());
  const response = await app.request('mapping', {method:'POST',body:{localPort:2222,targetHost:host,targetPort:target.port}}); assert.equal(response.status,200);
  const mapping = await response.json(), control = await helper(app, mapping.code); t.after(() => control.ws.terminate());
  assert.equal(control.ready.targetHost,host); assert.equal(control.ready.targetPort,target.port); assert.equal(target.count,0);
  const stream = await socket(app,'/forward/data',control.ready.streamToken); t.after(() => stream.ws.terminate());
  await until(() => stream.records.some(record => record.data.type === 'ready'));
  const bytes = Buffer.concat([Buffer.from('\0中文\r\n'),randomBytes(8192)]); stream.ws.send(bytes);
  await until(() => stream.records.some(record => record.binary)); assert.deepEqual(Buffer.concat(stream.records.filter(record => record.binary).map(record => record.data)),bytes); assert.equal(target.count,1);
  assert.deepEqual(app.inputCalls,[]); assert.deepEqual(app.terminalInputs,[]);
});

test('per-rule channel authorization is single-use and capability-scoped, and forwards literal binary bytes without entering the terminal', async t => {
  const target = await echo(t), app = await fixture({ forwardPorts: [target.port] }); t.after(() => app.close());
  const mapping = await created(app); assert.equal(target.count,0);
  assert.equal(await rejected(app,'/forward/helper',mapping.code,{origin:'https://evil.test'}),403);
  assert.equal(await rejected(app,'/forward/helper',token()),401);
  assert.equal(await rejected(app,'/forward/data',mapping.code),401);
  const control = await helper(app,mapping.code); t.after(() => control.ws.terminate()); assert.equal(target.count,0);
  assert.equal(await rejected(app,'/forward/helper',mapping.code),409);
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
  }}), app=await fixture({forwardPorts:[target.port]}); t.after(()=>app.close());
  const control=await helper(app,(await created(app)).code);t.after(()=>control.ws.terminate());
  const data=await socket(app,'/forward/data',control.ready.streamToken);await until(()=>data.records.length===1);
  const closed=once(data.ws,'close');data.ws.send(Buffer.from('请求\0literal'));data.ws.send('{"type":"fin"}');await closed;
  assert.equal(Buffer.concat(data.records.filter(record=>record.binary).map(record=>record.data)).toString(),'after-fin:请求\0literal');
  assert.equal(data.records.some(record=>record.data.type==='fin'),true);
});




test('oversized native frames close their stream and a gateway restart discards authorization without replay',async t=>{
  const target=await echo(t),app=await fixture({forwardPorts:[target.port]});let closed=false;t.after(async()=>{if(!closed)await app.close();});
  const mapping=await created(app),control=await helper(app,mapping.code),data=await socket(app,'/forward/data',control.ready.streamToken);
  await until(()=>data.records.length===1);const oversized=once(data.ws,'close');data.ws.send(Buffer.alloc(16385));assert.equal((await oversized)[0],1009);
  const ended=once(control.ws,'close');await app.close({preserve:true});closed=true;await ended;
  const recovered=await fixture({dataDir:app.directory,forwardPorts:[target.port]});t.after(async()=>{await recovered.close();});
  assert.deepEqual((await(await recovered.request('mapping')).json()).mappings,[]);
  assert.equal(await rejected(recovered,'/forward/helper',mapping.code),401);assert.equal(await rejected(recovered,'/forward/data',control.ready.streamToken),401);
});

test('local listen errors are fixed records, free mapping slots and retain only bounded non-secret diagnostics',async t=>{
  const app=await fixture();t.after(()=>app.close());
  for(const code of ['local_port_in_use','local_listen_failed','arbitrary error with secret']){
    const mapping=await created(app),control=await socket(app,'/forward/helper',mapping.code);await until(()=>control.records.length===1);
    const closed=once(control.ws,'close');control.ws.send(JSON.stringify({type:'error',code}));
    const expected=code.startsWith('local_')?code:'protocol_error';assert.equal((await closed)[1].toString(),expected);
    const data=await(await app.request('mapping')).json();assert.equal(data.mappings.length,0);assert.equal(data.recent[0].code,expected);
    assert.equal(JSON.stringify(data).includes(mapping.code),false);assert.equal(JSON.stringify(data).includes('arbitrary error with secret'),false);
    assert.equal(JSON.stringify(data).includes('pairHash'),false);assert.equal(JSON.stringify(data).includes('streamToken'),false);
  }
});

test('unavailable target errors reach data clients and status, without stopping the mapping or retrying TCP',async t=>{
  const target=net.createServer();target.listen(0,'127.0.0.1');await once(target,'listening');const port=target.address().port;await new Promise(resolve=>target.close(resolve));
  const app=await fixture({forwardPorts:[port]});t.after(()=>app.close());
  const control=await helper(app,(await created(app)).code),data=await socket(app,'/forward/data',control.ready.streamToken);
  await until(()=>data.records.length>0);assert.deepEqual(data.records[0].data,{type:'error',code:'target_unavailable'});
  let status=await(await app.request('mapping')).json();assert.equal(status.mappings[0].state,'active');assert.equal(status.mappings[0].errorCode,'target_unavailable');
  assert.match(status.mappings[0].error,/目标端口无法连接/);
  let accepted=0;const peers=new Set();target.on('connection',socket=>{accepted++;peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));socket.on('data',bytes=>socket.end(bytes));});
  target.listen(port,'127.0.0.1');await once(target,'listening');t.after(async()=>{for(const socket of peers)socket.destroy();await new Promise(resolve=>target.close(resolve));});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(accepted,0,'Failure must not retry TCP automatically');
  const retry=await socket(app,'/forward/data',control.ready.streamToken);await until(()=>retry.records.length===1);retry.ws.send(Buffer.from('manual retry'));
  await until(()=>retry.records.some(item=>item.binary));assert.equal(retry.records.find(item=>item.binary).data.toString(),'manual retry');retry.ws.terminate();
  status=await(await app.request('mapping')).json();assert.equal(status.mappings[0].errorCode,'');assert.equal(accepted,1);
});

test('direct signaling rejects invalid SDP before allocation and authenticates the mapping stream capability independently of page claims',async t=>{
  let allocations=0,captured,destroyed=false;
  const app=await fixture({webrtc:true,forwardPeerFactory:options=>{
    allocations++;captured=options;
    return {state:{id:options.id,available:false,reason:'rtc_connecting',family:null,rttMs:null},streams:0,
      async answer(){return 'test answer: not a real DTLS connection';},
      async destroy(){if(!destroyed){destroyed=true;options.closed();}}};
  }});t.after(()=>app.close());
  const mapping=await created(app),control=await socket(app,'/forward/helper',mapping.code);
  await until(()=>control.records.length===1);const ready=control.records[0].data;
  control.ws.send('{"type":"listening","direct":1}');await until(()=>control.records.length===3);
  assert.equal(control.records[2].data.type,'rtc_config');
  control.ws.send(JSON.stringify({type:'rtc_offer',id:1,sdp:'not encrypted SDP'}));await until(()=>control.records.length===4);
  assert.equal(allocations,0);assert.equal((await(await app.request('mapping')).json()).mappings[0].direct.reason,'rtc_negotiation_failed');
  const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\na=candidate:1 1 udp 123 127.0.0.1 40048 typ host\r\n';
  control.ws.send(JSON.stringify({type:'rtc_offer',id:2,sdp}));await until(()=>captured);
  assert.equal(allocations,1);assert.equal(captured.authenticate(ready.streamToken),true);assert.equal(captured.authenticate(mapping.code),false);assert.equal(captured.authenticate(token()),false);assert.equal(captured.valid(),true);
  assert.equal(captured.valid(),true);
  await app.request('revoke',{method:'POST',body:{}});assert.equal(captured.valid(),false);assert.equal(destroyed,true);
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);assert.equal(app.managementStats.restarts,0);
});
