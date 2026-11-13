import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileWire,sendFileChunks,FILE_CHUNK } from '../panel/public/file-wire.js';
class Wire extends EventTarget{readyState='open';bufferedAmount=0;send(data){queueMicrotask(()=>{if(this.peer.readyState==='open')this.peer.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:data.slice().buffer}));});}close(){if(this.readyState==='closed')return;this.readyState='closed';this.dispatchEvent(new Event('close'));}}
test('file streaming waits for native buffers after application ACKs without exceeding its byte bound', async () => {
  const a = new Wire(), b = new Wire(); a.peer = b; b.peer = a;
  let peak = 0, drains = 0, received = 0, sent = 0;
  const original = a.send.bind(a);
  a.send = data => { if (typeof data !== 'string') { a.bufferedAmount += data.length; peak = Math.max(peak, a.bufferedAmount); sent++; } original(data); };
  const sender = createFileWire(a, { control() {}, chunk() {}, failed() {} });
  const receiver = createFileWire(b, { control() {}, chunk(bytes) { received += bytes.length; }, failed() {} });
  sender.setWindow(16); receiver.setWindow(16);
  const timer = setInterval(() => { if (a.bufferedAmount > 256 * 1024) { a.bufferedAmount = 0; drains++; a.dispatchEvent(new Event('bufferedamountlow')); } }, 5);
  try {
    const size = 1024 * 1024;
    await sendFileChunks((async function* () { yield new Uint8Array(size); })(), sender);
    assert.equal(received, size); assert.equal(sent, Math.ceil(size / FILE_CHUNK));
    assert.ok(drains > 0); assert.ok(peak <= 512 * 1024 - 4096);
    sender.send({ type: 'end', id: 1 });
  } finally { clearInterval(timer); sender.close(); receiver.close(); }
});
test('closing or revoking a transfer during native buffer wait sends no file bytes', async () => {
  for (const disconnect of [true, false]) {
    const a = new Wire(), b = new Wire(); a.peer = b; b.peer = a; a.bufferedAmount = 512 * 1024;
    let received = 0, valid = true;
    const sender = createFileWire(a, { control() {}, chunk() {}, failed() {} });
    const receiver = createFileWire(b, { control() {}, chunk(bytes) { received += bytes.length; }, failed() {} });
    const pending = sendFileChunks((async function* () { yield new Uint8Array(123); })(), sender, () => valid);
    try {
      await new Promise(resolve => setImmediate(resolve));
      valid = false;
      if (disconnect) sender.close(); else { a.bufferedAmount = 0; a.dispatchEvent(new Event('bufferedamountlow')); }
      await assert.rejects(pending); assert.equal(received, 0);
    } finally { sender.close(); receiver.close(); }
  }
});
test('upload byte progress advances only after the receiver acknowledges its chunks', async () => {
  const a = new Wire(), b = new Wire(); a.peer = b; b.peer = a; let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { entered = resolve; }), progress = [];
  const sender = createFileWire(a, { control() {}, chunk() {}, failed() {} });
  const receiver = createFileWire(b, { control() {}, async chunk() { entered(); await hold; }, failed() {} });
  const source = async function* () { yield new Uint8Array(123); };
  const pending = sendFileChunks(source(), sender, () => true, bytes => progress.push(bytes));
  try { await received; assert.deepEqual(progress, []); release(); await pending; assert.deepEqual(progress, [123]); }
  finally { release(); sender.close(); receiver.close(); }
});
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

for(const window of [8,16])test(`file wire admits exactly ${window} negotiated chunks and refuses window changes in flight`,async()=>{
 const a=new Wire(),b=new Wire();a.peer=b;b.peer=a;let release,failed=0,received=0;
 const gate=new Promise(resolve=>release=resolve);
 const left=createFileWire(a,{control(){},chunk(){},failed(){failed++;}}),right=createFileWire(b,{control(){},async chunk(){await gate;received++;},failed(){failed++;}});
 left.setWindow(window);right.setWindow(window);
 const pending=Array.from({length:window},()=>left.data(new Uint8Array(64)));
 for(const p of pending)void p.catch(()=>{});
 assert.throws(()=>left.setWindow(4),/协商/);
 await assert.rejects(left.data(new Uint8Array(1)),/窗口/);
 release();await Promise.all(pending);assert.equal(received,window);assert.equal(failed,0);
 const next=left.data(new Uint8Array(1));await next;assert.equal(received,window+1);
 left.close();right.close();
});
