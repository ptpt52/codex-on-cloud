import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';

test('terminal-only capabilities preserve auth, ownership and CSRF while refusing desktop actions and resources', async t => {
  const app=await fixture({mode:'terminal'});t.after(()=>app.close());
  assert.equal((await app.request('/api/desktop/settings')).status,401);
  assert.equal((await app.request('/desktop/index.html')).status,401);
  await app.login();assert.equal((await(await app.request('/api/me')).json()).mode,'terminal');await app.claim();
  for(const path of ['/api/desktop/viewport','/api/desktop/resolution','/api/desktop/apply','/api/desktop/rtc','/api/paste','/api/edit','/api/key','/api/clipboard/read']){
    assert.equal((await app.request(path,{method:'POST',body:{},headers:{'x-csrf-token':''}})).status,403);
    assert.equal((await app.request(path,{method:'POST',body:{}})).status,501);
  }
  for(const path of ['/desktop/index.html','/desktop/viewer.js','/desktop/novnc/core/rfb.js','/api/desktop/settings'])assert.equal((await app.request(path)).status,501);
  for(const path of ['/terminal/index.html','/terminal/xterm.js','/desktop/stream-client.js','/api/terminals','/api/forward'])assert.equal((await app.request(path)).status,200);
  const forwarding=await(await app.request('/api/forward')).json();assert.equal(forwarding.managedHelpersProtocol,2);assert.equal((await(await app.request('/api/forward/agents')).json()).agents.length,8);
  const status=await new Promise(resolve=>{
    const ws=new WebSocket(app.config.origin.replace('http','ws')+'/desktop/websockify?viewer='+app.viewer,{headers:{origin:app.config.origin,cookie:app.cookie}});
    ws.on('error',()=>{});ws.on('unexpected-response',(_request,response)=>{response.resume();ws.terminate();resolve(response.statusCode);});
    ws.on('open',()=>{ws.terminate();resolve(101);});
  });
  assert.equal(status,501);assert.deepEqual(app.inputCalls,[]);assert.equal(app.managementStats.restarts,0);
});
