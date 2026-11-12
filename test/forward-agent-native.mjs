// Actual Linux helper processes, loopback WS controls, TCP and Pion/werift data
// channels. Desktop/PTY services are isolated fixtures; no real device is opened.
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { uiSnapshot } from './support/ui-snapshot.mjs';
import { createPanel } from '../panel/server.mjs';
import { createForwardPeer } from '../panel/forward-rtc.mjs';
import { createFlowBudget } from '../panel/flow-budget.mjs';
import { rtcAddress, rtcIPv6Address } from '../panel/rtc.mjs';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-managed-native-'));
const snapshot = await uiSnapshot();
const binary = join(directory, 'helper'), children = [], sockets = [];
const tlsMode = process.env.FORWARD_TEST_TLS === '1', entryPath = process.env.FORWARD_TEST_ENTRY || '/';
const certificate = join(directory, 'certificate.pem'), privateKey = join(directory, 'key.pem');
let tlsServer; const proxySockets = new Set();
const until = async (probe, label, timeout = 18000) => { const end = Date.now() + timeout; while (!await probe()) { if (Date.now() > end) throw Error(label); await new Promise(r => setTimeout(r, 25)); } };
const freePort = async () => { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; };
const post = async (app, path, body) => { const response = await app.request('/api/forward/agents/' + path, { method: 'POST', body }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
const listing = async app => (await app.request('/api/forward/agents')).json();
function start(key, certFile = certificate) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...(tlsMode ? { SSL_CERT_FILE: certFile } : {}) } }), value = { child, output: '', errors: '', exit: null };
  children.push(value); child.on('error', error => { value.errors += error.message; });
  child.stdout.on('data', b => { value.output = (value.output + b).slice(-65536); }); child.stderr.on('data', b => { value.errors = (value.errors + b).slice(-65536); });
  child.once('exit', (code, signal) => { value.exit = { code, signal }; }); child.stdin.end(key + '\n'); return value;
}
async function connect(port) { const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); sockets.push(socket); await once(socket, 'connect'); return socket; }
async function exchange(socket, text) {
  const expected = Buffer.from(text), chunks = []; let length = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { finish(); reject(Error('TCP data deadline')); }, 8000);
    const data = bytes => { chunks.push(bytes); length += bytes.length; if (length >= expected.length) { finish(); resolve(); } };
    const gone = () => { finish(); reject(Error('TCP closed')); };
    const finish = () => { clearTimeout(timer); socket.off('data', data); socket.off('close', gone); };
    socket.on('data', data); socket.once('close', gone); socket.write(expected);
  });
  assert.deepEqual(Buffer.concat(chunks), expected);
}
let app, echo, echo6, replacement; let onlySix = false; let accepted = 0;
let releaseNegotiation, holdFirstNegotiation = !tlsMode;
const pooledPeers = [], transportUpgrades = [], currentPeers = new Map(), peerBudgets = new Map();
const initialNegotiation = new Promise(resolve => { releaseNegotiation = resolve; });
function nativePeer(options) {
  pooledPeers.push(options.shared === true);
  const flowBudget=createFlowBudget();peerBudgets.set(options.helperId,flowBudget);
  const peer = createForwardPeer({...options,flowBudget}), answer = peer.answer, ipv6Only = onlySix;
  if (options.shared) currentPeers.set(options.helperId, peer);
  const filter = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || line.split(' ')[4]?.includes(':')).join('\r\n');
  peer.answer = async offer => {
    if (holdFirstNegotiation) { holdFirstNegotiation = false; await initialNegotiation; }
    return ipv6Only ? filter(await answer({ ...offer, sdp: filter(offer.sdp) })) : answer(offer);
  };
  return peer;
}
try {
  await exec('go', ['build', '-p', '2', '-race', '-mod=readonly', '-o', binary, '.'], { cwd: new URL('../client/forward/', import.meta.url), env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 150000, maxBuffer: 16384 });
  echo = net.createServer(socket => { accepted++; sockets.push(socket); socket.on('error', () => {}); socket.pipe(socket); }); echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  app = await fixture({ uiRoot: snapshot.root, webrtc: !tlsMode, forwardPorts: '*', entryBasePath: entryPath, forwardPeerFactory: nativePeer, ...(entryPath !== '/' ? { nodeId: 'a'.repeat(32) } : {}) }); await app.login(); await app.claim();
  if (tlsMode) {
    await exec('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateKey,'-out',certificate,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { timeout: 10000, maxBuffer: 8192 });
    const backendPort = app.panel.server.address().port;
    tlsServer = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, (_req,res) => { res.writeHead(404);res.end(); });
    tlsServer.on('tlsClientError', () => {});
    tlsServer.on('upgrade', (req, socket, head) => {
      const upstream = net.connect(backendPort, '127.0.0.1');
      for (const item of [socket,upstream]) { proxySockets.add(item); item.on('error',()=>{socket.destroy();upstream.destroy();});item.once('close',()=>{proxySockets.delete(item);socket.destroy();upstream.destroy();}); }
      upstream.once('connect',()=>{ upstream.write(req.method+' '+req.url+' HTTP/1.1\r\n'+Object.entries(req.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket); });
    });
    tlsServer.listen(0,'127.0.0.1');await once(tlsServer,'listening');app.config.origin='https://127.0.0.1:'+tlsServer.address().port;app.config.hosts.add(new URL(app.config.origin).host);
    app.request = (path,{method='GET',body}={}) => new Promise((resolve,reject)=>{
      const payload=body===undefined?null:JSON.stringify(body), req=http.request({hostname:'127.0.0.1',port:backendPort,path:app.entryPath(path),method,headers:{host:new URL(app.config.origin).host,origin:app.config.origin,cookie:app.cookie,'x-csrf-token':app.csrf,'x-viewer-id':app.viewer,...(app.config.nodeId?{'x-codex-node':app.config.nodeId}:{}),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},res=>{
        let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>512*1024)res.destroy(Error('response bound'));else chunks.push(b);});res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
      });req.on('error',reject);req.end(payload);
    });
  }

  const slots = (await listing(app)).agents;
  const a = { ...slots[0], ...await (await app.request('/api/forward/agents/key?id=' + slots[0].id)).json() }, b = { ...slots[1], ...await (await app.request('/api/forward/agents/key?id=' + slots[1].id)).json() };
  let aControl;
  app.panel.server.on('upgrade', (req, socket) => {
    if (req.url === app.entryPath('/forward/agent') && req.headers.authorization?.startsWith('Bearer ' + a.id + '.')) aControl = socket;
    if (req.url === app.entryPath('/forward/transport')) transportUpgrades.push({ agent: req.headers.authorization?.split('.')[0].slice(7), socket });
    assert.notEqual(req.url, app.entryPath('/forward/data'), 'managed TCP must reuse pooled WSS rather than upgrade per stream');
  });
  const helperA = start(a.key), helperB = start(b.key);
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.online), 'helpers did not connect');
  const firstPort = await freePort(), secondPort = await freePort(), thirdPort = await freePort();
  const target = { targetHost: '127.0.0.1', targetPort: echo.address().port };
  const first = await post(app, 'rule', { agentId: a.id, name: 'A-Web', enabled: true, config: { ...target, protocol: 'http', localPort: firstPort } });
  let second = await post(app, 'rule', { agentId: a.id, name: 'A-设备', enabled: true, config: { direction: 'reverse', protocol: 'https', deviceName: '设备', ...target, localPort: secondPort } });
  await post(app, 'rule', { agentId: b.id, name: 'B-SSH', enabled: true, config: { ...target, localPort: thirdPort } });
  if (!tlsMode) {
    // Two rules in A share a peer. Only B competes for the negotiation slot.
    // Recovery must handle real contention, not depend on runner scheduling.
    await until(async () => (await listing(app)).agents.slice(0, 2).some(a => a.rules.some(r => r.mapping?.direct.reason === 'rtc_busy')), 'simultaneous helpers did not exercise busy rejection', 10000);
    releaseNegotiation();
  }
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.rules.every(r => r.state === 'active')), 'rules did not activate');
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.inventory?.interfaces.some(i => i.addresses.some(ip => ip.address === '127.0.0.1'))), 'IPv4 interface inventory missing');
  if (!tlsMode) await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.rules.every(r => r.mapping.direct.available)), 'actual Pion/werift direct paths missing', 45000);
  const one = await connect(firstPort), two = await connect(secondPort), three = await connect(thirdPort);
  await exchange(one, 'A 正向直连\n'); await exchange(two, 'A 反向直连\n'); await exchange(three, 'B 独立直连\n');
  assert.equal(transportUpgrades.length, 2, 'one WSS standby per helper');
  if (!tlsMode) assert.deepEqual(pooledPeers, [true, true], 'A forward and reverse rules share one real peer');
  const extraRules = [];
  for (let i = 0; i < 4; i++) extraRules.push(await post(app, 'rule', { agentId: a.id, name: '共享规则' + i, enabled: true, config: { ...target, localPort: await freePort() } }));
  await until(async () => (await listing(app)).agents[0].rules.every(r => r.state === 'active' && (tlsMode || r.mapping.direct.available)), 'six rules did not share the helper transport');
  for (const [index, rule] of extraRules.entries()) {
    for (let client = 0; client < 6; client++) {
      const extra = await connect(rule.config.localPort); await exchange(extra, `共享规则 ${index} / TCP ${client}\n`);
    }
  }
  const sharedMappings = (await listing(app)).agents[0].rules.map(rule => rule.mapping);
  if (!tlsMode) assert(sharedMappings.every(mapping => mapping.direct.window === 8), 'all rules use the authenticated negotiated window');
  assert.equal(sharedMappings.reduce((sum, mapping) => sum + mapping.connections, 0), 26);
  assert.equal(sharedMappings.reduce((sum, mapping) => sum + mapping.directConnections, 0), tlsMode ? 0 : 24, 'excess streams reuse WSS without draining the shared RTC');
  for (const rule of extraRules) await post(app, 'rule/remove', { agentId: a.id, id: rule.id, revision: rule.revision });
  await exchange(one, '删除共享规则不关闭其他规则\n');
  if (!tlsMode) {
    const budget=peerBudgets.get(a.id),peer=currentPeers.get(a.id),charge=384*1024;
    await until(()=>budget.used===0,'previous direct credits did not drain');
    assert.equal(budget.acquire(Symbol(),charge),true);
    try {
      for(const port of [firstPort,secondPort]) {
        const original=(await listing(app)).agents[0].rules.find(r=>r.config.localPort===port).mapping,before=accepted;
        const busy=await connect(port);await exchange(busy,'RTC 满额的新连接使用 WSS，目标只打开一次\n');
        const current=(await listing(app)).agents[0].rules.find(r=>r.config.localPort===port).mapping;
        assert.equal(current.connections,original.connections+1);assert.equal(current.directConnections,original.directConnections);
        assert.equal(accepted,before+1,'capacity preflight must not open a target before WSS fallback');
        assert.equal(currentPeers.get(a.id),peer);assert.equal(peer.state.available,true);
        await exchange(one,'共享额度满时原直连小消息继续\n');await exchange(two,'原反向直连也保留\n');
        busy.destroy();await until(async()=>(await listing(app)).agents[0].rules.find(r=>r.config.localPort===port).mapping.connections===original.connections,'WSS capacity fallback did not close');
      }
    } finally { budget.release(charge,charge); }
    assert.equal(pooledPeers.length, 2);
    const oldStandby = transportUpgrades.find(value => value.agent === a.id).socket;
    oldStandby.destroy();
    await exchange(one, 'WSS 备用断开时直连不受影响\n');
    const fresh = await connect(firstPort); await exchange(fresh, '备用恢复期间新 TCP 仍直连\n'); fresh.destroy();
    await until(() => transportUpgrades.filter(value => value.agent === a.id).length === 2, 'pooled WSS standby did not reconnect');
    assert.equal(pooledPeers.length, 2, 'WSS recovery must not rebuild the healthy RTC');
  }
  const css = new URL('styles.css', snapshot.root), beforeRevision = app.panel.uiRevision, beforePublication = accepted;
  await writeFile(css, (await readFile(css, 'utf8')) + '\n/* isolated live publication */');
  await app.panel.reloadUI(); assert.notEqual(app.panel.uiRevision, beforeRevision);
  await exchange(one, '网页发布保留正向 TCP\n'); await exchange(two, '网页发布保留反向 TCP\n'); await exchange(three, '网页发布保留另一助手 TCP\n');
  assert.equal(accepted, beforePublication); assert.equal((await (await app.request('/api/forward/agents/key?id=' + a.id)).json()).key, a.key);
  if (tlsMode) {
    const large = Buffer.alloc(8 * 1024 * 1024, 173), channel = await connect(firstPort);let total=0;const parts=[];
    channel.on('data',bytes=>{total+=bytes.length;if(total>large.length)channel.destroy(Error('echo bound'));parts.push(bytes);});
    const ended=once(channel,'end');channel.end(large);await ended;assert.deepEqual(Buffer.concat(parts),large);channel.destroy();
    const invalidKey = (await (await app.request('/api/forward/agents/key?id='+(await listing(app)).agents[2].id)).json()).key;
    const untrusted = start(invalidKey, join(directory,'missing-ca'));await until(()=>untrusted.exit,'untrusted TLS did not fail');assert.notEqual(untrusted.exit.code,0);assert(untrusted.errors.includes('证书'));
  }
  if (!tlsMode && entryPath === '/') {
    const ipv6 = rtcIPv6Address(undefined, rtcAddress());
    if (ipv6) {
      onlySix = true;app.config.webrtcIPv6=true;app.config.webrtcIPv6Address=ipv6;
      echo6=net.createServer(socket=>{sockets.push(socket);socket.on('error',()=>{});socket.pipe(socket);});echo6.listen(0,'::1');await once(echo6,'listening');
      const c=(await listing(app)).agents[2],key=(await(await app.request('/api/forward/agents/key?id='+c.id)).json()).key;start(key);
      const port=await freePort();await post(app,'rule',{agentId:c.id,name:'IPv6通道',enabled:true,config:{localPort:port,targetHost:'::1',targetPort:echo6.address().port}});
      await until(async()=>{const rule=(await listing(app)).agents[2].rules[0];return rule?.mapping?.direct.available&&rule.mapping.direct.family==='IPv6';},'actual IPv6 direct path unavailable',45000);
      const stream=await connect(port);await exchange(stream,'真实IPv6 UDP/DTLS与IPv6目标\n');
      console.log('✓ actual assigned global IPv6 UDP/DTLS path and IPv6 TCP target');
      onlySix=false;
    } else console.log('SKIP assigned global IPv6 path: no address available');
  }
  const before = await listing(app);
  const aMapping = before.agents.find(value => value.id === a.id).rules.find(r => r.id === first.id).mapping.id;
  const originalAccepted = accepted; assert.equal(originalAccepted, tlsMode ? 28 : 30);
  const unsupported = await post(app, 'rule', { agentId: a.id, name: '无效串口', enabled: true, config: { direction: 'reverse', protocol: 'serial', deviceName: '测试设备', localPort: await freePort(), serial: { path: 'COM9999', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false } } });
  await until(async () => (await listing(app)).agents.find(value => value.id === a.id).rules.find(r => r.id === unsupported.id)?.state === 'failed', 'invalid serial target stopped the whole helper');
  await exchange(one, '无效串口不影响其他规则\n'); await exchange(three, '另一个助手仍然健康\n'); assert.equal(accepted, originalAccepted);
  await post(app, 'rule/remove', { agentId: a.id, id: unsupported.id, revision: unsupported.revision });
  aControl.destroy();
  await until(async () => !(await listing(app)).agents.find(value => value.id === a.id).online, 'control loss not observed', 3000);
  await until(async () => (await listing(app)).agents.find(value => value.id === a.id).online, 'helper control did not reconnect');
  assert.equal((await listing(app)).agents.find(value => value.id === a.id).rules.find(r => r.id === first.id).mapping.id, aMapping);
  await exchange(one, '控制重连后保持原 TCP\n'); await exchange(three, '另一个助手不受影响\n'); assert.equal(accepted, originalAccepted);
  const nextPort = await freePort();
  second = await post(app, 'rule', { agentId: a.id, id: second.id, revision: second.revision, name: second.name, enabled: true, config: { ...second.config, localPort: nextPort } });
  await until(() => two.destroyed, 'changed rule did not close its old TCP');
  await until(async () => (await listing(app)).agents.find(value => value.id === a.id).rules.find(r => r.id === second.id).state === 'active', 'edited rule did not apply');
  await exchange(one, '修改另一规则不影响本连接\n'); await exchange(three, 'B 继续可用\n');
  const next = await connect(nextPort); await exchange(next, '新规则入口\n');
  await post(app, 'rule/remove', { agentId: a.id, id: second.id, revision: second.revision }); await until(() => next.destroyed, 'removed rule remained active');
  await post(app, 'rekey', { id: a.id, revision: a.keyRevision }); await until(() => helperA.exit, 'revoked helper did not exit');
  await until(() => one.destroyed, 'revoked helper retained a TCP connection'); await exchange(three, '撤销 A 后 B 保持运行\n');
  let fallback = three;
  if (!tlsMode) {
    await currentPeers.get(b.id).destroy('rtc_unavailable');
    await until(() => three.destroyed, 'failed RTC retained its old business TCP');
    fallback = await connect(thirdPort); await exchange(fallback, '直连失效后复用已认证 WSS 备用\n');
    const mapping = (await listing(app)).agents[1].rules[0].mapping;
    assert.equal(mapping.directConnections, 0); assert.equal(mapping.connections, 1);
    assert.equal(transportUpgrades.filter(value => value.agent === b.id).length, 1, 'fallback must reuse the warm WSS');
  }
  const panelPort = app.panel.server.address().port;
  await app.panel.close(); app.config.webrtc = false;
  replacement = await createPanel(app.config); replacement.server.listen(panelPort, '127.0.0.1'); await once(replacement.server, 'listening');
  await app.request('/api/desktop/claim', { method: 'POST', body: { viewer: app.viewer } });
  await until(async () => { const agent = (await listing(app)).agents[1]; return agent?.online && agent.rules[0]?.state === 'active'; }, 'saved rules did not recover after a panel restart');
  await until(() => fallback.destroyed, 'panel restart retained an old TCP stream');
  const relayed = await connect(thirdPort); await exchange(relayed, '节点重启后按保存规则新建中转 TCP\n');
  const restored = (await listing(app)).agents[1].rules[0].mapping; assert.equal(restored.directConnections, 0); assert.equal(restored.connections, 1);
  assert.equal(helperB.exit, null); assert(!helperA.output.includes(a.key)); assert(!helperB.output.includes(b.key));
  // macOS Terminal closes with SIGHUP. Exercise the same Unix signal on the
  // real Linux helper, including cleanup of the active mapping.
  helperB.child.kill('SIGHUP');
  await until(() => helperB.exit, 'terminal hangup did not stop the helper');
  assert.deepEqual(helperB.exit, { code: 0, signal: null });
  await until(async () => !(await listing(app)).agents[1].online, 'terminal hangup retained online status');
  await until(() => relayed.destroyed, 'terminal hangup retained an active mapping');
  assert(helperA.output.includes('正在被控制台节点控制')); assert(helperA.output.includes('A-Web')); assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
  console.log('✓ two real helpers, '+(tlsMode?'TLS/WSS 8 MiB and certificate validation':'forward/reverse Pion paths')+', '+entryPath+', NIC inventory, live UI publication, isolated edits, preserved TCP during control reconnect, key revocation and saved rules restored over relay after panel restart');
} catch (error) {
  for (const child of children) console.error(child.output.slice(-6000), child.errors.slice(-2000)); throw error;
} finally {
  releaseNegotiation();
  for (const child of children) child.child.kill('SIGINT');
  await until(() => children.every(c => c.exit), 'helper shutdown deadline', 10000).catch(() => { for (const c of children) c.child.kill('SIGKILL'); });
  for (const socket of sockets) socket.destroy(); for (const socket of proxySockets) socket.destroy(); if(tlsServer)await new Promise(resolve=>tlsServer.close(resolve)); await replacement?.close(); await app?.close(); if (echo) await new Promise(r => echo.close(r)); if (echo6) await new Promise(r=>echo6.close(r)); await rm(directory, { recursive: true, force: true }); await rm(snapshot.directory, { recursive: true, force: true });
}
