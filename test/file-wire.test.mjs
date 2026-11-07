import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileWire,FILE_CHUNK } from '../panel/public/file-wire.js';
class Wire extends EventTarget{readyState='open';bufferedAmount=0;send(data){queueMicrotask(()=>{if(this.peer.readyState==='open')this.peer.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:data.slice().buffer}));});}close(){if(this.readyState==='closed')return;this.readyState='closed';this.dispatchEvent(new Event('close'));}}
test('file wire limits in-flight chunks and rejects forged ACKs without freeing a window',async()=>{
 const a=new Wire(),b=new Wire();a.peer=b;b.peer=a;let failed=0;
 const wire=createFileWire(a,{control(){},chunk(){},failed(){failed++;}});
 const sent=Array.from({length:4},()=>wire.data(new Uint8Array(FILE_CHUNK)));for(const p of sent)void p.catch(()=>{});
 await assert.rejects(wire.data(new Uint8Array(1)),/窗口/);
 b.send(JSON.stringify({type:'ack',seq:999}));const results=await Promise.allSettled(sent);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(failed,1);
});
test('file wire rejects repeated binary sequence numbers and oversized metadata',async()=>{
 for(const oversized of [false,true]){
  const a=new Wire(),b=new Wire();a.peer=b;b.peer=a;let failed=0,chunks=0;
  createFileWire(a,{control(){},chunk(){chunks++;},failed(){failed++;}});
  if(oversized)b.send('x'.repeat(4097));else{const bytes=new Uint8Array(5);new DataView(bytes.buffer).setUint32(0,1);b.send(bytes);b.send(bytes);}
  await new Promise(r=>setTimeout(r,10));assert.equal(failed,1);assert.ok(chunks<=1);
 }
});
