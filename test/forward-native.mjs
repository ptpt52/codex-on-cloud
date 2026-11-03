// Real helper + TLS/WebSocket/TCP. The fixture mocks only desktop management.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fixture } from './fixture.mjs';

const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'codex-forward-native-')),children=[],connections=new Set();
const clientDirectory=resolve('client/forward'),binary=join(directory,'forward-helper'),key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
let app,tls,target;
async function waitFor(probe,message) {
  for(let i=0;i<250;i++){if(await probe())return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error(message);
}
async function freePort(){
  const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;
}
try {
  await exec('go',['test','-race','./...'],{cwd:clientDirectory,env:{...process.env,GOTOOLCHAIN:'local'},timeout:180000,maxBuffer:16384});
  await exec('go',['build','-race','-mod=readonly','-buildvcs=false','-trimpath','-o',binary,'.'],{cwd:clientDirectory,env:{...process.env,GOTOOLCHAIN:'local',CGO_ENABLED:'1'},timeout:180000,maxBuffer:16384});
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{timeout:10000,maxBuffer:8192});
  let accepted=0,receivedAfterServerFin;
  target=net.createServer({allowHalfOpen:true},socket=>{
    accepted++;connections.add(socket);socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));
    let first=true,afterFin=false,serverFin=false;const parts=[];
    socket.on('data',bytes=>{
      if(first){afterFin=bytes[0]===0x7f;serverFin=bytes[0]===0x7e;first=false;if(serverFin)socket.end('server-fin');}
      if(serverFin){parts.push(bytes);return;}
      if(afterFin){parts.push(bytes);return;}
      if(!socket.write(bytes))socket.pause();
    });
    socket.on('drain',()=>socket.resume());
    socket.on('end',()=>{if(serverFin)receivedAfterServerFin=Buffer.concat(parts);else socket.end(afterFin?Buffer.concat([Buffer.from('after-fin:'),...parts]):undefined);});
  });
  target.listen(0,'127.0.0.1');await once(target,'listening');
  app=await fixture({forwardPorts:[target.address().port]});await app.login();await app.claim();
  const backendPort=app.panel.server.address().port;
  tls=https.createServer({key:await readFile(key),cert:await readFile(cert)},(_req,res)=>{res.writeHead(404);res.end();});
  tls.on('tlsClientError',()=>{});
  tls.on('upgrade',(req,socket,head)=>{
    const upstream=net.createConnection({host:'127.0.0.1',port:backendPort});
    for(const item of [socket,upstream]){connections.add(item);item.on('error',()=>{socket.destroy();upstream.destroy();});item.once('close',()=>{connections.delete(item);socket.destroy();upstream.destroy();});}
    upstream.once('connect',()=>{
      const headers=[];for(let i=0;i<req.rawHeaders.length;i+=2)headers.push(req.rawHeaders[i]+': '+req.rawHeaders[i+1]);
      upstream.write(req.method+' '+req.url+' HTTP/1.1\r\n'+headers.join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  tls.listen(0,'127.0.0.1');await once(tls,'listening');
  app.config.origin='https://127.0.0.1:'+tls.address().port;app.config.hosts.add(new URL(app.config.origin).host);
  const request=(path,body)=>new Promise((resolve,reject)=>{
    const payload=body===undefined?'':JSON.stringify(body),req=http.request({host:'127.0.0.1',port:backendPort,path,method:body===undefined?'GET':'POST',
      headers:{host:new URL(app.config.origin).host,origin:app.config.origin,cookie:app.cookie,'x-viewer-id':app.viewer,'x-csrf-token':app.csrf,...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},res=>{
      let size=0;const chunks=[];res.on('data',bytes=>{size+=bytes.length;if(size>65536)res.destroy(new Error('Response bound'));else chunks.push(bytes);});
      res.once('error',reject);res.once('end',()=>{assert.equal(res.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks)));});
    });req.once('error',reject);req.end(payload);
  });
  async function helper(port){
    const mapping=await request('/api/forward',{localPort:port,targetPort:target.address().port});
    const child=spawn(binary,['--server',app.config.origin],{env:{...process.env,SSL_CERT_FILE:cert},stdio:['pipe','pipe','pipe']});children.push(child);
    let output='';const collect=bytes=>{output+=bytes.toString();if(Buffer.byteLength(output)>32768)throw new Error('Helper log bound');};
    child.stdout.on('data',collect);child.stderr.on('data',collect);child.stdin.end(mapping.code+'\n');
    await waitFor(()=>output.includes('映射已开启'),'Native helper did not start: '+output);
    assert.equal(output.includes(mapping.code),false);return{child,mapping,get output(){return output;}};
  }
  async function roundtrip(port,payload){
    const socket=net.createConnection({host:'127.0.0.1',port,allowHalfOpen:true}),chunks=[];connections.add(socket);
    socket.on('error',()=>{});socket.on('data',bytes=>chunks.push(bytes));socket.once('close',()=>connections.delete(socket));
    await once(socket,'connect');const ended=once(socket,'end');socket.end(payload);await ended;socket.destroy();return Buffer.concat(chunks);
  }
  const port=await freePort(),active=await helper(port),payload=Buffer.concat([Buffer.from('literal\0\r\n中文'),randomBytes(8*1024*1024)]);
  assert.deepEqual(await roundtrip(port,payload),payload);assert.equal(accepted,1);
  const halfClose=Buffer.from('\x7f请求\0after EOF');
  assert.deepEqual(await roundtrip(port,halfClose),Buffer.concat([Buffer.from('after-fin:'),halfClose]));
  // A target's FIN must leave uploads and protocol heartbeats working. No browser
  // is attached; wait through two ping intervals before sending the final bytes.
  const upload=net.createConnection({host:'127.0.0.1',port,allowHalfOpen:true}),reply=[];
  connections.add(upload);upload.on('error',()=>{});upload.once('close',()=>connections.delete(upload));upload.on('data',bytes=>reply.push(bytes));
  await once(upload,'connect');const serverEnded=once(upload,'end');upload.write(Buffer.from('~start upload'));await serverEnded;
  assert.equal(Buffer.concat(reply).toString(),'server-fin');
  await new Promise(resolve=>setTimeout(resolve,31000));
  assert.equal(upload.destroyed,false,'Target FIN must not stop WebSocket heartbeat handling');
  const tail=randomBytes(65536);upload.end(tail);
  await waitFor(()=>receivedAfterServerFin,'Upload did not finish after target half-close');
  assert.deepEqual(receivedAfterServerFin,Buffer.concat([Buffer.from('~start upload'),tail]));
  upload.destroy();
  assert.deepEqual(await roundtrip(port,Buffer.from('after heartbeat')),Buffer.from('after heartbeat'));
  const live=net.createConnection({host:'127.0.0.1',port});connections.add(live);live.on('error',()=>{});live.once('close',()=>connections.delete(live));
  await once(live,'connect');live.write('still connected');await once(live,'data');
  const closed=once(live,'close'),finished=once(active.child,'exit');
  await request('/api/forward/stop',{id:active.mapping.id});await closed;await finished;
  assert.equal((await request('/api/forward')).mappings.length,0);
  assert.equal(active.output.includes('不会自动重连'),true);
  assert.equal(active.output.includes('DATA RACE'),false);
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);assert.equal(app.managementStats.restarts,0);
  // A certificate not trusted by the client must fail; there is no insecure flag.
  const untrustedMapping=await request('/api/forward',{localPort:await freePort(),targetPort:target.address().port});
  const insecure=spawn(binary,['--server',app.config.origin],{env:{...process.env,SSL_CERT_FILE:join(directory,'not-present')},stdio:['pipe','ignore','pipe']});children.push(insecure);
  insecure.stdin.end(untrustedMapping.code+'\n');
  let trustDeadline;
  try {
    const result=await Promise.race([once(insecure,'exit'),new Promise((_,reject)=>{trustDeadline=setTimeout(()=>reject(new Error('Client accepted an untrusted certificate')),10000);})]);
    assert.notEqual(result[0],0);
  } finally { clearTimeout(trustDeadline); }
  assert.equal((await request('/api/forward')).mappings.find(item=>item.id===untrustedMapping.id).state,'pending','TLS failure must happen before consuming a valid pairing code');
  await request('/api/forward/stop',{id:untrustedMapping.id});
  console.log('✓ real native helper, verified TLS/WSS and TCP: 8 MiB binary transfer, both half-close directions, post-FIN heartbeat/upload, browser-independent lifetime and stop/revocation; no desktop or Codex input');
} finally {
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  for(const socket of connections)socket.destroy();
  await app?.close();
  if(tls)await new Promise(resolve=>tls.close(resolve));
  if(target)await new Promise(resolve=>target.close(resolve));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
}
