import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';
import { localServiceRequest } from '../panel/service-rtc.mjs';
async function setup(app){await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});}
for(const afterHeaders of [false,true])test(`local HTTP failure ${afterHeaders?'during the body':'before headers'} retains a distinct diagnostic code`,async t=>{
 const server=http.createServer((req,res)=>{req.resume();if(afterHeaders){res.writeHead(200,{'content-type':'application/json'});res.write('{');setImmediate(()=>res.destroy());}else req.socket.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 await assert.rejects(localServiceRequest(server.address().port,{},'files',{},new AbortController().signal),{status:502,code:'local_http_error',outcome:'unknown'});
});
test('a local service timeout returns an unknown HTTP outcome before the browser deadline without retrying', { timeout: 10000 }, async t => {
 let calls=0;
 const server=http.createServer((req,_res)=>{calls++;req.resume();});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 await assert.rejects(localServiceRequest(server.address().port,{},'file-delete',{name:'once',version:'a'.repeat(64)},new AbortController().signal),{status:504,code:'local_http_timeout',outcome:'unknown'});
 assert.equal(calls,1);
});
test('a service deletion without an explicit 5xx outcome remains unknown and is never retried',async t=>{
 let calls=0,status=503,result={error:'reply after an uncertain mutation'};
 const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/api/files/delete');assert.equal(req.method,'POST');req.resume();res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(result));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const remove=()=>localServiceRequest(server.address().port,{},'file-delete',{name:'once',version:'a'.repeat(64)},new AbortController().signal);
 await assert.rejects(remove(),error=>error.status===503&&error.outcome==='unknown');assert.equal(calls,1);
 result={error:'rejected before mutation',outcome:'rejected'};
 await assert.rejects(remove(),error=>error.status===503&&error.outcome==='rejected');assert.equal(calls,2);
 status=412;result={error:'version changed'};
 await assert.rejects(remove(),error=>error.status===412&&error.outcome==='rejected');assert.equal(calls,3);
});
test('temporary service direct uses real ICE/DTLS with scoped RPC, keeps desktop ownership and revokes on account changes',async t=>{
 const app=await fixture({webrtc:true,forwardPorts:'*'});t.after(()=>app.close());await setup(app);
 const client=await serviceClient(app,{hints:{server:'10.123.254.253',browser:'10.123.254.252'}});t.after(()=>client.close());
 assert.equal((await client.rpc('ping')).value.ready,true);const state=await client.rpc('state');assert.equal(state.value.access.role,'temporary');assert.equal(state.value.mine,false);
 for(const action of ['paste','key','activate','terminals','/api/security','__proto__'])assert.equal((await client.rpc(action)).error.status,400);
 assert.equal((await client.rpc('forward-create',{localPort:2222,targetPort:22})).error.status,400);
 assert.equal((await client.rpc('files')).ok,true);assert.equal((await client.rpc('diagnostics')).ok,true);
 app.files.set('keep',Buffer.from('shared'));const listed=await client.rpc('files');
 assert.equal((await client.rpc('file-delete',{name:'keep',version:listed.value.files[0].version})).error.status,403);assert.equal(app.files.has('keep'),true);
 assert.equal((await(await app.request('/api/state')).json()).mine,true);assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
 await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});
 for(let i=0;i<100&&client.channel.readyState!=='closed';i++)await new Promise(r=>setTimeout(r,20));assert.equal(client.channel.readyState,'closed');
});
test('administrator file deletion reuses the authenticated service control channel without desktop input',async t=>{
 const app=await fixture({webrtc:true});t.after(()=>app.close());app.files.set('remove',Buffer.from('file'));
 const client=await serviceClient(app,{username:app.config.username,password:app.config.password});t.after(()=>client.close());
 const listed=await client.rpc('files'),version=listed.value.files[0].version;
 assert.equal((await client.rpc('file-delete',{name:'remove',version})).value.ok,true);assert.equal(app.files.has('remove'),false);
 assert.equal((await client.rpc('file-delete',{name:'remove',version})).error.status,412);
 assert.equal((await client.rpc('files')).ok,true);assert.equal(client.channel.readyState,'open');assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
});
test('service signaling retains authentication, CSRF, origin, viewer and strict offer checks without claiming desktop',async t=>{
 const app=await fixture({webrtc:true});t.after(()=>app.close());
 assert.equal((await app.request('/api/service/rtc',{method:'POST',body:{}})).status,401);await app.login();
 for(const headers of [{origin:'https://evil.example'},{'x-csrf-token':''}])assert.equal((await app.request('/api/service/rtc',{method:'POST',body:{},headers})).status,403);
 assert.equal((await app.request('/api/service/rtc',{method:'POST',body:{}})).status,400);assert.equal(app.vncConnections,0);
});
test('service peers are bounded per login and refuse VNC channels without opening desktop resources',async t=>{
 const app=await fixture({webrtc:true});t.after(()=>app.close());await setup(app);
 const c=await serviceClient(app);t.after(()=>c.close());const body={...c.peer.localDescription};
 assert.equal((await c.request('/api/service/rtc',body,{'x-viewer-id':'b'.repeat(32)})).status,200);
 assert.equal((await c.request('/api/service/rtc',body,{'x-viewer-id':'c'.repeat(32)})).status,429);
 assert.equal((await c.request('/api/service/rtc',body)).status,429);
 c.peer.createDataChannel('codex-vnc',{ordered:true,protocol:'rfb'});
 for(let n=0;n<100&&c.channel.readyState!=='closed';n++)await new Promise(r=>setTimeout(r,20));assert.equal(c.channel.readyState,'closed');assert.equal(app.vncConnections,0);
});

test('a service recheck keeps the old peer usable and admits only one restricted candidate until promotion', async t => {
 const app=await fixture({webrtc:true});t.after(()=>app.close());await setup(app);
 const old=await serviceClient(app);t.after(()=>old.close());
 const candidate=await serviceClient(app,{reuse:old,recheck:true});t.after(()=>candidate.close());
 assert.equal((await old.rpc('files')).ok,true);assert.equal((await candidate.rpc('files')).error.status,409);
 assert.equal((await candidate.request('/api/service/rtc',{...candidate.peer.localDescription,recheck:true})).status,429);
 assert.equal(old.channel.readyState,'open');assert.equal((await candidate.rpc('promote')).value.promoted,true);
 assert.equal((await candidate.rpc('files')).ok,true);
 for(let n=0;n<100&&old.channel.readyState!=='closed';n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(old.channel.readyState,'closed');assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
});
