import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardChannel } from '../panel/forward-channel.mjs';
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
  for(const mutate of [s=>{s.advertisedRwnd=1;},s=>{s.inboundStreams={a:{reassembly:Array(1024)}};},s=>{s.inboundStreams=Object.fromEntries(Array.from({length:32},(_,i)=>[i+1,{reassembly:[]} ]));},s=>{s.sackMisOrdered=new Set(Array.from({length:2048},(_,i)=>i));},s=>{s.sackDuplicates=Array(1024);}]){
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
