import test from 'node:test';
import { mkdir,mkdtemp,rm,writeFile,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';
import { createFileClient } from '../panel/public/file-client.js';
import { FILE_CHUNK,FILE_MAX } from '../panel/public/file-wire.js';
import { attachServiceFiles } from '../panel/service-files.mjs';
import { FORWARD_FILES } from '../panel/forward-downloads.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const direction of ['upload','download'])for(const errorFails of [false,true])test(`failed ${direction} completion settles unknown without replay (${errorFails?'unwritable error record':'recoverable error record'})`,async t=>{
 let requests=0,completed=0;
 const upstream=http.createServer((req,res)=>{
  requests++;req.resume();req.once('end',()=>{
   completed++;
   if(direction==='upload'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true,"name":"completed.bin"}');}
   else{res.writeHead(200,{'content-length':4});res.end('safe');}
  });
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
 const signal=()=>{const handlers=new Set();return{subscribe(fn){handlers.add(fn);return{unSubscribe(){handlers.delete(fn);}};},emit(value){for(const fn of [...handlers])fn(value);},get size(){return handlers.size;}};};
 const native={readyState:'open',bufferedAmount:0,onMessage:signal(),stateChange:signal(),error:signal()},browser=Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0});
 let completionAttempts=0,errorAttempts=0,closes=0;
 const close=()=>{if(native.readyState==='closed')return;closes++;native.readyState=browser.readyState='closed';native.stateChange.emit('closed');browser.dispatchEvent(new Event('close'));};
 native.close=browser.close=close;
 native.send=data=>{
  const value=typeof data==='string'?JSON.parse(data):null;
  if(value?.type==='done'){completionAttempts++;throw Error('isolated completion send failure');}
  if(value?.type==='error'){errorAttempts++;if(errorFails)throw Error('isolated error send failure');}
  queueMicrotask(()=>browser.dispatchEvent(Object.assign(new Event('message'),{data})));
 };
 browser.send=data=>queueMicrotask(()=>native.onMessage.emit(typeof data==='string'?data:Buffer.from(data)));
 const controller=new AbortController(),serverFailures=[],clientFailures=[];
 const server=attachServiceFiles(native,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail:value=>serverFailures.push(value)});
 const client=createFileClient(browser,value=>clientFailures.push(value));
 t.after(()=>{server.close();client.close();controller.abort();});
 const transfer=direction==='upload'?client.upload(new File(['safe'],'completed.bin')):client.download('completed.bin',4);
 let timer;
 try{
  await assert.rejects(Promise.race([transfer,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('completion remained pending')),3000);})]),error=>error.outcome==='unknown'&&(errorFails||error.status===502));
 }finally{clearTimeout(timer);}
 assert.equal(client.busy,false);assert.equal(client.ready,false);
 assert.equal(completed,1);assert.equal(requests,1,'a committed or unknown transfer is never resubmitted');
 assert.equal(completionAttempts,1);assert.equal(errorAttempts,1);assert.equal(closes,1);
 assert.deepEqual(serverFailures,[true]);assert.deepEqual(clientFailures,[!errorFails]);
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
 assert.equal(native.onMessage.size+native.stateChange.size+native.error.size,0);
});
test('download ACK timeout sends a recoverable unknown outcome and releases only the file channel within three seconds', async t => {
 const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': 4 }); res.end('safe'); });
 upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
 t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const signal = () => { const handlers = new Set(); return { subscribe(fn) { handlers.add(fn); return { unSubscribe: () => handlers.delete(fn) }; }, emit(value) { for (const fn of [...handlers]) fn(value); } }; };
 const sent = [], failed = [], controller = new AbortController(); let dataSent;
 const data = new Promise(resolve => { dataSent = resolve; });
 const channel = { readyState: 'open', bufferedAmount: 0, onMessage: signal(), stateChange: signal(), error: signal(),
  send(bytes) { sent.push(typeof bytes === 'string' ? JSON.parse(bytes) : bytes); if (typeof bytes !== 'string') dataSent(); },
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.stateChange.emit('closed'); } };
 const files = attachServiceFiles(channel, { valid: () => true, headers: {}, port: () => upstream.address().port, signal: controller.signal, fail: value => failed.push(value) }); t.after(() => files.close());
 channel.onMessage.emit('{"type":"start","id":1,"direction":"download","name":"held","size":4}'); await data;
 t.mock.timers.tick(15000); await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(sent.find(value => value.type === 'error'), { type: 'error', id: 1, status: 408, outcome: 'unknown', message: '文件分块确认超时', code: 'file_ack_timeout', recoverable: true });
 assert.deepEqual(failed, []); assert.equal(channel.readyState, 'open');
 // A late ordered ACK is drained without reopening data admission.
 channel.onMessage.emit('{"type":"ack","seq":1}'); t.mock.timers.tick(3000);
 assert.deepEqual(failed, [true]); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('file HTTP outcomes survive both RTC directions independently of channel recovery',async t=>{
 for(const direction of ['upload','download'])for(const sample of [
  {status:503,outcome:'rejected',expected:'rejected',recoverable:true},
  {status:503,outcome:'unknown',expected:'unknown',recoverable:true},
  {status:503,expected:'unknown',recoverable:true},
  {status:409,outcome:'unknown',expected:'unknown',recoverable:true},
  {status:409,expected:'rejected',recoverable:true},
  {status:500,outcome:'rejected',expected:'rejected',recoverable:true},
  {status:408,expected:'unknown',recoverable:true},
  {status:502,expected:'unknown',recoverable:true},
  {status:504,expected:'unknown',recoverable:true},
  {status:401,expected:'unknown',recoverable:false},
  {status:403,expected:'unknown',recoverable:false},
  {status:423,expected:'unknown',recoverable:false},
 ])await t.test(`${direction} HTTP ${sample.status}, outcome ${sample.outcome||'legacy'}`,async t=>{
  let requests=0,recoverable,frame;
  const upstream=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(sample.status,{'content-type':'application/json'});res.end(JSON.stringify({error:'isolated failure',...(sample.outcome?{outcome:sample.outcome}:{})}));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
  const signal=()=>{const handlers=new Set();return{subscribe(fn){handlers.add(fn);return{unSubscribe(){handlers.delete(fn);}};},emit(value){for(const fn of [...handlers])fn(value);}};};
  const native={readyState:'open',bufferedAmount:0,onMessage:signal(),stateChange:signal(),error:signal()},browser=Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0});
  const close=()=>{if(native.readyState==='closed')return;native.readyState=browser.readyState='closed';native.stateChange.emit('closed');browser.dispatchEvent(new Event('close'));};
  native.close=browser.close=close;
  native.send=data=>{if(typeof data==='string'&&JSON.parse(data).type==='error')frame=JSON.parse(data);queueMicrotask(()=>browser.dispatchEvent(Object.assign(new Event('message'),{data})));};
  browser.send=data=>queueMicrotask(()=>native.onMessage.emit(typeof data==='string'?data:Buffer.from(data)));
  const controller=new AbortController(),server=attachServiceFiles(native,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail(){}});
  t.after(()=>{server.close();controller.abort();});
  const client=createFileClient(browser,value=>{recoverable=value;});
  const pending=direction==='upload'?client.upload(new File(['x'],'isolated.bin')):client.download('isolated.bin',1);
  await assert.rejects(pending,error=>error.status===sample.status&&error.outcome===sample.expected);
  assert.equal(frame.outcome,sample.expected);assert.equal(recoverable,sample.recoverable);assert.equal(requests,1,'a rejected or unknown file is never replayed');
 });
});
test('a file deadline retires only its channel and keeps its outcome unknown',async t=>{
 let entered;const started=new Promise(resolve=>{entered=resolve;});
 const upstream=http.createServer(req=>{req.on('error',()=>{});entered();});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
 t.mock.timers.enable({apis:['setTimeout']});
 const signal=()=>{const handlers=new Set();return{subscribe(fn){handlers.add(fn);return{unSubscribe:()=>handlers.delete(fn)};},emit(value){for(const fn of [...handlers])fn(value);}};};
 const sent=[],failed=[],controller=new AbortController(),channel={readyState:'open',bufferedAmount:0,onMessage:signal(),stateChange:signal(),error:signal(),send:bytes=>sent.push(JSON.parse(bytes)),close(){if(this.readyState==='closed')return;this.readyState='closed';this.stateChange.emit('closed');}};
 const files=attachServiceFiles(channel,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail:value=>failed.push(value)});t.after(()=>files.close());
 channel.onMessage.emit('{"type":"start","id":1,"direction":"download","name":"held","size":4}');await started;
 t.mock.timers.tick(300000);
 assert.deepEqual(sent.find(value=>value.type==='error'),{type:'error',id:1,status:408,outcome:'unknown',message:'文件传输超过五分钟',recoverable:true});
 assert.deepEqual(failed,[]);t.mock.timers.tick(3000);assert.deepEqual(failed,[true]);
});
test('recoverable file channel closures release abort and native subscriptions before replacement',async t=>{
 const upstream=http.createServer((_req,res)=>{res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"missing"}');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
 const signal=()=>{const handlers=new Set();return{subscribe(fn){handlers.add(fn);return{unSubscribe(){handlers.delete(fn);}};},emit(value){for(const fn of [...handlers])fn(value);},get size(){return handlers.size;}};};
 const controller=new AbortController(),handles=[],failures=[];let closes=0;
 t.after(()=>{for(const handle of handles)handle.close();controller.abort();});
 for(let n=0;n<24;n++){
  const message=signal(),state=signal(),error=signal(),sent=[];
  const channel={readyState:'open',bufferedAmount:0,onMessage:message,stateChange:state,error,send:bytes=>sent.push(JSON.parse(bytes)),close(){if(this.readyState==='closed')return;this.readyState='closed';closes++;state.emit('closed');}};
  const files=attachServiceFiles(channel,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail:value=>failures.push(value)});handles.push(files);
  assert.equal(getEventListeners(controller.signal,'abort').length,1);
  message.emit(JSON.stringify({type:'start',id:1,direction:n%2?'upload':'download',name:'missing',size:1}));
  if(n%2)message.emit('{"type":"cancel","id":1}');
  else{for(let i=0;i<200&&!sent.some(value=>value.type==='error');i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(sent.some(value=>value.recoverable===true),true);}
  channel.close();files.close();
  assert.equal(getEventListeners(controller.signal,'abort').length,0,'retired file channels cannot accumulate on the live service signal');
  assert.equal(message.size+state.size+error.size,0,'native channel subscriptions are released on every close path');
 }
 controller.abort();assert.equal(closes,24);assert.deepEqual(failures,Array(24).fill(true));
});
test('an early HTTP rejection drains already-sent file frames until the rejection can reach the browser',async t=>{
 const upstream=http.createServer((_req,res)=>{res.writeHead(412,{'content-type':'application/json'});res.end('{"error":"原文件已变化"}');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
 const callbacks={},sent=[],failed=[];let closed=0;
 const channel={readyState:'open',bufferedAmount:0,send:bytes=>sent.push(bytes),close(){closed++;},onMessage:{subscribe:fn=>{callbacks.message=fn;}},stateChange:{subscribe:fn=>{callbacks.state=fn;}},error:{subscribe:fn=>{callbacks.error=fn;}}};
 const controller=new AbortController(),files=attachServiceFiles(channel,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail:recoverable=>failed.push(recoverable)});t.after(()=>files.close());
 callbacks.message(JSON.stringify({type:'start',id:1,direction:'upload',name:'conflict.txt',size:1}));
 for(let n=0;n<100&&!sent.some(value=>typeof value==='string'&&JSON.parse(value).type==='error');n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(sent.some(value=>typeof value==='string'&&JSON.parse(value).recoverable===true),true);
 // The browser sent these after receiving ready and before seeing the HTTP rejection.
 const frame=Buffer.alloc(5);frame.writeUInt32BE(1);frame[4]=42;callbacks.message(frame);callbacks.message(JSON.stringify({type:'end',id:1}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,0);assert.deepEqual(failed,[]);
 files.close();assert.deepEqual(failed,[true]);
});
async function setup(t,options={}){const app=await fixture({webrtc:true,...options});t.after(()=>app.close());await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});const c=await serviceClient(app);t.after(()=>c.close());return {app,c};}
async function fileClient(c,window=4,failed=()=>{}){const channel=c.peer.createDataChannel('codex-files',{ordered:true,protocol:'files-v1'});const adapter={get readyState(){return channel.readyState;},get bufferedAmount(){return channel.bufferedAmount;},send:x=>channel.send(x),close:()=>channel.close(),addEventListener(type,fn){if(type==='message')channel.onMessage.subscribe(data=>fn({data}));else if(type==='close')channel.stateChange.subscribe(s=>{if(s==='closed')fn();});else if(type==='error')channel.error.subscribe(fn);}};const client=createFileClient(adapter,failed,{window});for(let i=0;i<200&&!client.ready;i++)await new Promise(r=>setTimeout(r,10));assert.equal(client.ready,true);return client;}
test('the real HTTP busy gate rejects a DTLS upload without retiring either service or replaying the file',async t=>{
 const {app,c}=await setup(t),other=await serviceClient(app);t.after(()=>other.close());
 const first=await fileClient(c,16),recovered=[],second=await fileClient(other,16,value=>recovered.push(value));
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const uploading=first.upload({name:'held.bin',size:32*FILE_CHUNK,slice(offset,end){return{async arrayBuffer(){if(offset){entered();await gate;}return new Uint8Array(end-offset).buffer;}};}});void uploading.catch(()=>{});
 try{
  await started;
  await assert.rejects(second.upload(new File(['manual'],'busy.bin')),error=>error.status===503&&error.outcome==='rejected');
  assert.deepEqual(recovered,[true]);assert.equal((await other.rpc('ping')).ok,true);assert.equal((await c.rpc('ping')).ok,true);
  assert.equal(app.received.filter(value=>value.method==='PUT'&&value.url==='/files/busy.bin').length,0);
  release();await uploading;
  const replacement=await fileClient(other,16);await replacement.upload(new File(['manual'],'busy.bin'));
  assert.equal(app.files.get('busy.bin').toString(),'manual');assert.equal(app.received.filter(value=>value.method==='PUT'&&value.url==='/files/busy.bin').length,1);assert.deepEqual(app.inputCalls,[]);
 }finally{release();}
});
test('a temporary service peer downloads the published helper rather than a same-named shared file, and stale versions preserve service authorization',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'codex-helper-direct-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const arch='windows-amd64',name=FORWARD_FILES[arch],bytes=Buffer.alloc(1024*1024,137);
 await writeFile(join(directory,name),bytes);await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,files:[{arch,name,size:bytes.length,sha256:hash(bytes),build:'direct-test'}]}));
 const {app,c}=await setup(t,{forwardDownloadDir:directory});app.files.set(name,Buffer.from('shared directory must not supply helper bytes'));
 assert.equal((await c.rpc('ping')).value.helperDownloadsProtocol,1);
 const files=await fileClient(c),progress=[];const blob=await files.downloadHelper({arch},bytes.length,undefined,received=>progress.push(received));
 assert.equal(hash(Buffer.from(await blob.arrayBuffer())),hash(bytes));assert.equal(progress.at(-1),bytes.length);
 assert.equal(app.received.some(req=>req.url==='/files/'+name),false);assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
 await assert.rejects(files.downloadHelper({arch,generation:'f'.repeat(32)},bytes.length),error=>error.status===410);
 assert.equal((await c.rpc('ping')).ok,true);
 const replacement=await fileClient(c);assert.equal((await replacement.downloadHelper({arch},bytes.length)).size,bytes.length);
});

test('helper source records cannot select arbitrary paths, URLs, methods or oversized artifacts',async t=>{
 let requests=0;const upstream=http.createServer((_req,res)=>{requests++;res.end('unexpected');});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
 const original={type:'start',id:1,direction:'download',name:FORWARD_FILES['windows-amd64'],size:1,helper:{arch:'windows-amd64'}};
 const invalid=[{helper:{arch:'../../secret'}},{helper:{arch:'windows-amd64',url:'http://127.0.0.1/private'}},{helper:{arch:'windows-amd64',generation:['a'.repeat(32)]}},{helper:{arch:['windows-amd64']}},{direction:'upload'},{name:'agent_secret'},{size:32*1024*1024+1},{helper:{arch:'windows-amd64',method:'POST'}}];
 for(const change of invalid){
  const callbacks={};let finish;const closed=new Promise(resolve=>finish=resolve);
  const channel={readyState:'open',bufferedAmount:0,send(){},close(){finish();},onMessage:{subscribe:fn=>callbacks.message=fn},stateChange:{subscribe:fn=>callbacks.state=fn},error:{subscribe:fn=>callbacks.error=fn}};
  const controller=new AbortController(),files=attachServiceFiles(channel,{valid:()=>true,headers:{},port:()=>upstream.address().port,signal:controller.signal,fail(){}});
  let timer;try{callbacks.message(JSON.stringify({...original,...change}));await Promise.race([closed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('invalid helper source was not rejected')),1000))]);}finally{clearTimeout(timer);files.close();}
 }
 assert.equal(requests,0);
});
for(const window of [4,16])test(`dedicated file channel with window ${window} transfers 8 MiB and empty files over real DTLS, hashes match and desktop remains untouched`,async t=>{
 const {app,c}=await setup(t),files=await fileClient(c,window),features=(await c.rpc('ping')).value;assert.equal(features.filesProtocol,1);assert.equal(features.filesWindow,16);
 const bytes=Buffer.alloc(8*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 let metrics;const uploaded=[],downloaded=[];await files.upload(new File([bytes],'中文.bin'),undefined,undefined,(n,_total,value)=>{uploaded.push(n);if(value)metrics=value;assert.equal(files.progressing,true);});assert.equal(files.progressing,false);const blob=await files.download('中文.bin',bytes.length,undefined,n=>downloaded.push(n));assert.equal(hash(Buffer.from(await blob.arrayBuffer())),hash(bytes));
 assert.equal(metrics.windowChunks,window);for(const key of ['chunkAckMs','chunkMaxAckMs','bufferWaitMs','fileReadMs'])assert.ok(Number.isInteger(metrics[key])&&metrics[key]>=0);
 assert.equal(uploaded[0],0);assert.equal(uploaded.at(-1),bytes.length);assert.equal(downloaded[0],0);assert.equal(downloaded.at(-1),bytes.length);
 await files.upload(new File([],'empty'));assert.equal((await files.download('empty',0)).size,0);
 assert.equal((await c.rpc('files')).value.files.length,2);assert.equal((await(await app.request('/api/state')).json()).mine,true);assert.equal(app.vncConnections,0);assert.deepEqual(app.inputCalls,[]);
 const original=(await c.rpc('files')).value.files.find(f=>f.name==='中文.bin');
 assert.equal((await files.upload(new File(['another'],'中文.bin'),{mode:'rename'})).name,'中文 (2).bin');assert.equal(hash(app.files.get('中文.bin')),hash(bytes));
 assert.equal((await files.upload(new File(['replaced'],'中文.bin'),{mode:'replace',version:original.version})).name,'中文.bin');
 await assert.rejects(files.upload(new File(['stale'],'中文.bin'),{mode:'replace',version:original.version}),/原文件已变化/);assert.equal(app.files.get('中文.bin').toString(),'replaced');
 assert.equal((await c.rpc('ping')).ok,true,'a business rejection preserves the encrypted service control peer');
 const replacement=await fileClient(c,window);await replacement.upload(new File(['same peer'],'after-conflict'));assert.equal(app.files.get('after-conflict').toString(),'same peer');
 assert.equal(app.received.filter(r=>r.method==='PUT'&&r.url==='/files/%E4%B8%AD%E6%96%87.bin').length,3);
});
test('file direct shares guest quotas and rejects oversized input without replay',async t=>{
 const {app,c}=await setup(t);const files=await fileClient(c);
 await assert.rejects(files.upload({name:'large',size:FILE_MAX+1}),/50 MiB/);
 // A stored listing of 1000 files must be rejected by the same HTTP quota gate.
 for(let i=0;i<1000;i++)app.files.set('file'+i,Buffer.alloc(0));
 await assert.rejects(files.upload(new File(['blocked'],'blocked')),/数量上限/);assert.equal(app.files.has('blocked'),false);
});
test('explicit file cancellation preserves the encrypted service and permits a fresh manual transfer', async t => {
 let recovered;const closed=new Promise(resolve=>{recovered=resolve;});
 const {app,c}=await setup(t),failures=[],files=await fileClient(c,4,value=>{failures.push(value);recovered();});
 let release,entered;const hold=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});const controller=new AbortController();
 const upload=files.upload({name:'cancelled.bin',size:32*FILE_CHUNK,slice(offset,end){return{async arrayBuffer(){if(offset){entered();await hold;}return new Uint8Array(end-offset).buffer;}};}},undefined,controller.signal);void upload.catch(()=>{});
 try {
  await started;controller.abort(Error('user canceled'));await assert.rejects(upload,/user canceled/);release();await closed;
  assert.deepEqual(failures,[true]);assert.equal((await c.rpc('ping')).ok,true);
  const replacement=await fileClient(c);await replacement.upload(new File(['manual retry'],'new.bin'));
  assert.equal(app.files.get('new.bin').toString(),'manual retry');assert.equal(app.files.has('cancelled.bin'),false);assert.deepEqual(app.inputCalls,[]);
 } finally {release();}
});
test('canceling a direct download drains its in-flight tail without retiring the service peer', async t => {
 const {app,c}=await setup(t),bytes=Buffer.alloc(128*1024,79);app.files.set('download.bin',bytes);
 let recovered;const closed=new Promise(resolve=>{recovered=resolve;}),failures=[];
 const files=await fileClient(c,16,value=>{failures.push(value);recovered();}),controller=new AbortController();
 const pending=files.download('download.bin',bytes.length,controller.signal,loaded=>{if(loaded>0)controller.abort(Error('cancel download'));});
 await assert.rejects(pending,/cancel download/);await closed;
 assert.deepEqual(failures,[true]);assert.equal((await c.rpc('ping')).ok,true);
 const replacement=await fileClient(c,16),blob=await replacement.download('download.bin',bytes.length);
 assert.equal(hash(Buffer.from(await blob.arrayBuffer())),hash(bytes));assert.deepEqual(app.inputCalls,[]);
});
test('revoking a guest during a stalled direct upload aborts its transfer and sends no retry',async t=>{
 const {app,c}=await setup(t),files=await fileClient(c);let release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 app.files.set('interrupted',Buffer.from('original'));
 const version=(await c.rpc('files')).value.files.find(f=>f.name==='interrupted').version;
 const upload=files.upload({name:'interrupted',size:32*FILE_CHUNK,slice(offset,end){return{async arrayBuffer(){if(offset){started();await waiting;}return new Uint8Array(end-offset).buffer;}};}},{mode:'replace',version});void upload.catch(()=>{});await entered;
 for(let n=0;n<100&&!app.received.some(r=>r.method==='PUT'&&r.url==='/files/interrupted');n++)await new Promise(r=>setTimeout(r,10));
 const quota=await fetch(app.config.origin+'/api/files/second',{method:'PUT',headers:{...c.headers,'content-type':'application/octet-stream'},body:'second'});assert.equal(quota.status,503);
 await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});await assert.rejects(upload);release();
 assert.equal(app.files.get('interrupted').toString(),'original');assert.equal(app.received.filter(r=>r.method==='PUT'&&r.url==='/files/interrupted').length<=1,true);assert.deepEqual(app.inputCalls,[]);
});

test('real Python file helper preserves disk bytes and atomic replacement when direct upload is revoked',async t=>{
 const {app,c}=await setup(t),directory=app.directory+'/actual-transfer',bin=app.directory+'/bin',secret=app.directory+'/file-secret';
 await mkdir(bin);await writeFile(bin+'/codex',"#!/bin/sh\nprintf 'version-only-test\\n'\n",{mode:0o700});await writeFile(secret,app.config.agentSecret,{mode:0o600});
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const helper=spawn('python3',['-u',fileURLToPath(new URL('../desktop/agent.py',import.meta.url))],{env:{...process.env,PATH:bin+':'+process.env.PATH,AGENT_SECRET_FILE:secret,AGENT_PORT:String(port),TRANSFER_DIR:directory,DEPLOY_MODE:'terminal'},stdio:['ignore','pipe','ignore']});
 t.after(async()=>{if(helper.exitCode===null){helper.kill();await once(helper,'exit');}});await once(helper.stdout,'data');app.config.agentUrl='http://127.0.0.1:'+port;
 const files=await fileClient(c),bytes=Buffer.alloc(128*1024,173);await files.upload(new File([bytes],'disk.bin'));assert.equal(hash(await readFile(directory+'/disk.bin')),hash(bytes));assert.equal(hash(Buffer.from(await(await files.download('disk.bin',bytes.length)).arrayBuffer())),hash(bytes));
 await writeFile(directory+'/keep','original');let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const version=(await c.rpc('files')).value.files.find(f=>f.name==='keep').version;
 const uploading=files.upload({name:'keep',size:32*FILE_CHUNK,slice(offset,end){return{async arrayBuffer(){if(offset){entered();await gate;}return new Uint8Array(end-offset).buffer;}};}},{mode:'replace',version});void uploading.catch(()=>{});await started;
 for(let n=0;n<100&&!(await readdir(directory)).some(f=>f.startsWith('.upload-'));n++)await new Promise(r=>setTimeout(r,10));
 await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});await assert.rejects(uploading);release();
 for(let n=0;n<100&&(await readdir(directory)).some(f=>f.startsWith('.upload-'));n++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await readFile(directory+'/keep')).toString(),'original');assert.ok(!(await readdir(directory)).some(f=>f.startsWith('.upload-')));
});

test('encrypted file downloads accept existing Unix names without widening upload rules', async t => {
 const {app,c}=await setup(t),files=await fileClient(c);
 for(const name of ['中'.repeat(81)+'.txt','literal\\backslash']){
  app.files.set(name,Buffer.from('existing'));
  const blob=await files.download(name,8);assert.equal(await blob.text(),'existing');
 }
 assert.equal((await c.rpc('ping')).ok,true);assert.deepEqual(app.inputCalls,[]);
});
