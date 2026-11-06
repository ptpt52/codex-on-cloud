// Actual Linux helper/worker processes and loopback TCP/WebSocket. Desktop is
// mocked; the serial device is deliberately absent, never a physical console.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import { fixture } from './fixture.mjs';
const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-serial-native-')), children = [];
let app;
async function until(probe) {for (let i=0;i<200;i++){if(await probe())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('serial native deadline');}
async function port() {const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
try {
 await lstat('/dev/ttyUSB9999').then(()=>{throw Error('Test device unexpectedly exists; refusing hardware access');},error=>{if(error.code!=='ENOENT')throw error;});
 const binary=join(directory,'forward');await exec('go',['build','-mod=readonly','-buildvcs=false','-trimpath','-o',binary,'.'],{cwd:resolve('client/forward'),timeout:120000,maxBuffer:8192,env:{...process.env,GOTOOLCHAIN:'local'}});
 app=await fixture({forwardPorts:[]});await app.login();await app.claim();
 for (const consent of ['NO','FLAG','YES']) {
  const localPort=await port(),response=await app.request('/api/forward',{method:'POST',body:{direction:'reverse',protocol:'serial',deviceName:'absent test console',localPort,serial:{path:'/dev/ttyUSB9999',baud:115200,dataBits:8,parity:'none',stopBits:1,dtr:false,rts:false}}});assert.equal(response.status,200);const grant=await response.json();
  const child=spawn(binary,['--server',app.config.origin,...(consent==='FLAG'?['--allow-reverse','127.0.0.1:22']:[])],{stdio:['pipe','pipe','pipe']});children.push(child);let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;if(log.length>32768)throw Error('test log bound');});child.stdin.write(grant.code+'\n'+(consent==='FLAG'?'':consent+'\n'));
  const state=async()=> (await(await app.request('/api/forward')).json());
  if(consent!=='YES'){await until(async()=> (await state()).recent.some(item=>item.id===grant.id&&item.code==='reverse_denied'));await until(()=>child.exitCode!==null);continue;}
  await until(async()=> (await state()).mappings.some(item=>item.id===grant.id&&item.state==='active'));
  assert.match(log,/DTR\/RTS/);const childrenPath=`/proc/${child.pid}/task/${child.pid}/children`;assert.equal((await readFile(childrenPath,'utf8')).trim(),'');
  const tcp=net.createConnection({host:'127.0.0.1',port:localPort});tcp.on('error',()=>{});await once(tcp,'close');
  await until(async()=> (await state()).mappings.some(item=>item.id===grant.id&&item.errorCode==='serial_open_failed'));
  assert.equal((await readFile(childrenPath,'utf8')).trim(),'');assert.equal(child.exitCode,null);assert.equal((await state()).mappings.find(item=>item.id===grant.id).targetStatus.state,'failed');
  const stopped=once(child,'exit');child.kill('SIGINT');await stopped;await until(async()=> !(await state()).mappings.some(item=>item.id===grant.id));
 }
 assert.deepEqual(app.inputCalls,[]);assert.equal(app.managementStats.restarts,0);
 console.log('Actual Linux helper: explicit denial/approval, lazy serial worker, missing-device error, child reap and stop passed. No physical serial hardware or Cloudflare used.');
} finally {
 for(const child of children)if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}
 await app?.close();await rm(directory,{recursive:true,force:true});
}
