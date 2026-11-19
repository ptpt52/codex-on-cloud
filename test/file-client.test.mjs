import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFileClient, FILE_READ_LIMITS } from '../panel/public/file-client.js';
import { createFileWire,sendFileChunks,FILE_CHUNK,FILE_MAX,FILE_DOWNLOAD_MAX } from '../panel/public/file-wire.js';

class Channel extends EventTarget {
 readyState='open';bufferedAmount=0;
 send(data){queueMicrotask(()=>{if(this.peer.readyState==='open')this.peer.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:data.slice().buffer}));});}
 close(){if(this.readyState==='closed')return;this.readyState='closed';this.dispatchEvent(new Event('close'));}
}

test('large downloads require an advertised limit and a streaming sink before any request is admitted', async t => {
 const a=new Channel(),b=new Channel();a.peer=b;b.peer=a;let starts=0;b.addEventListener('message',()=>starts++);
 const legacy=createFileClient(a);t.after(()=>legacy.close());
 const sink={write(){},close(){},abort(){}};
 await assert.rejects(legacy.downloadTo('large.bin',FILE_MAX+1,sink),{outcome:'rejected'});
 assert.equal(starts,0);assert.equal(legacy.maxDownload,FILE_MAX);
 const c=new Channel(),d=new Channel();c.peer=d;d.peer=c;d.addEventListener('message',()=>starts++);
 const modern=createFileClient(c,()=>{},{maxDownload:FILE_DOWNLOAD_MAX});t.after(()=>modern.close());
 await assert.rejects(modern.download('large.bin',FILE_MAX+1),{outcome:'rejected'});
 await assert.rejects(modern.downloadTo('too-large.bin',FILE_DOWNLOAD_MAX+1,sink),{outcome:'rejected'});
 await assert.rejects(modern.downloadTo('bad-sink.bin',FILE_MAX+1,{}),{outcome:'rejected'});
 assert.equal(starts,0);
});

test('a slow download sink applies receive-window backpressure and cancellation cannot close or finish its partial file', async t => {
 const a=new Channel(),b=new Channel();a.peer=b;b.peer=a;
 const client=createFileClient(a,()=>{},{window:16,maxDownload:FILE_DOWNLOAD_MAX});
 let writes=0,closed=0,aborted=0,release,entered;
 const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve),controller=new AbortController();
 const sink={async write(){writes++;entered();await held;},close(){closed++;},abort(){aborted++;release();}};
 let sending;
 const server=createFileWire(b,{failed(){},chunk(){},control(value){
  if(value.type==='start'){
   server.setWindow(16);server.send({type:'ready',id:value.id,size:value.size,window:16});
   async function* source(){for(let n=0;n<32;n++)yield new Uint8Array(FILE_CHUNK);}
   sending=sendFileChunks(source(),server);void sending.catch(()=>{});
  }
  if(value.type==='cancel')server.send({type:'cancelled',id:value.id});
 }});
 t.after(()=>{release();client.close();server.close();});
 const saving=client.downloadTo('large.bin',FILE_MAX+1,sink,controller.signal);void saving.catch(()=>{});
 await started;await new Promise(setImmediate);assert.equal(writes,1);assert.equal(closed,0);
 controller.abort(Error('user stopped save'));await assert.rejects(saving,/user stopped save/);await new Promise(setImmediate);
 assert.equal(aborted,1);assert.equal(closed,0);assert.equal(writes,1);server.close();await assert.rejects(sending);
});

test('canceled and closed file clients keep pending native reads charged across retries until settlement', async t => {
 const releases=[],controllers=[],peers=[];let reads=0;
 try{
  for(let n=0;n<FILE_READ_LIMITS.pending;n++){
   const peer=receiver(t),controller=new AbortController();peers.push(peer);controllers.push(controller);
   let entered;const started=new Promise(resolve=>entered=resolve);
   const file={name:'blocked.bin',size:4,slice(){return{arrayBuffer(){reads++;entered();return new Promise(resolve=>releases.push(()=>resolve(new ArrayBuffer(4))));}};}};
   const upload=peer.client.upload(file,undefined,controller.signal);void upload.catch(()=>{});await started;
   if(n%2)peer.client.close();else controller.abort(Error('cancel read'));
   await assert.rejects(upload);await new Promise(setImmediate);
  }
  const next=receiver(t);let invoked=false;
  await assert.rejects(next.client.upload({name:'new.bin',size:4,slice(){invoked=true;}}),{code:'file_read_busy',outcome:'rejected'});
  assert.equal(invoked,false);assert.equal(next.controls.length,0);assert.equal(reads,FILE_READ_LIMITS.pending);
  releases.shift()();await new Promise(setImmediate);
  await next.client.upload(new File(['fresh'],'fresh.bin'));
  assert.equal(Buffer.concat(next.chunks).toString(),'fresh');
  for(const peer of peers){assert.equal(peer.chunks.length,0);assert.equal(peer.controls.some(value=>value.type==='end'),false);}
 }finally{for(const controller of controllers)controller.abort();for(const release of releases)release();await new Promise(setImmediate);}
});

test('a blocked file provider hits its own read deadline and cancels without waiting five minutes', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const peer=receiver(t);let entered,release;
 const started=new Promise(resolve=>entered=resolve);
 const file={name:'blocked.bin',size:4,slice(){return{arrayBuffer(){entered();return new Promise(resolve=>release=()=>resolve(new ArrayBuffer(4)));}};}};
 const upload=peer.client.upload(file);void upload.catch(()=>{});
 try{
  await started;t.mock.timers.tick(FILE_READ_LIMITS.timeoutMs);
  await assert.rejects(upload,{code:'file_read_timeout',outcome:'unknown'});await new Promise(setImmediate);
  assert.equal(peer.controls.filter(value=>value.type==='cancel').length,1);assert.equal(peer.chunks.length,0);assert.deepEqual(peer.failures,[true]);
  release();await new Promise(setImmediate);assert.equal(peer.chunks.length,0);assert.equal(peer.controls.some(value=>value.type==='end'),false);
 }finally{release?.();}
});
for (const acknowledge of [false, true]) test(`a stalled upload retires its file channel after ${acknowledge ? 'confirmed' : 'missing'} cancellation without replay`, async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const a = new Channel(), b = new Channel(), controls = [], failed = []; a.peer = b; b.peer = a;
 b.addEventListener('message', ({ data }) => {
  if (typeof data !== 'string') return;
  const value = JSON.parse(data); controls.push(value);
  if (value.type === 'start') b.send(JSON.stringify({ type: 'ready', id: value.id, size: value.size }));
  if (value.type === 'cancel' && acknowledge) b.send(JSON.stringify({ type: 'cancelled', id: value.id }));
 });
 const client = createFileClient(a, value => failed.push(value)); t.after(() => client.close());
 const pending = client.upload(new File(['once'], 'stalled.bin')); void pending.catch(() => {});
 await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(15000);
 await assert.rejects(pending, { code: 'file_ack_timeout', outcome: 'unknown' });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(controls.filter(value => value.type === 'cancel').length, 1);
 assert.equal(controls.some(value => value.type === 'end'), false);
 if (!acknowledge) { assert.deepEqual(failed, []); t.mock.timers.tick(1500); }
 assert.deepEqual(failed, [true]); assert.equal(a.readyState, 'closed');
 assert.equal(controls.filter(value => value.type === 'start').length, 1);
});
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
