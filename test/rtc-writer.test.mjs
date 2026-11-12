import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRTCWriter, RTC_WRITE_LIMITS } from '../panel/rtc-writer.mjs';
import { createFlowBudget } from '../panel/flow-budget.mjs';
import { forwardChannel } from '../panel/forward-channel.mjs';
import { sendControl, controlDecoder, CONTROL_LIMIT } from '../panel/public/control.js';
function signal() { const handlers = new Set(); return { subscribe(fn) { handlers.add(fn); return { unSubscribe() { handlers.delete(fn); } }; }, emit(value) { for (const fn of [...handlers]) fn(value); } }; }
function raw(name = '', packets = []) { return { readyState:'open', bufferedAmount:0, onMessage:signal(), stateChange:signal(), error:signal(), bufferedAmountLow:signal(), send(bytes) { packets.push({ name, bytes }); }, close() { this.readyState='closed'; this.stateChange.emit('closed'); } }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

test('expanded forwarding windows are negotiated bounds, preserve ACK validation, and return peer credit on close', async () => {
  const budget = createFlowBudget(32768), a = raw(), b = raw(), left = forwardChannel(a, { window:16, budget }), right = forwardChannel(b, { window:16, budget });
  let deliveredA = 0, deliveredB = 0;
  a.send = () => { deliveredA++; }; b.send = () => { deliveredB++; };
  for (let i=0;i<2;i++) left.send(Buffer.alloc(16384));
  right.send(Buffer.alloc(16384));
  for (let i=0;i<2;i++) left.send(Buffer.alloc(16384));
  assert.equal(deliveredA,2); assert.equal(deliveredB,0); assert.equal(budget.used,32768);
  a.onMessage.emit('{"type":"ack","id":1}'); await Promise.resolve();
  assert.equal(deliveredB,1,'older waiting stream gets freed credit before the bulk sender');
  assert.equal(deliveredA,2); assert.equal(budget.peak,32768);
  left.terminate(); assert.equal(budget.used,16384); right.terminate(); assert.equal(budget.used,0);
  for (const window of [8,16]) {
    const channel=raw(), socket=forwardChannel(channel,{window}); socket.pause();
    for(let i=0;i<window;i++) channel.onMessage.emit(Buffer.from('bounded'));
    assert.equal(socket.readyState,1); channel.onMessage.emit(Buffer.from('excess')); assert.equal(socket.readyState,3);
  }
  assert.throws(()=>forwardChannel(raw(),{window:17}),/window/);
});

test('RTC scheduler withholds TCP callbacks until actual admission and flushes final ACKs before a graceful close', async () => {
  const packets=[],a=raw('a',packets),writer=createRTCWriter({valid:()=>true}),socket=forwardChannel(writer.channel(a),{window:16});
  let completed=0;
  a.bufferedAmount=RTC_WRITE_LIMITS.native;
  socket.send(Buffer.from('payload'),()=>completed++);await turn();assert.equal(completed,0);
  a.bufferedAmount=0;a.bufferedAmountLow.emit();await turn();await Promise.resolve();assert.equal(completed,1);
  a.onMessage.emit(Buffer.from('remote')); // Queues an ACK in the writer.
  socket.close();a.onMessage.emit('{"type":"ack","id":1}');assert.equal(a.readyState,'open');
  await turn();assert.equal(a.readyState,'closed');assert.equal(packets.at(-1).bytes,'{"type":"ack","id":1}');writer.close();
});

test('a graceful RTC close waits for native buffered ACKs, while revocation closes immediately', () => {
  const writer=createRTCWriter({valid:()=>true}),a=raw(),channel=writer.channel(a);
  a.bufferedAmount=32;channel.closeAfterFlush();assert.equal(a.readyState,'open');
  a.bufferedAmount=0;a.bufferedAmountLow.emit();assert.equal(a.readyState,'closed');
  const b=raw(),revoked=writer.channel(b);b.bufferedAmount=32;revoked.close();assert.equal(b.readyState,'closed');writer.close();
});

test('RTC writer reserves control room and round-robins bulk streams without moving FIN ahead of data', async () => {
  let failures=0; const packets=[], a=raw('a',packets),b=raw('b',packets),h=raw('health',packets);
  const writer=createRTCWriter({valid:()=>true,failed:()=>failures++});
  const left=writer.channel(a),right=writer.channel(b),health=writer.channel(h,{control:true});
  try {
    a.bufferedAmount=RTC_WRITE_LIMITS.native;
    for(let i=0;i<3;i++){left.send(Buffer.alloc(16384,i));right.send(Buffer.alloc(16384,i));}
    health.send(Buffer.from('ping'));await turn();
    assert.deepEqual(packets.map(p=>p.name),['health']);
    a.bufferedAmount=0;a.bufferedAmountLow.emit();await turn();await turn();
    assert.deepEqual(packets.filter(p=>Buffer.isBuffer(p.bytes)&&p.bytes.length===16384).map(p=>p.name),['a','b','a','b','a','b']);
    left.send(Buffer.from('last'));left.send('{"type":"fin"}');await turn();
    const own=packets.filter(p=>p.name==='a');assert.equal(own.at(-2).bytes.toString(),'last');assert.equal(own.at(-1).bytes,'{"type":"fin"}');
    assert.equal(failures,0);
  } finally {writer.close();}
});

test('RTC ACK priority preserves increasing acknowledgements and revocation discards queued data', async () => {
  let allowed=true;const packets=[],a=raw('a',packets),writer=createRTCWriter({valid:()=>allowed});
  const channel=writer.channel(a);
  channel.send(Buffer.from('queued data'));channel.send('{"type":"ack","id":1}');channel.send('{"type":"ack","id":2}');await turn();
  assert.deepEqual(packets.slice(0,2).map(p=>p.bytes),['{"type":"ack","id":1}','{"type":"ack","id":2}']);
  channel.send(Buffer.from('revoked'));allowed=false;await turn();assert(!packets.some(p=>p.bytes.toString()==='revoked'));assert.equal(writer.bufferedAmount,0);writer.close();
});

test('priority admission preserves the existing 256 KiB service control response limit', async () => {
  const packets=[],a=raw('service',packets),writer=createRTCWriter({valid:()=>true}),channel=writer.channel(a,{control:true});
  const value={id:1,text:'x'.repeat(CONTROL_LIMIT-100)};let received;
  const decoder=controlDecoder(record=>{received=record;},()=>assert.fail('invalid service response'));
  sendControl(channel,value);
  for(let i=0;i<8&&writer.bufferedAmount;i++)await turn();
  for(const packet of packets)decoder.push(packet.bytes);
  assert.deepEqual(received,value);writer.close();
});
