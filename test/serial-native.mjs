// Real Linux helper + fixed serial child, with an intentionally absent device.
// No physical USB/serial device, production desktop, or device commands.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import { fixture } from './fixture.mjs';
const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-fixed-serial-'));
let app, child, socket, result = '', exited = false;
const until = async probe => { const end = Date.now() + 10000; while (!await probe()) { if(Date.now()>end)throw Error('serial deadline');await new Promise(r=>setTimeout(r,20)); } };
try {
  await lstat('/dev/ttyUSB9999').then(()=>{throw Error('Test device exists; refusing to use it');},error=>{if(error.code!=='ENOENT')throw error;});
  const binary=join(directory,'helper');await exec('go',['build','-p','2','-race','-mod=readonly','-o',binary,'.'],{cwd:resolve('client/forward'),timeout:120000,maxBuffer:8192,env:{...process.env,GOTOOLCHAIN:'local'}});
  app=await fixture({forwardPorts:[]});await app.login();await app.claim();
  const agent=(await(await app.request('/api/forward/agents')).json()).agents[0], key=(await(await app.request('/api/forward/agents/key?id='+agent.id)).json()).key;
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const created=await app.request('/api/forward/agents/rule',{method:'POST',body:{agentId:agent.id,name:'串口测试',enabled:true,config:{direction:'reverse',protocol:'serial',deviceName:'串口测试',localPort:port,serial:{path:'/dev/ttyUSB9999',baud:115200,dataBits:8,parity:'none',stopBits:1,dtr:false,rts:false}}}});assert.equal(created.status,200);
  child=spawn(binary,[],{env:{...process.env,NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{result=(result+b).slice(-65536);});child.once('exit',()=>{exited=true;});child.stdin.end(key+'\n');
  const state=async()=>(await(await app.request('/api/forward/agents')).json()).agents[0];
  await until(async()=>(await state()).rules[0].state==='active');
  assert(!result.includes('serial_open_failed'),'must not open before a TCP client connects');
  socket=net.connect(port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'close');
  await until(async()=>(await state()).rules[0].mapping.errorCode==='serial_open_failed'||result.includes('串口无法打开'));
  assert(!exited);assert(!result.includes(key));assert.deepEqual(app.inputCalls,[]);
  const rekey=await app.request('/api/forward/agents/rekey',{method:'POST',body:{id:agent.id,revision:agent.keyRevision}});assert.equal(rekey.status,200);await until(()=>exited);
  console.log('✓ actual managed serial helper: no per-rule prompt, lazy open, missing-device failure, process cleanup and independent key revocation');
} finally {
  socket?.destroy();if(child&&!exited){child.kill('SIGINT');await until(()=>exited).catch(()=>child.kill('SIGKILL'));}await app?.close();await rm(directory,{recursive:true,force:true});
}
