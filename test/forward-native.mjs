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
import { createForwardPeer } from '../panel/forward-rtc.mjs';
import { rtcAddress, rtcIPv6Address } from '../panel/rtc.mjs';

const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'codex-forward-native-')),children=[],connections=new Set(),controlLinks=new Set();
const clientDirectory=resolve('client/forward'),binary=join(directory,'forward-helper'),key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
let app,tls,target,target6,occupied,testDeadline;
async function waitFor(probe,message,attempts=250) {
  for(let i=0;i<attempts;i++){if(await probe())return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error(message);
}
async function freePort(){
  const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;
}
try {
  await Promise.race([(async()=>{
  await exec('go',['test','-race','./...'],{cwd:clientDirectory,env:{...process.env,GOTOOLCHAIN:'local'},timeout:180000,maxBuffer:16384});
  await exec('go',['build','-race','-mod=readonly','-buildvcs=false','-trimpath','-o',binary,'.'],{cwd:clientDirectory,env:{...process.env,GOTOOLCHAIN:'local',CGO_ENABLED:'1'},timeout:180000,maxBuffer:16384});
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{timeout:10000,maxBuffer:8192});
  let accepted=0,receivedAfterServerFin,receivedBytes=0,dropDirectReady=false,blockResume=false;
  const managementRequests={pair:0,resume:0};
  const echoConnection=socket=>{
    accepted++;connections.add(socket);socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));
    let first=true,afterFin=false,serverFin=false;const parts=[];
    socket.on('data',bytes=>{
      receivedBytes+=bytes.length;
      if(first){afterFin=bytes[0]===0x7f;serverFin=bytes[0]===0x7e;first=false;if(serverFin)socket.end('server-fin');}
      if(serverFin){parts.push(bytes);return;}
      if(afterFin){parts.push(bytes);return;}
      if(!socket.write(bytes))socket.pause();
    });
    socket.on('drain',()=>socket.resume());
    socket.on('end',()=>{if(serverFin)receivedAfterServerFin=Buffer.concat(parts);else socket.end(afterFin?Buffer.concat([Buffer.from('after-fin:'),...parts]):undefined);});
  };
  target=net.createServer({allowHalfOpen:true},echoConnection);
  target.listen(0,'127.0.0.2');await once(target,'listening');
  target6=net.createServer({allowHalfOpen:true},echoConnection);
  target6.listen(0,'::1');await once(target6,'listening');
  const directPeers=[];let onlySix=false;
  const ipv6Only=sdp=>sdp.split(/\r?\n/).filter(line=>!line.startsWith('a=candidate:')||line.split(' ')[4]?.includes(':')).join('\r\n');
  app=await fixture({forwardPorts:'*',forwardPeerFactory:options=>{
    const peer=createForwardPeer({...options,connect:(socket,id)=>{
      if(dropDirectReady){dropDirectReady=false;const send=socket.send;socket.send=(value,...args)=>{if(value==='{"type":"ready"}'){socket.terminate();return;}send(value,...args);};}
      options.connect(socket,id);
    }});directPeers.push(peer);
    if(onlySix){const answer=peer.answer;peer.answer=async offer=>ipv6Only(await answer({...offer,sdp:ipv6Only(offer.sdp)}));}
    return peer;
  }});await app.login();await app.claim();
  const backendPort=app.panel.server.address().port;
  tls=https.createServer({key:await readFile(key),cert:await readFile(cert)},(_req,res)=>{res.writeHead(404);res.end();});
  tls.on('tlsClientError',()=>{});
  tls.on('upgrade',(req,socket,head)=>{
    if(req.url==='/forward/helper')managementRequests.pair++;
    if(req.url==='/forward/resume')managementRequests.resume++;
    if(req.url==='/forward/resume'&&blockResume){socket.end('HTTP/1.1 503 Offline Test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    if(['/forward/helper','/forward/resume'].includes(req.url)){controlLinks.add(socket);socket.once('close',()=>controlLinks.delete(socket));}
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
  function launch(mapping,certFile=cert,approve=true){
    const reverseArgs=mapping.direction==='reverse'&&approve?['--allow-reverse',(net.isIP(mapping.targetHost)===6?'['+mapping.targetHost+']':mapping.targetHost)+':'+mapping.targetPort]:[];
    const child=spawn(binary,['--server',app.config.origin,...reverseArgs],{env:{...process.env,SSL_CERT_FILE:certFile},stdio:['pipe','pipe','pipe']});children.push(child);const finished=once(child,'exit');
    let output='';const collect=bytes=>{output+=bytes.toString();if(Buffer.byteLength(output)>32768)throw new Error('Helper log bound');};
    child.stdout.on('data',collect);child.stderr.on('data',collect);child.stdin.end(mapping.code+'\n'+(approve?'':'NO\n'));
    return{child,mapping,finished,get output(){return output;}};
  }
  async function helper(port,targetPort=target.address().port,targetHost='127.0.0.2'){
    const mapping=await request('/api/forward',{localPort:port,targetHost,targetPort}),active=launch(mapping);
    await waitFor(()=>active.output.includes('映射已开启'),'Native helper did not start');
    assert.equal(active.output.includes(mapping.code),false);assert.ok(active.output.includes(net.isIP(targetHost)===6?'['+targetHost+']:'+targetPort:targetHost+':'+targetPort));return active;
  }
  async function roundtrip(port,payload){
    const socket=net.createConnection({host:'127.0.0.1',port,allowHalfOpen:true}),chunks=[];connections.add(socket);
    socket.on('error',()=>{});socket.on('data',bytes=>chunks.push(bytes));socket.once('close',()=>connections.delete(socket));
    const deadline=setTimeout(()=>socket.destroy(new Error('Isolated TCP roundtrip timed out after 30 seconds; sent '+payload.length+' bytes, received '+chunks.reduce((n,b)=>n+b.length,0))),30000);
    try { await once(socket,'connect');const ended=once(socket,'end');socket.end(payload);await ended;return Buffer.concat(chunks); }
    finally { clearTimeout(deadline);socket.destroy(); }
  }
  const payload=Buffer.concat([Buffer.from('literal\0\r\n中文'),randomBytes(8*1024*1024)]),halfClose=Buffer.from('\x7f请求\0after EOF'),ipv6=rtcIPv6Address(undefined,rtcAddress());
  if(!process.env.FORWARD_REVERSE_ONLY){
  const port=await freePort(),active=await helper(port);
  assert.deepEqual(await roundtrip(port,payload),payload);assert.equal(accepted,1);
  const reused=launch(active.mapping);await reused.finished;assert.match(reused.output,/配对码已使用/);assert.equal(reused.output.includes(active.mapping.code),false);
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
  await request('/api/desktop/claim',{viewer:'22222222-2222-4222-8222-222222222222'});await request('/api/desktop/claim',{viewer:app.viewer});
  const nextBytes=once(live,'data');live.write('after page claims');assert.equal((await nextBytes)[0].toString(),'after page claims');
  assert.equal(active.output.includes('TCP 连接失败'),false,'Successful half-closes must not report network errors');
  const closed=once(live,'close'),finished=once(active.child,'exit');
  await request('/api/forward/stop',{id:active.mapping.id});await closed;await finished;
  assert.equal((await request('/api/forward')).mappings.length,0);
  assert.equal(active.output.includes('正在自动恢复'),false);
  assert.match(active.output,/映射已由网页明确停止/);
  assert.equal(active.output.includes('DATA RACE'),false);
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);assert.equal(app.managementStats.restarts,0);
  // Report an actual local bind failure to both the operator and the webpage.
  occupied=net.createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  const blocked=launch(await request('/api/forward',{localPort:occupied.address().port,targetPort:target.address().port}));await blocked.finished;
  assert.match(blocked.output,/端口已被占用/);assert.equal((await request('/api/forward')).recent[0].code,'local_port_in_use');
  // Target errors keep the listener usable and have a fixed console output cap.
  const unavailable=await freePort();
  const badPort=await freePort(),bad=await helper(badPort,unavailable);
  for(let i=0;i<22;i++){
    const peer=net.createConnection({host:'127.0.0.1',port:badPort});connections.add(peer);peer.on('error',()=>{});peer.once('close',()=>connections.delete(peer));await once(peer,'close');
  }
  await waitFor(()=>bad.output.includes('20 条上限'),'Missing bounded connection diagnostics');
  assert.equal((bad.output.match(/TCP 连接失败：/g)||[]).length,20);assert.match(bad.output,/目标端口无法连接/);
  assert.equal((await request('/api/forward')).mappings[0].errorCode,'target_unavailable');
  await request('/api/forward/stop',{id:bad.mapping.id});await bad.finished;
  // A real control disconnect drops old TCP, releases the local listener, and
  // restores the same mapping after failed attempts without pairing or replay.
  const droppedPort=await freePort(),dropped=await helper(droppedPort);
  const lost=net.createConnection({host:'127.0.0.1',port:droppedPort});connections.add(lost);lost.on('error',()=>{});lost.once('close',()=>connections.delete(lost));
  await once(lost,'connect');lost.write('only once before disconnect');await once(lost,'data');
  const beforeRecovery={...managementRequests},beforeReceived=receivedBytes,beforeAccepted=accepted,lostClosed=new Promise(resolve=>lost.once('close',resolve));
  blockResume=true;for(const socket of controlLinks)socket.destroy();await lostClosed;
  await waitFor(()=>dropped.output.includes('正在自动恢复'),'Missing management recovery notice');
  await waitFor(async()=>(await request('/api/forward')).mappings[0]?.state==='recovering','Mapping did not enter recovery');
  await waitFor(()=>managementRequests.resume>beforeRecovery.resume,'Helper did not retry transient management failure');
  const refused=net.createConnection({host:'127.0.0.1',port:droppedPort});let refusedError;refused.on('error',error=>{refusedError=error;});await new Promise(resolve=>refused.once('close',resolve));assert.equal(refusedError?.code,'ECONNREFUSED');
  assert.equal(accepted,beforeAccepted);assert.equal(receivedBytes,beforeReceived);
  blockResume=false;await waitFor(()=>dropped.output.includes('映射已恢复'),'Native listener did not recover',500);
  assert.equal(managementRequests.pair,beforeRecovery.pair,'One-time pairing must never be replayed');
  assert.equal((await request('/api/forward')).mappings[0].id,dropped.mapping.id);
  assert.equal(accepted,beforeAccepted,'Recovery must not reopen a target TCP connection');assert.equal(receivedBytes,beforeReceived);
  assert.deepEqual(await roundtrip(droppedPort,Buffer.from('explicit new client')),Buffer.from('explicit new client'));
  await request('/api/forward/stop',{id:dropped.mapping.id});await dropped.finished;assert.match(dropped.output,/映射已由网页明确停止/);
  // Stop while offline must be final when the helper next checks authorization.
  const canceled=await helper(await freePort());blockResume=true;for(const socket of controlLinks)socket.destroy();
  await waitFor(async()=>(await request('/api/forward')).mappings[0]?.state==='recovering','Expected offline mapping');
  await request('/api/forward/stop',{id:canceled.mapping.id});blockResume=false;await canceled.finished;
  assert.match(canceled.output,/映射已由网页明确停止/);assert.equal(canceled.output.includes('映射已恢复'),false);
  // A sustained outage has a real absolute 30-second deadline, not an endless
  // loop whose budget resets whenever an HTTP/TLS attempt partly succeeds.
  const expired=await helper(await freePort()),beforeExpiry={...managementRequests};
  blockResume=true;for(const socket of controlLinks)socket.destroy();await expired.finished;blockResume=false;
  assert.match(expired.output,/恢复窗口/);assert.ok(managementRequests.resume-beforeExpiry.resume<=8);
  assert.equal(managementRequests.pair,beforeExpiry.pair);assert.equal((await request('/api/forward')).recent[0].code,'resume_expired');
  // A certificate not trusted by the client must fail; there is no insecure flag.
  const untrustedMapping=await request('/api/forward',{localPort:await freePort(),targetPort:target.address().port});
  const insecure=launch(untrustedMapping,join(directory,'not-present'));
  let trustDeadline;
  try {
    const result=await Promise.race([insecure.finished,new Promise((_,reject)=>{trustDeadline=setTimeout(()=>reject(new Error('Client accepted an untrusted certificate')),10000);})]);
    assert.notEqual(result[0],0);
  } finally { clearTimeout(trustDeadline); }
  assert.match(insecure.output,/证书验证失败/);assert.equal(insecure.output.includes(untrustedMapping.code),false);
  assert.equal((await request('/api/forward')).mappings.find(item=>item.id===untrustedMapping.id).state,'pending','TLS failure must happen before consuming a valid pairing code');
  await request('/api/forward/stop',{id:untrustedMapping.id});
  // Real Pion/werift ICE + DTLS + SCTP; management is still the same mock.
  app.config.webrtc=true;
  const beforeProbe=accepted;
  const directPort=await freePort(),direct=await helper(directPort);
  const pinned=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(pinned);pinned.on('error',()=>{});pinned.once('close',()=>connections.delete(pinned));
  await once(pinned,'connect');pinned.write('pinned to WSS');await once(pinned,'data');
  assert.equal((await request('/api/forward')).mappings[0].directConnections,0);
  await waitFor(async()=> (await request('/api/forward')).mappings[0].direct.available,'Native IPv4 direct path did not become ready',1000);
  assert.equal(accepted,beforeProbe+1,'Direct probing must not connect a target port');
  const directState=(await request('/api/forward')).mappings[0];assert.equal(directState.direct.family,'IPv4');assert.ok(Number.isInteger(directState.direct.rttMs));
  assert.deepEqual(await roundtrip(directPort,payload),payload);
  assert.deepEqual(await roundtrip(directPort,halfClose),Buffer.concat([Buffer.from('after-fin:'),halfClose]));
  const beforeLost=accepted,beforeLostBytes=receivedBytes;dropDirectReady=true;
  const uncertain=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(uncertain);uncertain.on('error',()=>{});uncertain.once('close',()=>connections.delete(uncertain));
  const uncertainClosed=new Promise(resolve=>uncertain.once('close',resolve));
  uncertain.write('never replay after an ambiguous target open');await uncertainClosed;
  assert.equal(accepted,beforeLost+1,'Lost direct readiness must not reconnect the target through WSS');assert.equal(receivedBytes,beforeLostBytes,'Bytes must wait for explicit target readiness');
  // The target can half-close its output while the client continues uploading.
  receivedAfterServerFin=undefined;const uploadDirect=net.createConnection({host:'127.0.0.1',port:directPort,allowHalfOpen:true});connections.add(uploadDirect);uploadDirect.on('error',()=>{});uploadDirect.once('close',()=>connections.delete(uploadDirect));
  const directReply=[];uploadDirect.on('data',bytes=>directReply.push(bytes));
  await once(uploadDirect,'connect');const uploadEnded=once(uploadDirect,'end');uploadDirect.write('~direct upload');await uploadEnded;
  assert.equal(Buffer.concat(directReply).toString(),'server-fin');
  await new Promise(resolve=>setTimeout(resolve,7000));assert.equal(uploadDirect.destroyed,false);uploadDirect.end('after direct heartbeat');
  await waitFor(()=>receivedAfterServerFin,'Direct upload did not survive target FIN');assert.equal(receivedAfterServerFin.toString(),'~direct uploadafter direct heartbeat');uploadDirect.destroy();
  const liveDirect=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(liveDirect);liveDirect.on('error',()=>{});liveDirect.once('close',()=>connections.delete(liveDirect));
  await once(liveDirect,'connect');liveDirect.write('real direct TCP');await once(liveDirect,'data');
  let route=(await request('/api/forward')).mappings[0];assert.equal(route.directConnections,1);assert.equal(route.connections,2);
  // Inject only a health fault; both old TCP streams continue on real sockets.
  directPeers.at(-1).unhealthy('rtc_health_timeout');await waitFor(()=>direct.output.includes('直连心跳超时'),'Helper did not choose relay after health timeout');
  const fallback=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(fallback);fallback.on('error',()=>{});fallback.once('close',()=>connections.delete(fallback));
  await once(fallback,'connect');fallback.write('new relay TCP');await once(fallback,'data');
  route=(await request('/api/forward')).mappings[0];assert.equal(route.directConnections,1);assert.equal(route.connections,3);
  await waitFor(async()=> (await request('/api/forward')).mappings[0].direct.available,'Health recovery did not restore direct preference',500);
  for(const [peer,text] of [[pinned,'WSS remains pinned'],[liveDirect,'direct remains pinned'],[fallback,'fallback remains pinned']]){const reply=once(peer,'data');peer.write(text);assert.equal((await reply)[0].toString(),text);}
  const directClosed=once(liveDirect,'close');await directPeers.at(-1).destroy();await directClosed;
  assert.equal(pinned.destroyed,false);assert.equal(fallback.destroyed,false);
  await waitFor(async()=> (await request('/api/forward')).mappings[0].direct.available,'Background direct renegotiation did not recover',2000);
  assert.deepEqual(await roundtrip(directPort,Buffer.from('after actual peer loss')),Buffer.from('after actual peer loss'));
  route=(await request('/api/forward')).mappings[0];assert.equal(route.directConnections,0);assert.equal(route.connections,2);
  const finalDirect=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(finalDirect);finalDirect.on('error',()=>{});finalDirect.once('close',()=>connections.delete(finalDirect));
  await once(finalDirect,'connect');finalDirect.write('revoke both transports');await once(finalDirect,'data');
  const allEnded=[finalDirect,pinned,fallback].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
  const beforeDirectRecovery=accepted,pairsBeforeDirectRecovery=managementRequests.pair;
  for(const socket of controlLinks)socket.destroy();await Promise.all(allEnded);
  await waitFor(()=>direct.output.includes('映射已恢复'),'Direct-capable helper did not restore management',500);
  await waitFor(async()=>(await request('/api/forward')).mappings[0].direct.available,'Direct peer did not rebuild after management recovery',1000);
  assert.equal(accepted,beforeDirectRecovery);assert.equal(managementRequests.pair,pairsBeforeDirectRecovery);
  assert.deepEqual(await roundtrip(directPort,Buffer.from('new direct client after management recovery')),Buffer.from('new direct client after management recovery'));
  const finalRestored=net.createConnection({host:'127.0.0.1',port:directPort});connections.add(finalRestored);finalRestored.on('error',()=>{});finalRestored.once('close',()=>connections.delete(finalRestored));
  await once(finalRestored,'connect');finalRestored.write('stop restored direct mapping');await once(finalRestored,'data');
  const restoredClosed=once(finalRestored,'close');await request('/api/forward/stop',{id:direct.mapping.id});await restoredClosed;await direct.finished;
  assert.equal(direct.output.includes('DATA RACE'),false);
  if(ipv6){
    app.config.webrtcIPv6=true;app.config.webrtcIPv6Address=ipv6;onlySix=true;
    const ipv6Port=await freePort(),six=await helper(ipv6Port,target6.address().port,'::1');
    await waitFor(async()=> (await request('/api/forward')).mappings[0].direct.available,'Native global IPv6 direct path did not become ready',1000);
    assert.equal((await request('/api/forward')).mappings[0].direct.family,'IPv6');
    assert.deepEqual(await roundtrip(ipv6Port,payload),payload);
    await request('/api/forward/stop',{id:six.mapping.id});await six.finished;assert.equal(six.output.includes('DATA RACE'),false);
  }else console.log('SKIP native IPv6: no assigned global IPv6; IPv4 does not count as IPv6 verification');
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);assert.equal(app.managementStats.restarts,0);
  for(const child of children)assert.notEqual(child.exitCode,66,'Go race detector failed');
  app.config.webrtc=false;
  const target6Port=await freePort(),sixRelay=await helper(target6Port,target6.address().port,'::1');
  assert.deepEqual(await roundtrip(target6Port,Buffer.from('IPv6 target through WSS')),Buffer.from('IPv6 target through WSS'));
  await request('/api/forward/stop',{id:sixRelay.mapping.id});await sixRelay.finished;
  }
  // Reverse mode uses the same real helper and transports, but the helper
  // owns the target dial. Pairing/probes alone must never touch that target.
  app.config.webrtc=false;app.config.webrtcIPv6=false;onlySix=false;
  const reverseMapping=async(port,host='127.0.0.2',targetPort=target.address().port)=>request('/api/forward',{direction:'reverse',deviceName:'隔离测试设备',protocol:'ssh',localPort:port,targetHost:host,targetPort});
  const deniedMapping=await reverseMapping(await freePort()),beforeDenied=accepted,denied=launch(deniedMapping,cert,false);await denied.finished;
  assert.match(denied.output,/未确认此设备授权/);assert.equal(accepted,beforeDenied);assert.equal((await request('/api/forward')).recent[0].code,'reverse_denied');
  const reversePort=await freePort(),reverse=launch(await reverseMapping(reversePort));
  await waitFor(()=>reverse.output.includes('映射已开启'),'Reverse WSS helper did not start');assert.match(reverse.output,/服务器 127\.0\.0\.1/);assert.equal(accepted,beforeDenied);
  console.log('Reverse WSS: verify 8 MiB and client half-close');
  assert.deepEqual(await roundtrip(reversePort,payload),payload);assert.deepEqual(await roundtrip(reversePort,halfClose),Buffer.concat([Buffer.from('after-fin:'),halfClose]));
  assert.equal((await request('/api/forward')).mappings[0].targetStatus.state,'reachable');
  receivedAfterServerFin=undefined;const reverseUploadReply=[],reverseUpload=net.createConnection({host:'127.0.0.1',port:reversePort,allowHalfOpen:true});connections.add(reverseUpload);reverseUpload.on('error',()=>{});reverseUpload.on('data',bytes=>reverseUploadReply.push(bytes));reverseUpload.once('close',()=>connections.delete(reverseUpload));
  console.log('Reverse WSS: verify target half-close and heartbeats');
  await once(reverseUpload,'connect');const reverseEnded=once(reverseUpload,'end');reverseUpload.write('~reverse upload');await reverseEnded;assert.equal(Buffer.concat(reverseUploadReply).toString(),'server-fin');
  await new Promise(resolve=>setTimeout(resolve,31000));assert.equal(reverseUpload.destroyed,false,'Reverse target FIN must retain upload and heartbeats');reverseUpload.end('after reverse heartbeat');
  await waitFor(()=>receivedAfterServerFin,'Reverse upload did not survive target FIN');assert.equal(receivedAfterServerFin.toString(),'~reverse uploadafter reverse heartbeat');reverseUpload.destroy();
  const reverseLive=net.createConnection({host:'127.0.0.1',port:reversePort});connections.add(reverseLive);reverseLive.on('error',()=>{});reverseLive.once('close',()=>connections.delete(reverseLive));await once(reverseLive,'connect');reverseLive.write('reverse once');await once(reverseLive,'data');
  const reverseAccepted=accepted,reverseBytes=receivedBytes,reverseClosed=new Promise(resolve=>reverseLive.once('close',resolve));blockResume=true;for(const socket of controlLinks)socket.destroy();await reverseClosed;
  await waitFor(async()=>(await request('/api/forward')).mappings[0].state==='recovering','Reverse recovery state missing');
  const reverseRefused=net.createConnection({host:'127.0.0.1',port:reversePort});reverseRefused.on('error',()=>{});await new Promise(resolve=>reverseRefused.once('close',resolve));assert.equal(accepted,reverseAccepted);
  blockResume=false;await waitFor(()=>reverse.output.includes('映射已恢复'),'Reverse listener did not recover',500);assert.equal(accepted,reverseAccepted);assert.equal(receivedBytes,reverseBytes);
  assert.equal((reverse.output.match(/反向设备授权：/g)||[]).length,1,'Recovery must retain the original consent scope');
  assert.deepEqual(await roundtrip(reversePort,Buffer.from('new reverse client')),Buffer.from('new reverse client'));
  await request('/api/forward/stop',{id:reverse.mapping.id});await reverse.finished;assert.equal(reverse.output.includes('DATA RACE'),false);
  app.config.webrtc=true;
  console.log('Reverse DTLS: verify direct transfer, fallback and readiness loss');
  const reverseDirectPort=await freePort(),reverseBeforeProbe=accepted,reverseDirect=launch(await reverseMapping(reverseDirectPort));
  await waitFor(()=>reverseDirect.output.includes('映射已开启'),'Reverse direct helper did not start');
  await waitFor(async()=>(await request('/api/forward')).mappings[0].direct.available,'Reverse direct path not ready',1000);assert.equal(accepted,reverseBeforeProbe);
  console.log('Reverse DTLS: 8 MiB and half-close');
  assert.deepEqual(await roundtrip(reverseDirectPort,payload),payload);assert.deepEqual(await roundtrip(reverseDirectPort,halfClose),Buffer.concat([Buffer.from('after-fin:'),halfClose]));
  const reversePinned=net.createConnection({host:'127.0.0.1',port:reverseDirectPort});connections.add(reversePinned);reversePinned.on('error',()=>{});reversePinned.once('close',()=>connections.delete(reversePinned));await once(reversePinned,'connect');reversePinned.write('pinned reverse direct');await once(reversePinned,'data');
  assert.equal((await request('/api/forward')).mappings[0].directConnections,1);
  console.log('Reverse DTLS: keep direct TCP while a new stream falls back to WSS');
  directPeers.at(-1).unhealthy('rtc_health_timeout');await waitFor(()=>reverseDirect.output.includes('直连心跳超时'),'Reverse fallback status missing');
  const reverseFallback=net.createConnection({host:'127.0.0.1',port:reverseDirectPort});connections.add(reverseFallback);reverseFallback.on('error',()=>{});reverseFallback.once('close',()=>connections.delete(reverseFallback));await once(reverseFallback,'connect');reverseFallback.write('reverse WSS fallback');await once(reverseFallback,'data');
  const mixed=(await request('/api/forward')).mappings[0];assert.equal(mixed.directConnections,1);assert.equal(mixed.connections,2);
  await waitFor(async()=>(await request('/api/forward')).mappings[0].direct.available,'Reverse direct health did not recover',500);
  console.log('Reverse DTLS: intentional readiness loss must not dial or retry target');
  const beforeReverseLost=accepted;dropDirectReady=true;const reverseUncertain=net.createConnection({host:'127.0.0.1',port:reverseDirectPort});connections.add(reverseUncertain);reverseUncertain.on('error',()=>{});reverseUncertain.once('close',()=>connections.delete(reverseUncertain));const reverseUncertainClosed=new Promise(resolve=>reverseUncertain.once('close',resolve));reverseUncertain.write('do not retry target');await reverseUncertainClosed;assert.equal(accepted,beforeReverseLost,'Unconfirmed reverse stream must not dial or retry a device');
  for(const [peer,text] of [[reversePinned,'reverse direct stays pinned'],[reverseFallback,'reverse relay stays pinned']]){const reply=once(peer,'data');peer.write(text);assert.equal((await reply)[0].toString(),text);}
  const reverseEnds=[reversePinned,reverseFallback].map(peer=>new Promise(resolve=>peer.once('close',resolve)));await request('/api/forward/stop',{id:reverseDirect.mapping.id});await Promise.all(reverseEnds);await reverseDirect.finished;assert.equal(reverseDirect.output.includes('DATA RACE'),false);
  if(ipv6){
    app.config.webrtcIPv6=true;app.config.webrtcIPv6Address=ipv6;onlySix=true;
    const port=await freePort(),six=launch(await reverseMapping(port,'::1',target6.address().port));await waitFor(()=>six.output.includes('映射已开启'),'Reverse IPv6 helper did not start');
    await waitFor(async()=>(await request('/api/forward')).mappings[0].direct.available,'Reverse IPv6 path not ready',1000);assert.equal((await request('/api/forward')).mappings[0].direct.family,'IPv6');
    assert.deepEqual(await roundtrip(port,Buffer.from('reverse IPv6 device')),Buffer.from('reverse IPv6 device'));await request('/api/forward/stop',{id:six.mapping.id});await six.finished;
  }
  assert.deepEqual(app.inputCalls,[]);assert.deepEqual(app.terminalInputs,[]);assert.equal(app.managementStats.restarts,0);
  console.log('✓ reverse real helper: explicit local consent, TLS/WSS and IPv4/assigned IPv6 UDP/DTLS, 8 MiB, both half-closes, heartbeat, fixed target, single-use accepted sockets, scoped recovery, no target dial during pairing/probes or readiness loss, pinned streams and stop; no real device credentials or Codex input');
  if(!process.env.FORWARD_REVERSE_ONLY)console.log('✓ real TLS/WSS/TCP and UDP/DTLS/SCTP: custom IPv4/IPv6 targets, 8 MiB, half-closes, heartbeat, pinned streams, relay fallback, management resume, 30-second expiry, no pairing/TCP replay, direct rebuild, IPv6 when assigned, revocation and bounded diagnostics; no desktop or Codex input');
  })(),new Promise((_,reject)=>{testDeadline=setTimeout(()=>reject(new Error('Native forwarding verification exceeded seven minutes')),420000);})]);
} finally {
  clearTimeout(testDeadline);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  for(const socket of connections)socket.destroy();
  await app?.close();
  if(tls)await new Promise(resolve=>tls.close(resolve));
  if(target)await new Promise(resolve=>target.close(resolve));
  if(target6)await new Promise(resolve=>target6.close(resolve));
  if(occupied)await new Promise(resolve=>occupied.close(resolve));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
}
