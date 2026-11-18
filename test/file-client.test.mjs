import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFileClient } from '../panel/public/file-client.js';
import { createFileWire,FILE_CHUNK,FILE_MAX } from '../panel/public/file-wire.js';

class Channel extends EventTarget {
 readyState='open';bufferedAmount=0;
 send(data){queueMicrotask(()=>{if(this.peer.readyState==='open')this.peer.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:data.slice().buffer}));});}
 close(){if(this.readyState==='closed')return;this.readyState='closed';this.dispatchEvent(new Event('close'));}
}
function receiver(t,window=16,premature=false){
 const a=new Channel(),b=new Channel();a.peer=b;b.peer=a;
 const chunks=[],controls=[],progress=[],failures=[];let size=0;
 const client=createFileClient(a,recoverable=>failures.push(recoverable),{window});
 const server=createFileWire(b,{failed(){},chunk(bytes){chunks.push(bytes.slice());},control(value){
  controls.push(value);
  if(value.type==='start'){size=value.size;server.setWindow(window);server.send({type:'ready',id:value.id,size,window});if(premature)server.send({type:'done',id:value.id,name:'result.bin',size});}
  if(value.type==='end')server.send({type:'done',id:value.id,name:'result.bin',size});
  if(value.type==='cancel')server.send({type:'cancelled',id:value.id});
 }});
 t.after(()=>{client.close();server.close();});
 return{client,chunks,controls,progress,failures,onProgress:n=>progress.push(n)};
}
for(const afterBlock of [false,true])for(const cause of ['slice','provider','short-read'])test(`a local ${cause} failure ${afterBlock?'after one block':'before data'} cancels exactly once and remains recoverable`,async t=>{
 const peer=receiver(t),block=16*FILE_CHUNK;let reads=0;
 const file={name:'result.bin',size:block+4,slice(start,end){reads++;
  if(afterBlock&&start===0)return{async arrayBuffer(){return new ArrayBuffer(end-start);}};
  if(cause==='slice')throw Error('synthetic File slice failure');
  return{async arrayBuffer(){if(cause==='provider')throw new DOMException('synthetic unavailable provider','NotReadableError');return new ArrayBuffer(end-start-1);}};
 }};
 await assert.rejects(peer.client.upload(file),{code:'file_read_failed',outcome:'unknown'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,afterBlock?2:1);assert.equal(peer.controls.filter(v=>v.type==='cancel').length,1);
 assert.equal(peer.controls.some(v=>v.type==='end'),false);assert.deepEqual(peer.failures,[true]);
 assert.equal(peer.chunks.length>0,afterBlock);
});
for(const window of [4,16])test(`slow File access is batched within 256 KiB while preserving all bytes and window ${window}`,async t=>{
 const peer=receiver(t,window),size=4479340,bytes=Buffer.alloc(size);for(let n=0;n<size;n++)bytes[n]=n%251;
 const reads=[];let activeReads=0,peakReads=0;
 const file={name:'result.bin',size,slice(start,end){reads.push([start,end]);return{async arrayBuffer(){
  activeReads++;peakReads=Math.max(peakReads,activeReads);await new Promise(resolve=>setTimeout(resolve,5));activeReads--;
  return Uint8Array.from(bytes.subarray(start,end)).buffer;
 }};}};
 await peer.client.upload(file,undefined,undefined,peer.onProgress);
 assert.equal(reads.length,18,'small protocol frames must not each trigger a File read');
 assert.equal(peakReads,1);assert.equal(reads[0][0],0);assert.equal(reads.at(-1)[1],size);
 for(let n=0;n<reads.length;n++){const[start,end]=reads[n];assert.ok(end>start&&end-start<=256*1024);if(n)assert.equal(start,reads[n-1][1]);}
 const received=Buffer.concat(peer.chunks);assert.equal(received.length,size);
 const hash=value=>createHash('sha256').update(value).digest('hex');assert.equal(hash(received),hash(bytes));
 assert.ok(peer.chunks.every(chunk=>chunk.length<=FILE_CHUNK));assert.equal(peer.progress[0],0);assert.equal(peer.progress.at(-1),size);
 assert.equal(peer.controls.filter(value=>value.type==='end').length,1);
});
for(const stallAfterFirst of [false,true])test(`canceling ${stallAfterFirst?'after one block':'before any bytes'} discards an in-flight File read and never reads ahead`,async t=>{
 const peer=receiver(t),controller=new AbortController();let release,entered,reads=0;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const file={name:'result.bin',size:1024*1024,slice(start,end){reads++;return{async arrayBuffer(){
  if(!stallAfterFirst||start>0){entered();await gate;}
  return new Uint8Array(end-start).buffer;
 }};}};
 const upload=peer.client.upload(file,undefined,controller.signal,peer.onProgress);void upload.catch(()=>{});
 try{
  await started;assert.equal(reads,stallAfterFirst?2:1);const before=Buffer.concat(peer.chunks).length;
  if(stallAfterFirst)assert.ok(before>0);else assert.equal(before,0);
  controller.abort(Error('cancel blocked read'));await assert.rejects(upload,/cancel blocked read/);
  // Drain the tail already sent before cancellation, then release the provider.
  await new Promise(resolve=>setImmediate(resolve));const drained=Buffer.concat(peer.chunks).length,reported=peer.progress.length;
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,stallAfterFirst?2:1);assert.equal(Buffer.concat(peer.chunks).length,drained);assert.equal(peer.progress.length,reported);
  assert.equal(peer.controls.some(value=>value.type==='end'),false);assert.equal(peer.controls.filter(value=>value.type==='cancel').length,1);
 }finally{release();}
});
test('empty uploads do not read and oversized uploads are rejected before starting',async t=>{
 const peer=receiver(t);let reads=0;
 const file={name:'result.bin',size:0,slice(){reads++;throw Error('unexpected read');}};
 await peer.client.upload(file);assert.equal(reads,0);assert.equal(peer.chunks.length,0);
 const count=peer.controls.length;await assert.rejects(peer.client.upload({...file,size:FILE_MAX+1}),/50 MiB/);
 assert.equal(peer.controls.length,count);assert.equal(reads,0);
});
test('a truncated File read cannot send an end marker or silently commit an incomplete upload',async t=>{
 const peer=receiver(t);
 await assert.rejects(peer.client.upload({name:'result.bin',size:100,slice(){return{async arrayBuffer(){return new ArrayBuffer(99);}};}}),error=>error.outcome==='unknown');
 assert.equal(peer.chunks.length,0);assert.equal(peer.controls.some(value=>value.type==='end'),false);
});
for(const size of [0,1])test(`an early completion cannot confirm a ${size}-byte upload before its end marker`,async t=>{
 const peer=receiver(t,16,true);
 await assert.rejects(peer.client.upload(new File([new Uint8Array(size)],'result.bin')),error=>error.outcome==='unknown');
 assert.equal(peer.controls.some(value=>value.type==='end'),false);
});
