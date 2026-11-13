import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';
async function setup(app){await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});}
test('temporary service direct uses real ICE/DTLS with scoped RPC, keeps desktop ownership and revokes on account changes',async t=>{
 const app=await fixture({webrtc:true,forwardPorts:'*'});t.after(()=>app.close());await setup(app);
 const client=await serviceClient(app,{hints:{server:'10.123.254.253',browser:'10.123.254.252'}});t.after(()=>client.close());
 assert.equal((await client.rpc('ping')).value.ready,true);const state=await client.rpc('state');assert.equal(state.value.access.role,'temporary');assert.equal(state.value.mine,false);
 for(const action of ['paste','key','activate','terminals','/api/security','__proto__'])assert.equal((await client.rpc(action)).error.status,400);
 assert.equal((await client.rpc('forward-create',{localPort:2222,targetPort:22})).error.status,400);
 assert.equal((await client.rpc('files')).ok,true);assert.equal((await client.rpc('diagnostics')).ok,true);
 assert.equal((await(await app.request('/api/state')).json()).mine,true);assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
 await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});
 for(let i=0;i<100&&client.channel.readyState!=='closed';i++)await new Promise(r=>setTimeout(r,20));assert.equal(client.channel.readyState,'closed');
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
