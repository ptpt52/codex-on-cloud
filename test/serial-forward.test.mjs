import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { serialConfig } from '../panel/serial-config.mjs';

const config = { path: 'COM3', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false };
async function until(probe) { for (let i=0;i<200;i++) {if(await probe())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('serial test deadline'); }
async function availablePort() { const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port; }
async function channel(app,path,token,headers={}) {
 const ws=new WebSocket(app.config.origin.replace('http:','ws:')+path,'codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+token,...headers}}),records=[];
 ws.on('error',()=>{});ws.on('message',(bytes,binary)=>records.push({binary,data:binary?Buffer.from(bytes):JSON.parse(bytes)}));await once(ws,'open');return {ws,records};
}
async function denied(app,code) {return new Promise(resolve=>{const ws=new WebSocket(app.config.origin.replace('http:','ws:')+'/forward/helper','codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+code,'x-codex-forward-reverse':'1'}});ws.on('error',()=>{});ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve({status:res.statusCode,code:res.headers['x-codex-forward-error']});});});}

test('serial targets have a strict device-only schema and cannot become arbitrary files, shell commands, TCP targets or mutable directory entries',()=>{
 assert.deepEqual(serialConfig(config),config);
 for(const path of ['COM0','COM1;calc','/etc/passwd','/dev/zero','/dev/ttyUSB0/../../etc/passwd','/dev/pts/2','/dev/cu.a\nfoo','COM3\u001b'])assert.throws(()=>serialConfig({...config,path}),{status:400});
 for(const changed of [{baud:123},{dataBits:9},{parity:'mark'},{stopBits:1.5},{dtr:1},{rts:null},{extra:1}])assert.throws(()=>serialConfig({...config,...changed}),{status:400});
 for(const path of ['/dev/cu.usbserial-123','/dev/ttyUSB0','/dev/serial/by-id/usb-adapter'])assert.equal(serialConfig({...config,path}).path,path);
});

test('serial requires explicit helper capability and consent, opens only loopback, limits to one client, and preserves bytes without replay',async t=>{
 const app=await fixture({forwardPorts:[]});t.after(()=>app.close());await app.login();await app.claim();const port=await availablePort();
 const body={direction:'reverse',protocol:'serial',deviceName:'console',localPort:port,serial:config};
 assert.equal((await app.request('/api/forward',{method:'POST',body:{...body,targetHost:'127.0.0.1',targetPort:22}})).status,400);
 const response=await app.request('/api/forward',{method:'POST',body});assert.equal(response.status,200);const grant=await response.json();
 assert.deepEqual(await denied(app,grant.code),{status:426,code:'serial_upgrade_required'});
 const rejected=await(await app.request('/api/forward')).json();assert.equal(rejected.mappings[0].state,'pending');assert.equal(rejected.mappings[0].errorCode,'serial_upgrade_required');
 const helper=await channel(app,'/forward/helper',grant.code,{'x-codex-forward-reverse':'1','x-codex-forward-serial':'1'});await until(()=>helper.records.length===1);
 const ready=helper.records[0].data;assert.equal(ready.maxConnections,1);assert.deepEqual(ready.serial,config);assert.equal(ready.targetHost,undefined);assert.equal(ready.targetPort,undefined);
 await new Promise(resolve=>{const tcp=net.createConnection({host:'127.0.0.1',port});tcp.once('error',error=>{assert.equal(error.code,'ECONNREFUSED');resolve();});});
 helper.ws.send('{"type":"listening"}');await until(()=>helper.records.length===2);
 const tcp=net.createConnection({host:'127.0.0.1',port});tcp.on('error',()=>{});t.after(()=>tcp.destroy());
 await until(()=>helper.records.some(record=>record.data.type==='reverse_open'));const id=helper.records.find(record=>record.data.type==='reverse_open').data.id;
 const data=await channel(app,'/forward/data',ready.streamToken,{'x-codex-reverse-stream':id});await until(()=>data.records.length===1);data.ws.send('{"type":"target_ready"}');
 const bytes=Buffer.from([0,255,27,13,10,65]),received=once(tcp,'data');data.ws.send(bytes);assert.deepEqual((await received)[0],bytes);tcp.write(bytes);await until(()=>data.records.some(record=>record.binary && record.data.equals(bytes)));
 const extra=net.createConnection({host:'127.0.0.1',port});extra.on('error',()=>{});await once(extra,'close');assert.equal(helper.records.filter(record=>record.data.type==='reverse_open').length,1);
 const state=await(await app.request('/api/forward')).json();assert.equal(state.mappings[0].maxConnections,1);assert.equal(state.mappings[0].targetStatus.state,'reachable');
 data.ws.send('{"type":"error","code":"serial_disconnected"}');await once(tcp,'close');await until(()=>data.ws.readyState===3);
 const after=await(await app.request('/api/forward')).json();assert.equal(after.mappings[0].targetStatus.state,'failed');assert.equal(after.mappings[0].errorCode,'serial_disconnected');assert.equal(after.mappings[0].state,'active');
 assert.equal(app.inputCalls.length,0);assert.equal(app.managementStats.restarts,0);helper.ws.terminate();
});
