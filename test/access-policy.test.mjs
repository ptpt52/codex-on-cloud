import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import net from 'node:net';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function client(app,username='admin',password=app.config.password){
  const viewer=randomUUID();let cookie='',csrf='';
  const request=(path,body)=>fetch(app.config.origin+path,{method:body===undefined?'GET':'POST',headers:{origin:app.config.origin,cookie,'x-viewer-id':viewer,'x-csrf-token':csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const response=await request('/api/login',{username,password});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];const logged=await response.json();csrf=logged.csrf;
  return {viewer,cookie,csrf,logged,request,claim:lockPassword=>request('/api/desktop/claim',{viewer,...(lockPassword?{lockPassword}:{})})};
}
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function reverse(c){return c.request('/api/forward',{direction:'reverse',deviceName:'test device',protocol:'ssh',localPort:await freePort(),targetHost:'192.168.1.1',targetPort:22});}
test('screen lock protects initial access and every takeover while status, reverse maps and files stay available',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const a=await client(app);assert.equal((await a.claim()).status,200);
  const original=await(await reverse(a)).json();
  assert.equal((await a.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'})).status,200);
  assert.equal((await a.request('/api/terminals')).status,423);assert.equal((await a.claim()).status,423);assert.equal((await a.claim('wrong')).status,403);
  assert.equal((await a.claim('test-screen-password')).status,200);assert.equal((await a.request('/api/terminals')).status,200);
  const b=await client(app);assert.equal(b.logged.access.requiresUnlock,true);assert.equal((await b.claim()).status,423);
  assert.equal((await(await a.request('/api/state')).json()).mine,true,'A login elsewhere must not implicitly steal the unlocked desktop');
  assert.equal((await b.claim('test-screen-password')).status,200);assert.equal((await a.claim()).status,423);assert.equal((await a.request('/api/terminals')).status,423);
  assert.equal((await a.request('/api/state')).status,200);assert.equal((await a.request('/api/diagnostics')).status,200);assert.equal((await a.request('/api/files')).status,200);
  const maps=await(await a.request('/api/forward')).json();assert.ok(maps.mappings.some(m=>m.id===original.id));assert.deepEqual(maps.permissions.directions,['reverse']);
  assert.equal((await a.request('/api/forward',{localPort:2222,targetPort:22})).status,423);assert.equal((await reverse(a)).status,200);
  const state=await(await a.request('/api/state')).json();assert.equal(state.controls.input,undefined);assert.equal(state.access.full,false);
  assert.deepEqual(app.inputCalls,[]);assert.equal(app.managementStats.restarts,0);
});
test('temporary accounts cannot unlock, inspect terminals, manage other sessions or create forward maps, even with the screen password',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const admin=await client(app);await admin.claim();
  const original=await(await reverse(admin)).json();
  await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});await admin.claim('test-screen-password');
  assert.equal((await admin.request('/api/security/temporary-account',{enabled:true,username:'visitor',password:'test-guest-password',durationMs:3600000})).status,200);
  const guest=await client(app,'visitor','test-guest-password');assert.equal(guest.logged.username,'visitor');assert.equal(guest.logged.access.role,'temporary');
  for(const path of ['/api/terminals','/api/desktop/settings','/api/forward/devices','/api/security','/desktop/index.html','/terminal/index.html'])assert.equal((await guest.request(path)).status,403,path);
  assert.equal((await guest.claim('test-screen-password')).status,403);
  assert.equal((await guest.request('/api/forward',{localPort:2222,targetPort:22})).status,403);
  const created=await(await reverse(guest)).json();assert.ok(created.id);
  const maps=await(await guest.request('/api/forward')).json();assert.equal(maps.mappings.length,1);assert.equal(maps.mappings[0].id,created.id);assert.equal(maps.devices.length,0);assert.ok(!JSON.stringify(maps).includes(original.id));
  assert.equal((await guest.request('/api/forward/stop',{id:original.id})).status,403);
  const rejected=await new Promise(resolve=>{const ws=new WebSocket(app.config.origin.replace('http','ws')+'/desktop/websockify?viewer='+guest.viewer,{headers:{origin:app.config.origin,cookie:guest.cookie}});ws.on('error',()=>{});ws.on('unexpected-response',(_q,r)=>{r.resume();ws.terminate();resolve(r.statusCode);});ws.on('open',()=>{ws.terminate();resolve(101);});});assert.equal(rejected,403);
  const upload=await fetch(app.config.origin+'/api/files/test.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:guest.cookie,'x-csrf-token':guest.csrf,'content-type':'application/octet-stream'},body:'guest file'});assert.equal(upload.status,200);
  assert.equal(await(await fetch(app.config.origin+'/api/files/test.txt',{headers:{cookie:guest.cookie}})).text(),'guest file');
  assert.equal((await admin.request('/api/security/temporary-account',{enabled:false})).status,200);assert.equal((await guest.request('/api/me')).status,401);
  const remaining=await(await admin.request('/api/forward')).json();assert.ok(remaining.mappings.some(m=>m.id===original.id));assert.ok(!remaining.mappings.some(m=>m.id===created.id));
  assert.equal((await(await admin.request('/api/state')).json()).mine,true);assert.deepEqual(app.inputCalls,[]);
});

test('locked sessions reject all terminal and desktop APIs and retain CSRF checks on shared operations',async t=>{
  const app=await fixture();t.after(()=>app.close());const admin=await client(app);await admin.claim();
  await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});
  for(const path of ['/api/terminals','/api/desktop/settings','/api/forward/devices','/api/security'])assert.equal((await admin.request(path)).status,423,path);
  for(const path of ['/api/paste','/api/key','/api/terminal','/api/clipboard/read','/api/desktop/rtc','/api/terminal/rtc','/api/terminal/history','/api/desktop/settings','/api/desktop/resolution','/api/desktop/viewport','/api/forward/devices','/api/forward/devices/remove','/api/security/screen-lock'])assert.equal((await admin.request(path,{})).status,423,path);
  const invalid=await fetch(app.config.origin+'/api/files/no.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:admin.cookie,'content-type':'application/octet-stream'},body:'no'});assert.equal(invalid.status,403);
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);
});

test('delayed device-directory writes cannot commit after losing screen ownership',async t=>{
  const app=await fixture();t.after(()=>app.close());const admin=await client(app);await admin.claim();
  const body=JSON.stringify({name:'pending device',protocol:'ssh',localPort:22001,targetHost:'192.168.1.1',targetPort:22}),started=once(app.panel.server,'request');let pending;
  const response=new Promise((resolve,reject)=>{
    pending=http.request(app.config.origin+'/api/forward/devices',{method:'POST',headers:{origin:app.config.origin,cookie:admin.cookie,'x-csrf-token':admin.csrf,'x-viewer-id':admin.viewer,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
    pending.on('error',reject);pending.write(body.slice(0,1));
  });t.after(()=>pending.destroy());await started;
  const other=await client(app);await other.claim();pending.end(body.slice(1));assert.equal(await response,409);
  assert.deepEqual((await(await other.request('/api/forward/devices')).json()).devices,[]);
});

test('temporary expiry removes only its maps and uploads obey the shared directory bounds',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const admin=await client(app);await admin.claim();
  await admin.request('/api/security/temporary-account',{enabled:true,username:'visitor',password:'test-guest-password',durationMs:300000});const guest=await client(app,'visitor','test-guest-password');
  const original=await(await reverse(admin)).json(),temporary=await(await reverse(guest)).json();
  const upload=()=>fetch(app.config.origin+'/api/files/new.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:guest.cookie,'x-csrf-token':guest.csrf,'content-type':'application/octet-stream'},body:'x'});
  app.files.set('large.bin',{length:1024*1024*1024});assert.equal((await upload()).status,413);app.files.clear();
  for(let i=0;i<1000;i++)app.files.set('f'+i,Buffer.alloc(0));assert.equal((await upload()).status,413);app.files.clear();
  const now=Date.now();t.mock.method(Date,'now',()=>now+300001);
  assert.equal((await guest.request('/api/me')).status,401);assert.equal((await admin.request('/api/me')).status,200);
  const maps=await(await admin.request('/api/forward')).json();assert.ok(maps.mappings.some(m=>m.id===original.id));assert.ok(!maps.mappings.some(m=>m.id===temporary.id));
});

test('panel restart preserves credential policy and login roles but requires a fresh screen unlock',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-access-restart-'));let app=await fixture({dataDir:directory});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const admin=await client(app);await admin.claim();await admin.request('/api/security/temporary-account',{enabled:true,username:'visitor',password:'test-guest-password'});
  const guest=await client(app,'visitor','test-guest-password');await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});await admin.claim('test-screen-password');
  await app.close();app=await fixture({dataDir:directory});
  const restored=async c=>(await fetch(app.config.origin+'/api/me',{headers:{cookie:c.cookie,'x-viewer-id':c.viewer}})).json();
  const a=await restored(admin),g=await restored(guest);assert.equal(a.access.requiresUnlock,true);assert.equal(a.access.full,false);assert.equal(g.access.role,'temporary');assert.equal(g.access.canClaim,false);
  assert.equal((await fetch(app.config.origin+'/api/terminals',{headers:{cookie:admin.cookie,'x-viewer-id':admin.viewer}})).status,423);
});

test('screen password failures are bounded and cannot be reset by spoofing forwarding headers',async t=>{
  const app=await fixture();t.after(()=>app.close());const admin=await client(app);await admin.claim();await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});
  for(let i=0;i<20;i++)assert.equal((await admin.claim('wrong')).status,403);
  const response=await fetch(app.config.origin+'/api/desktop/claim',{method:'POST',headers:{origin:app.config.origin,cookie:admin.cookie,'x-csrf-token':admin.csrf,'x-viewer-id':admin.viewer,'x-forwarded-for':'192.0.2.45','content-type':'application/json'},body:JSON.stringify({viewer:admin.viewer,lockPassword:'test-screen-password'})});assert.equal(response.status,429);
  const now=Date.now();t.mock.method(Date,'now',()=>now+60001);assert.equal((await admin.claim('test-screen-password')).status,200);
});
