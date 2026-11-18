import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardChannel, DIRECT_CLOSE_MS } from '../panel/forward-channel.mjs';
import { createFlowBudget } from '../panel/flow-budget.mjs';
import { guardForwardSCTP, forwardNegotiationFailure } from '../panel/forward-rtc.mjs';

test('direct diagnostics distinguish UDP reachability, encrypted handshake and channel authorization', () => {
  assert.equal(forwardNegotiationFailure({ iceConnectionState: 'checking', dtlsTransports: [] }), 'rtc_ice_timeout');
  assert.equal(forwardNegotiationFailure({ iceConnectionState: 'completed', dtlsTransports: [{ state: 'connecting' }] }), 'rtc_dtls_timeout');
  assert.equal(forwardNegotiationFailure({ iceConnectionState: 'connected', dtlsTransports: [{ state: 'connected' }] }), 'rtc_auth_timeout');
});

function signal() { const handlers=new Set();return {subscribe(fn){handlers.add(fn);return{unSubscribe(){handlers.delete(fn);}};},emit(...args){for(const handler of [...handlers])handler(...args);},get size(){return handlers.size;}}; }
function channel(){return {readyState:'open',bufferedAmount:0,onMessage:signal(),stateChange:signal(),error:signal(),packets:[],send(value){this.packets.push(value);},close(){this.readyState='closed';this.stateChange.emit('closed');}};}
const ack=id=>JSON.stringify({type:'ack',id});

test('direct streams preserve bytes and FIN ordering while a four-record ACK window applies backpressure',async()=>{
  const wire=channel(),socket=forwardChannel(wire),payload=Buffer.from('\0中文\r\n\x1b[31m');let callbacks=0;
  for(let i=0;i<5;i++)socket.send(payload,()=>callbacks++);
  socket.send('{"type":"fin"}',()=>callbacks++);socket.close(1000);
  assert.equal(wire.packets.length,4);assert.equal(socket.readyState,2);await Promise.resolve();assert.equal(callbacks,4);
  wire.onMessage.emit(ack(1));assert.equal(wire.packets.length,5);
  wire.onMessage.emit(ack(2));assert.equal(wire.packets.length,6);assert.equal(wire.packets[5],'{"type":"fin"}');
  assert.deepEqual(wire.packets.slice(0,5),Array(5).fill(payload));assert.equal(wire.readyState,'open');
  wire.onMessage.emit(ack(6));assert.equal(wire.readyState,'closed');assert.equal(wire.onMessage.size,0);
  await Promise.resolve();assert.equal(callbacks,6);
});

test('a closing stream releases queued work and peer credit at its total deadline despite partial ACK progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createFlowBudget(), raw = channel(), otherRaw = channel(), results = [];
  const closing = forwardChannel(raw, { budget }), other = forwardChannel(otherRaw, { budget });
  let closes = 0; closing.on('close', () => closes++);
  try {
    for (let n = 0; n < 6; n++) closing.send(Buffer.alloc(1024), error => results.push(error ? 'closed' : 'sent'));
    closing.close(); closing.close();
    assert.equal(closing.readyState, 2); assert.equal(budget.used, 4096);
    t.mock.timers.tick(DIRECT_CLOSE_MS - 1); assert.equal(raw.readyState, 'open');
    raw.onMessage.emit(ack(1)); // Opens one slot but must not renew close time.
    assert.equal(raw.packets.length, 5); assert.equal(closing.readyState, 2);
    t.mock.timers.tick(1);
    assert.equal(closing.readyState, 3);
    assert.equal(budget.used, 0); assert.equal(closes, 1);
    other.send(Buffer.from('independent')); assert.equal(other.readyState, 1);
    assert.equal(otherRaw.packets[0].toString(), 'independent');
  } finally { closing.terminate(); other.terminate(); }
  await Promise.resolve(); assert.deepEqual(results, ['sent', 'sent', 'sent', 'sent', 'sent', 'closed']);
});

test('closing has an absolute ACK deadline and successful draining cancels its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createFlowBudget(), raw = channel(), socket = forwardChannel(raw, { budget });
  let closes = 0; socket.on('close', () => closes++);
  socket.send(Buffer.alloc(1024)); socket.close();
  t.mock.timers.tick(DIRECT_CLOSE_MS - 1); assert.equal(socket.readyState, 2);
  t.mock.timers.tick(1); assert.equal(socket.readyState, 3); assert.equal(budget.used, 0);
  assert.equal(raw.onMessage.size, 0); assert.equal(closes, 1);
  const timelyRaw = channel(), timely = forwardChannel(timelyRaw); let timelyCloses = 0;
  timely.on('close', () => timelyCloses++); timely.send('last'); timely.close();
  timelyRaw.onMessage.emit(ack(1)); assert.equal(timely.readyState, 3);
  t.mock.timers.tick(DIRECT_CLOSE_MS); assert.equal(timelyCloses, 1);
});

test('a paused target withholds ACK credit and cannot accumulate more than four incoming records',()=>{
  const wire=channel(),socket=forwardChannel(wire),received=[];socket.on('message',bytes=>{received.push(bytes.toString());socket.pause();});
  for(let i=0;i<4;i++)wire.onMessage.emit(Buffer.from(String(i)));
  assert.deepEqual(received,['0']);assert.equal(wire.packets.length,0);
  wire.onMessage.emit(Buffer.from('overflow'));assert.equal(wire.readyState,'closed');assert.deepEqual(received,['0']);
  const good=channel(),resumed=forwardChannel(good),parts=[];resumed.on('message',bytes=>{parts.push(bytes.toString());if(parts.length===1)resumed.pause();});
  for(let i=0;i<4;i++)good.onMessage.emit(Buffer.from(String(i)));resumed.resume();
  assert.deepEqual(parts,['0','1','2','3']);assert.equal(JSON.parse(good.packets.at(-1)).id,4);resumed.terminate();
});

test('forged, repeated and oversized direct records fail without releasing unacknowledged data',()=>{
  for(const value of [ack(0),ack(9),'{"type":"ack","id":1,"extra":true}',Buffer.alloc(16385)]){
    const wire=channel(),socket=forwardChannel(wire);socket.send(Buffer.from('one'));wire.onMessage.emit(value);assert.equal(wire.readyState,'closed');assert.equal(wire.packets.length,1);
  }
  const wire=channel(),socket=forwardChannel(wire);socket.send(Buffer.from('one'));wire.onMessage.emit(ack(1));wire.onMessage.emit(ack(1));assert.equal(wire.readyState,'closed');
});

test('SCTP fragment bytes, stream metadata and sparse packet tracking are bounded before reassembly',()=>{
  for(const mutate of [s=>{s.advertisedRwnd=1;},s=>{s.inboundStreams={a:{reassembly:Array(4096)}};},s=>{s.inboundStreams=Object.fromEntries(Array.from({length:32},(_,i)=>[i+1,{reassembly:[]} ]));},s=>{s.sackMisOrdered=new Set(Array.from({length:2048},(_,i)=>i));},s=>{s.sackDuplicates=Array(1024);}]){
    let receives=0,failures=0;const sctp={inboundStreams:{},advertisedRwnd:1024*1024,sackMisOrdered:new Set(),sackDuplicates:[],receiveDataChunk(){receives++;}};
    guardForwardSCTP(sctp,()=>true,()=>failures++);sctp.receiveDataChunk({streamId:0,userData:Buffer.alloc(2)});assert.equal(receives,1);
    mutate(sctp);sctp.receiveDataChunk({streamId:0,userData:Buffer.alloc(2)});assert.equal(receives,1);assert.equal(failures,1);
  }
});

test('a full sparse SCTP tracker withholds later DATA but admits the missing TSN and duplicate SACK feedback',()=>{
  for(const last of [100,0xffffffff]){
    let received=0,failed=0;
    const next=(last+1)>>>0,duplicate=(last+2)>>>0;
    const sctp={inboundStreams:{},advertisedRwnd:1024*1024,sackMisOrdered:new Set(Array.from({length:2048},(_,i)=>(last+i+2)>>>0)),sackDuplicates:[],lastReceivedTsn:last,receiveDataChunk(chunk){received++;if(chunk.tsn===next){this.lastReceivedTsn=(last+2049)>>>0;this.sackMisOrdered.clear();}}};
    guardForwardSCTP(sctp,()=>true,()=>failed++);
    sctp.receiveDataChunk({tsn:(last+2050)>>>0,streamId:0,userData:Buffer.from('later')});
    assert.equal(received,0);assert.equal(sctp.sackMisOrdered.size,2048);assert.equal(sctp.sackNeeded,true);assert.equal(sctp.sackImmediate,true);
    sctp.receiveDataChunk({tsn:duplicate,streamId:0,userData:Buffer.from('duplicate')});assert.equal(received,1);
    sctp.receiveDataChunk({tsn:next,streamId:0,userData:Buffer.from('repair')});assert.equal(received,2);assert.equal(sctp.sackMisOrdered.size,0);assert.equal(failed,0);
    sctp.receiveDataChunk({tsn:(last+2050)>>>0,streamId:0,userData:Buffer.from('retransmission')});assert.equal(received,3);
  }
});

test('SCTP admits small DATA fragments and repairs a gap while most of its byte window is free', () => {
  // Captured during a 16-chunk Chromium file upload: only ~170 KiB are
  // buffered, but a missing DATA packet holds 1024 small fragments behind it.
  const received = [], failures = [], last = 570478824;
  const stream = { reassembly: Array.from({ length: 1024 }, (_, i) => ({ tsn: last + i + 2 })) };
  const sctp = { inboundStreams: { 5: stream }, advertisedRwnd: 874296, lastReceivedTsn: last,
    sackMisOrdered: new Set(stream.reassembly.map(chunk => chunk.tsn)), sackDuplicates: [],
    receiveDataChunk(chunk) { received.push(chunk.tsn); if (chunk.tsn === last + 1) { stream.reassembly.length = 0; this.sackMisOrdered.clear(); } },
  };
  guardForwardSCTP(sctp, () => true, () => failures.push('closed'));
  sctp.receiveDataChunk({ tsn: last + 1026, streamId: 5, userData: Buffer.alloc(240) });
  sctp.receiveDataChunk({ tsn: last + 1, streamId: 5, userData: Buffer.alloc(240) });
  assert.deepEqual(failures, []);
  assert.deepEqual(received, [last + 1026, last + 1]);
  assert.equal(stream.reassembly.length, 0);
});
