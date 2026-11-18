// Opt-in file baseline: actual loopback ICE/DTLS, isolated HTTP/file upstream.
// ACK/provider delays are injected at the application boundary, not at IP/SCTP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';
import { createFileClient } from '../panel/public/file-client.js';
import { FILE_CHUNK } from '../panel/public/file-wire.js';

function setting(name,fallback,min,max) {
 const value=Number(process.env[name]??fallback);
 assert.ok(Number.isSafeInteger(value)&&value>=min&&value<=max,`${name} must be an integer between ${min} and ${max}`);return value;
}
const size=setting('FILE_BENCH_BYTES',4*1024*1024,65536,16*1024*1024),repeats=setting('FILE_BENCH_REPEATS',3,1,5);
const window=setting('FILE_BENCH_WINDOW',16,4,16),readDelayMs=setting('FILE_BENCH_READ_MS',0,0,250);
assert.ok([4,8,16].includes(window),'FILE_BENCH_WINDOW must be 4, 8 or 16');
const profiles=[{name:'loopback',ackDelayMs:0},{name:'ack-40ms',ackDelayMs:40},{name:'ack-150ms',ackDelayMs:150}];
const bytes=Buffer.alloc(size);for(let at=0;at<size;at++)bytes[at]=at%251;
const hash=value=>createHash('sha256').update(value).digest('hex'),expected=hash(bytes);
const percentile=(values,fraction)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];
const rounded=value=>Math.round(value*100)/100;
let app,client,files,ackDelayMs=0,peakPendingAcks=0,peakBufferedBytes=0;
const delayed=new Set(),subscriptions=[],controller=new AbortController();
const deadline=setTimeout(()=>{controller.abort(Error('file benchmark exceeded ten minutes'));files?.close();void client?.close();},600000);
try {
 app=await fixture({webrtc:true});
 client=await serviceClient(app,{username:app.config.username,password:app.config.password});
 const features=(await client.rpc('ping')).value;assert.equal(features.filesWindow,16);
 const channel=client.peer.createDataChannel('codex-files',{ordered:true,protocol:'files-v1'});
 const clean=()=>{for(const timer of delayed)clearTimeout(timer);delayed.clear();for(const item of subscriptions.splice(0))item.unSubscribe();};
 const adapter={get readyState(){return channel.readyState;},get bufferedAmount(){return channel.bufferedAmount;},
  send(value){channel.send(value);peakBufferedBytes=Math.max(peakBufferedBytes,channel.bufferedAmount);},close(){clean();channel.close();},
  addEventListener(type,fn){
   if(type==='message')subscriptions.push(channel.onMessage.subscribe(data=>{
    let ack=false;try{ack=typeof data==='string'&&JSON.parse(data).type==='ack';}catch{}
    if(!ack||!ackDelayMs){fn({data});return;}
    assert.ok(delayed.size<window,'injected ACK queue exceeded the negotiated window');
    const timer=setTimeout(()=>{delayed.delete(timer);fn({data});},ackDelayMs);delayed.add(timer);peakPendingAcks=Math.max(peakPendingAcks,delayed.size);
   }));
   else if(type==='close')subscriptions.push(channel.stateChange.subscribe(state=>{if(state==='closed'){fn();clean();}}));
   else if(type==='error')subscriptions.push(channel.error.subscribe(fn));
  }};
 files=createFileClient(adapter,()=>{},{window});
 const readyUntil=performance.now()+6000;while(!files.ready){assert.ok(performance.now()<readyUntil,'file DTLS channel did not open');await sleep(10);}
 for(const profile of profiles){
  const rates=[],latencies=[];
  for(let repeat=1;repeat<=repeats;repeat++){
   ackDelayMs=profile.ackDelayMs;peakPendingAcks=peakBufferedBytes=0;assert.equal(delayed.size,0);
   let sampling=true,metrics,reads=0,elapsed,used;
   const probes=[];
   const sampler=(async()=>{while(sampling){
    assert.ok(probes.length<1024,'interactive sample bound');const at=performance.now();assert.equal((await client.rpc('ping')).value.ready,true);
    probes.push(performance.now()-at);await sleep(50);
   }})();void sampler.catch(error=>controller.abort(error));
   const file=new File([bytes],'baseline.bin'),source={name:file.name,size:file.size,slice(start,end){return{async arrayBuffer(){reads++;if(readDelayMs)await sleep(readDelayMs);return file.slice(start,end).arrayBuffer();}};}};
   const cpu=process.cpuUsage(),start=performance.now();
   try{await files.upload(source,undefined,controller.signal,(_loaded,_total,value)=>{if(value)metrics=value;});elapsed=performance.now()-start;used=process.cpuUsage(cpu);}
   finally{sampling=false;await sampler;}
   const stored=app.files.get(file.name);
   assert.ok(stored);assert.equal(stored.length,size);assert.equal(hash(stored),expected);assert.equal(delayed.size,0);
   assert.equal(reads,Math.ceil(size/(16*FILE_CHUNK)));assert.equal(metrics.windowChunks,window);
   const rate=size/1048576/(elapsed/1000),p95=percentile(probes,.95);rates.push(rate);latencies.push(p95);
   console.log(JSON.stringify({kind:'sample',transport:'actual loopback DTLS; isolated file upstream',profile:profile.name,repeat,bytes:size,seconds:rounded(elapsed/1000),MiBps:rounded(rate),probeP95ms:rounded(p95),...metrics,
    injectedAckDelayMs:ackDelayMs,injectedReadDelayMs:readDelayMs,fileReads:reads,peakPendingAcks,observedBufferedBytes:peakBufferedBytes,nodeCPUPercent:rounded((used.user+used.system)/(elapsed*10))}));
   app.files.clear();
  }
  console.log(JSON.stringify({kind:'baseline',profile:profile.name,repeats,bytes:size,windowChunks:window,medianMiBps:rounded(percentile(rates,.5)),worstProbeP95ms:rounded(Math.max(...latencies))}));
 }
 assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);
}finally{
 clearTimeout(deadline);controller.abort();files?.close();await client?.close();await app?.close();for(const timer of delayed)clearTimeout(timer);
}
