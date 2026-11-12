import test from 'node:test';
import { mkdir,mkdtemp,rm,writeFile,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { serviceClient } from './support/service-client.mjs';
import { createFileClient } from '../panel/public/file-client.js';
import { FILE_MAX } from '../panel/public/file-wire.js';
import { attachServiceFiles } from '../panel/service-files.mjs';
import { FORWARD_FILES } from '../panel/forward-downloads.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
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
async function fileClient(c,window=4){const channel=c.peer.createDataChannel('codex-files',{ordered:true,protocol:'files-v1'});const adapter={get readyState(){return channel.readyState;},get bufferedAmount(){return channel.bufferedAmount;},send:x=>channel.send(x),close:()=>channel.close(),addEventListener(type,fn){if(type==='message')channel.onMessage.subscribe(data=>fn({data}));else if(type==='close')channel.stateChange.subscribe(s=>{if(s==='closed')fn();});else if(type==='error')channel.error.subscribe(fn);}};const client=createFileClient(adapter,()=>{},{window});for(let i=0;i<200&&!client.ready;i++)await new Promise(r=>setTimeout(r,10));assert.equal(client.ready,true);return client;}
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
 await files.upload(new File([bytes],'中文.bin'));const blob=await files.download('中文.bin',bytes.length);assert.equal(hash(Buffer.from(await blob.arrayBuffer())),hash(bytes));
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
test('revoking a guest during a stalled direct upload aborts its transfer and sends no retry',async t=>{
 const {app,c}=await setup(t),files=await fileClient(c);let release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 app.files.set('interrupted',Buffer.from('original'));
 const version=(await c.rpc('files')).value.files.find(f=>f.name==='interrupted').version;
 const upload=files.upload({name:'interrupted',size:32760,slice(offset){return{async arrayBuffer(){if(offset){started();await waiting;}return new Uint8Array(16380).buffer;}};}},{mode:'replace',version});void upload.catch(()=>{});await entered;
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
 const uploading=files.upload({name:'keep',size:32760,slice(offset){return{async arrayBuffer(){if(offset){entered();await gate;}return new Uint8Array(16380).buffer;}};}},{mode:'replace',version});void uploading.catch(()=>{});await started;
 for(let n=0;n<100&&!(await readdir(directory)).some(f=>f.startsWith('.upload-'));n++)await new Promise(r=>setTimeout(r,10));
 await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});await assert.rejects(uploading);release();
 for(let n=0;n<100&&(await readdir(directory)).some(f=>f.startsWith('.upload-'));n++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await readFile(directory+'/keep')).toString(),'original');assert.ok(!(await readdir(directory)).some(f=>f.startsWith('.upload-')));
});
