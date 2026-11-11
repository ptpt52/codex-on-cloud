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
