import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import net from 'node:net';
import { createForwarding } from '../panel/forward.mjs';
import { fixture } from './fixture.mjs';
const hints = { server: '10.10.0.1', browser: '192.168.10.2' };
const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\na=candidate:1 1 udp 2130706431 127.0.0.1 40048 typ host\r\n';
async function until(fn) { for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('deadline'); }
test('mapping hint updates preserve grants and targets, are bounded, validated and permission checked', async t => {
 const forwarding=createForwarding({forwardPorts:'*'});t.after(()=>forwarding.close());
 const grant=forwarding.create({localPort:2222,targetPort:22,hints},'owner',()=> '');
 hints.server='10.10.0.9';assert.equal(forwarding.list().mappings[0].hints.server,'10.10.0.1');hints.server='10.10.0.1';
 assert.throws(()=>forwarding.updateHints({id:grant.id,hints},()=>false),{status:403});
 assert.throws(()=>forwarding.updateHints({id:grant.id,hints:{browser:'8.8.8.8'}},()=>true),{status:400});
 forwarding.updateHints({id:grant.id,hints:{server:'10.0.0.2'}},()=>true);
 const item=forwarding.list().mappings[0];assert.equal(item.state,'pending');assert.equal(item.targetPort,22);assert.deepEqual(item.hints,{server:'10.0.0.2',browser:''});
});
test('temporary mapping helpers negotiate with inherited addresses, retain automatic candidates and receive explicit updates', async t => {
 let receivedOffer; const app=await fixture({webrtc:true,forwardPorts:'*',forwardPeerFactory:opts=>({state:{id:opts.id},streams:0,async answer(offer){receivedOffer=offer;return sdp;},async destroy(){opts.closed();}})});t.after(()=>app.close());
 await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'guest-test-password',durationMs:3600000}});
 const login=await fetch(app.config.origin+'/api/login',{method:'POST',headers:{origin:app.config.origin,'content-type':'application/json'},body:JSON.stringify({username:'visitor',password:'guest-test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const post=(path,body)=>fetch(app.config.origin+path,{method:'POST',headers:{origin:app.config.origin,cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(body)});
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const grant=await(await post('/api/forward',{localPort:port,targetHost:'192.168.1.1',targetPort:22,direction:'reverse',deviceName:'router',hints})).json();
 const records=[];const ws=new WebSocket(app.config.origin.replace('http','ws')+'/forward/helper','codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+grant.code,'x-codex-forward-reverse':'1'}});t.after(()=>ws.terminate());ws.on('message',b=>records.push(JSON.parse(b)));await once(ws,'open');await until(()=>records.length);
 ws.send('{"type":"listening","direct":1}');await until(()=>records.some(r=>r.type==='rtc_config'));assert.deepEqual(records.find(r=>r.type==='rtc_config').hints,hints);
 ws.send(JSON.stringify({type:'rtc_offer',id:1,sdp}));await until(()=>records.some(r=>r.type==='rtc_answer'));
 assert.ok(receivedOffer.sdp.includes(' 192.168.10.2 40048 '));assert.ok(receivedOffer.sdp.includes(' 127.0.0.1 40048 '));assert.ok(records.find(r=>r.type==='rtc_answer').sdp.includes(' 10.10.0.1 40048 '));
 assert.equal((await post('/api/forward/hints',{id:grant.id,hints:{browser:'10.1.1.2'}})).status,200);await until(()=>records.filter(r=>r.type==='rtc_config').length===2);assert.equal(ws.readyState,1);
 assert.equal((await post('/api/forward',{localPort:2222,targetPort:22,hints})).status,403);
 assert.deepEqual(app.inputCalls,[]);
});
