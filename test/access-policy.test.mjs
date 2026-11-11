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
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

async function client(app,username='admin',password=app.config.password){
  const viewer=randomUUID();let cookie='',csrf='';
  const request=(path,body)=>fetch(app.config.origin+path,{method:body===undefined?'GET':'POST',headers:{origin:app.config.origin,cookie,'x-viewer-id':viewer,'x-csrf-token':csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const response=await request('/api/login',{username,password});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];const logged=await response.json();csrf=logged.csrf;
  return {viewer,cookie,csrf,logged,request,claim:lockPassword=>request('/api/desktop/claim',{viewer,...(lockPassword?{lockPassword}:{})})};
}
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function reverse(c){const agent=(await(await c.request('/api/forward/agents')).json()).agents[0];return c.request('/api/forward/agents/rule',{agentId:agent.id,name:'test device',enabled:true,config:{direction:'reverse',deviceName:'test device',protocol:'ssh',localPort:await freePort(),targetHost:'192.168.1.1',targetPort:22}});}

test('temporary users can only read explicitly shared helper keys and never gain helper management or device data', async t => {
  const app = await fixture(); t.after(() => app.close()); const admin = await client(app); await admin.claim();
  const agents = (await (await admin.request('/api/forward/agents')).json()).agents;
  await admin.request('/api/security/temporary-account', { enabled: true, username: 'visitor', password: 'test-guest-password' });
  const guest = await client(app, 'visitor', 'test-guest-password');
  assert.equal(guest.logged.access.canViewHelperKeys, false);
  assert.equal((await guest.request('/api/forward/agents/key?id=' + agents[1].id)).status, 403);
  for (const agent of [agents[1], agents[6]]) assert.equal((await admin.request('/api/forward/agents/visibility', { id: agent.id, revision: agent.visibilityRevision, visible: true })).status, 200);
  const metadata = await (await guest.request('/api/forward/agents')).json();
  assert.equal(metadata.readOnly, true); assert.deepEqual(metadata.agents.map(a => a.slot), [2, 7]);
  for (const a of metadata.agents) assert.deepEqual(Object.keys(a).sort(), ['id', 'keyRevision', 'name', 'slot']);
  const keyPath = '/api/forward/agents/key?id=' + agents[1].id;
  const first = await guest.request(keyPath); assert.equal(first.headers.get('cache-control'), 'no-store');
  const key = await first.json(); assert.deepEqual(await (await guest.request(keyPath)).json(), key, 'refresh reads the current key without rotating it');
  for (const agent of agents.filter(a => ![2, 7].includes(a.slot))) assert.equal((await guest.request('/api/forward/agents/key?id=' + agent.id)).status, 403);
  for (const path of ['visibility', 'rekey', 'rule', 'rule/remove', 'inventory']) assert.equal((await guest.request('/api/forward/agents/' + path, { id: agents[1].id, revision: 1, visible: true })).status, 403);
  assert.equal((await admin.request('/api/forward/agents/key?id=' + agents[1].id)).status, 200);
  const access = (await (await guest.request('/api/me')).json()).access; assert.equal(access.canViewHelperKeys, true); assert.equal(access.canManageHelpers, false); assert.equal(access.full, false);
  await admin.request('/api/security/screen-lock', { enabled: true, password: 'test-screen-password' });
  assert.equal((await guest.request(keyPath)).status, 200); assert.equal((await admin.request(keyPath)).status, 423);
  assert.equal((await admin.request('/api/forward/agents/visibility', { id: agents[1].id, revision: 2, visible: false })).status, 423);
  await admin.claim('test-screen-password');
  await admin.request('/api/forward/agents/visibility', { id: agents[1].id, revision: 2, visible: false });
  assert.equal((await guest.request(keyPath)).status, 403); assert.deepEqual((await (await guest.request('/api/forward/agents')).json()).agents.map(a => a.slot), [7]);
  await admin.request('/api/forward/agents/visibility', { id: agents[6].id, revision: 2, visible: false });
  assert.equal((await guest.request('/api/forward/agents')).status, 403);
  assert.equal((await (await guest.request('/api/me')).json()).access.canViewHelperKeys, false);
  await admin.request('/api/security/temporary-account', { enabled: false }); assert.equal((await guest.request(keyPath)).status, 401);
  assert.deepEqual(app.inputCalls, []); assert.equal(app.managementStats.restarts, 0);
});

test('shared helper keys still require a live temporary session at every read', async t => {
  const app = await fixture(); t.after(() => app.close()); const admin = await client(app); await admin.claim();
  const agent = (await (await admin.request('/api/forward/agents')).json()).agents[0];
  await admin.request('/api/forward/agents/visibility', { id: agent.id, revision: agent.visibilityRevision, visible: true });
  await admin.request('/api/security/temporary-account', { enabled: true, username: 'visitor', password: 'test-guest-password', durationMs: 300000 });
  const guest = await client(app, 'visitor', 'test-guest-password'), path = '/api/forward/agents/key?id=' + agent.id;
  assert.equal((await guest.request(path)).status, 200);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 300001);
  assert.equal((await guest.request(path)).status, 401); assert.equal((await guest.request('/api/forward/agents')).status, 401);
  assert.equal((await admin.request(path)).status, 200);
});
test('screen lock protects initial access and every takeover while status and files remain available and helper secrets stay protected',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const a=await client(app);assert.equal((await a.claim()).status,200);
  const original=await(await reverse(a)).json();
  assert.equal((await a.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'})).status,200);
  assert.equal((await a.request('/api/terminals')).status,423);assert.equal((await a.claim()).status,423);assert.equal((await a.claim('wrong')).status,403);
  assert.equal((await a.claim('test-screen-password')).status,200);assert.equal((await a.request('/api/terminals')).status,200);
  const b=await client(app);assert.equal(b.logged.access.requiresUnlock,true);assert.equal((await b.claim()).status,423);
  assert.equal((await(await a.request('/api/state')).json()).mine,true,'A login elsewhere must not implicitly steal the unlocked desktop');
  assert.equal((await b.claim('test-screen-password')).status,200);assert.equal((await a.claim()).status,423);assert.equal((await a.request('/api/terminals')).status,423);
  assert.equal((await a.request('/api/state')).status,200);assert.equal((await a.request('/api/diagnostics')).status,200);assert.equal((await a.request('/api/files')).status,200);
  assert.equal((await a.request('/api/forward/agents')).status,423);assert.equal((await a.request('/api/forward')).status,200);
  assert.equal((await a.request('/api/forward/agents/rule',{})).status,423);
  const state=await(await a.request('/api/state')).json();assert.equal(state.controls.input,undefined);assert.equal(state.access.full,false);
  assert.deepEqual(app.inputCalls,[]);assert.equal(app.managementStats.restarts,0);
});
test('temporary accounts cannot unlock, inspect terminals, manage other sessions or create forward maps, even with the screen password',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const admin=await client(app);await admin.claim();
  const original=await(await reverse(admin)).json();
  await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});await admin.claim('test-screen-password');
  assert.equal((await admin.request('/api/security/temporary-account',{enabled:true,username:'visitor',password:'test-guest-password',durationMs:3600000})).status,200);
  const guest=await client(app,'visitor','test-guest-password');assert.equal(guest.logged.username,'visitor');assert.equal(guest.logged.access.role,'temporary');
  for(const path of ['/api/terminals','/api/desktop/settings','/api/forward/agents','/api/security','/desktop/index.html','/terminal/index.html'])assert.equal((await guest.request(path)).status,403,path);
  assert.equal((await guest.claim('test-screen-password')).status,403);
  assert.equal((await guest.request('/api/forward/agents/rule',{})).status,403);
  const maps=await(await guest.request('/api/forward')).json();assert.equal(maps.managedHelpersProtocol,2);assert.equal(maps.agents,undefined);assert.equal(maps.mappings,undefined);
  const rejected=await new Promise(resolve=>{const ws=new WebSocket(app.config.origin.replace('http','ws')+'/desktop/websockify?viewer='+guest.viewer,{headers:{origin:app.config.origin,cookie:guest.cookie}});ws.on('error',()=>{});ws.on('unexpected-response',(_q,r)=>{r.resume();ws.terminate();resolve(r.statusCode);});ws.on('open',()=>{ws.terminate();resolve(101);});});assert.equal(rejected,403);
  const upload=await fetch(app.config.origin+'/api/files/test.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:guest.cookie,'x-csrf-token':guest.csrf,'content-type':'application/octet-stream'},body:'guest file'});assert.equal(upload.status,200);
  assert.equal(await(await fetch(app.config.origin+'/api/files/test.txt',{headers:{cookie:guest.cookie}})).text(),'guest file');
  assert.equal((await admin.request('/api/security/temporary-account',{enabled:false})).status,200);assert.equal((await guest.request('/api/me')).status,401);
  const remaining=await(await admin.request('/api/forward/agents')).json();assert.ok(remaining.agents[0].rules.some(r=>r.id===original.id));assert.equal(remaining.agents.length,8);
  assert.equal((await(await admin.request('/api/state')).json()).mine,true);assert.deepEqual(app.inputCalls,[]);
});

test('locked sessions reject all terminal and desktop APIs and retain CSRF checks on shared operations',async t=>{
  const app=await fixture();t.after(()=>app.close());const admin=await client(app);await admin.claim();
  await admin.request('/api/security/screen-lock',{enabled:true,password:'test-screen-password'});
  for(const path of ['/api/terminals','/api/desktop/settings','/api/forward/agents','/api/security'])assert.equal((await admin.request(path)).status,423,path);
  for(const path of ['/api/paste','/api/key','/api/terminal','/api/clipboard/read','/api/desktop/rtc','/api/terminal/rtc','/api/terminal/history','/api/desktop/settings','/api/desktop/resolution','/api/desktop/viewport','/api/forward/agents','/api/forward/agents/rule/remove','/api/security/screen-lock'])assert.equal((await admin.request(path,{})).status,423,path);
  const invalid=await fetch(app.config.origin+'/api/files/no.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:admin.cookie,'content-type':'application/octet-stream'},body:'no'});assert.equal(invalid.status,403);
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);
});

test('delayed helper-rule writes cannot commit after losing screen ownership',async t=>{
  const app=await fixture();t.after(()=>app.close());const admin=await client(app);await admin.claim();
  const agentId=(await(await admin.request('/api/forward/agents')).json()).agents[0].id;
  const body=JSON.stringify({agentId,name:'pending device',enabled:true,config:{protocol:'ssh',direction:'reverse',deviceName:'test',localPort:22001,targetHost:'192.168.1.1',targetPort:22}}),started=once(app.panel.server,'request');let pending;
  const response=new Promise((resolve,reject)=>{
    pending=http.request(app.config.origin+'/api/forward/agents/rule',{method:'POST',headers:{origin:app.config.origin,cookie:admin.cookie,'x-csrf-token':admin.csrf,'x-viewer-id':admin.viewer,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
    pending.on('error',reject);pending.write(body.slice(0,1));
  });t.after(()=>pending.destroy());await started;
  const other=await client(app);await other.claim();pending.end(body.slice(1));assert.equal(await response,409);
  assert.deepEqual((await(await other.request('/api/forward/agents')).json()).agents[0].rules,[]);
});

test('temporary expiry preserves administrator helper rules and uploads obey the shared directory bounds',async t=>{
  const app=await fixture({forwardPorts:'*'});t.after(()=>app.close());const admin=await client(app);await admin.claim();
  await admin.request('/api/security/temporary-account',{enabled:true,username:'visitor',password:'test-guest-password',durationMs:300000});const guest=await client(app,'visitor','test-guest-password');
  const original=await(await reverse(admin)).json();
  const upload=()=>fetch(app.config.origin+'/api/files/new.txt',{method:'PUT',headers:{origin:app.config.origin,cookie:guest.cookie,'x-csrf-token':guest.csrf,'content-type':'application/octet-stream'},body:'x'});
  app.files.set('large.bin',{length:1024*1024*1024});assert.equal((await upload()).status,413);app.files.clear();
  for(let i=0;i<1000;i++)app.files.set('f'+i,Buffer.alloc(0));assert.equal((await upload()).status,413);app.files.clear();
  const now=Date.now();t.mock.method(Date,'now',()=>now+300001);
  assert.equal((await guest.request('/api/me')).status,401);assert.equal((await admin.request('/api/me')).status,200);
  const maps=await(await admin.request('/api/forward/agents')).json();assert.ok(maps.agents[0].rules.some(r=>r.id===original.id));
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

test('a screen lock committed before a durability error still revokes an already-open desktop stream', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close()); const admin = await client(app); await admin.claim();
  const mapping = await (await reverse(admin)).json();
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + '/desktop/websockify?viewer=' + admin.viewer, { headers: { origin: app.config.origin, cookie: admin.cookie } });
  ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open');
  const echoed = once(ws, 'message'); ws.send('isolated VNC echo fixture'); assert.equal((await echoed)[0].toString(), 'isolated VNC echo fixture');
  let closed = false; ws.on('close', () => { closed = true; });
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', descriptor => { if (fs.fstatSync(descriptor).isDirectory()) throw Error('simulated directory fsync error after rename'); return fsync(descriptor); });
  syncBuiltinESMExports();
  try { assert.equal((await admin.request('/api/security/screen-lock', { enabled: true, password: 'test-screen-password' })).status, 502); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal((await (await admin.request('/api/state')).json()).access.requiresUnlock, true);
  for (let n = 0; n < 30 && !closed; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true, 'A committed lock must close the old stream even if the response reports a durability error');
  assert.equal((await admin.request('/api/forward/agents')).status,423);
  assert.equal((await admin.claim('test-screen-password')).status, 200); assert.ok((await(await admin.request('/api/forward/agents')).json()).agents[0].rules.some(r=>r.id===mapping.id)); assert.deepEqual(app.inputCalls, []);
});
