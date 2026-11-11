// Actual Linux helper processes, loopback WS controls, TCP and Pion/werift data
// channels. Desktop/PTY services are isolated fixtures; no real device is opened.
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { createPanel } from '../panel/server.mjs';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-managed-native-'));
const binary = join(directory, 'helper'), children = [], sockets = [];
const until = async (probe, label, timeout = 18000) => { const end = Date.now() + timeout; while (!await probe()) { if (Date.now() > end) throw Error(label); await new Promise(r => setTimeout(r, 25)); } };
const freePort = async () => { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; };
const post = async (app, path, body) => { const response = await app.request('/api/forward/agents/' + path, { method: 'POST', body }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
const listing = async app => (await app.request('/api/forward/agents')).json();
function start(key) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' } }), value = { child, output: '', errors: '', exit: null };
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
let app, echo, replacement; let accepted = 0;
try {
  await exec('go', ['build', '-p', '2', '-race', '-mod=readonly', '-o', binary, '.'], { cwd: new URL('../client/forward/', import.meta.url), env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 150000, maxBuffer: 16384 });
  echo = net.createServer(socket => { accepted++; sockets.push(socket); socket.on('error', () => {}); socket.pipe(socket); }); echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  app = await fixture({ webrtc: true, forwardPorts: '*' }); await app.login(); await app.claim();
  const slots = (await listing(app)).agents;
  const a = { ...slots[0], ...await (await app.request('/api/forward/agents/key?id=' + slots[0].id)).json() }, b = { ...slots[1], ...await (await app.request('/api/forward/agents/key?id=' + slots[1].id)).json() };
  let aControl;
  app.panel.server.on('upgrade', (req, socket) => { if (req.url === '/forward/agent' && req.headers.authorization?.startsWith('Bearer ' + a.id + '.')) aControl = socket; });
  const helperA = start(a.key), helperB = start(b.key);
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.online), 'helpers did not connect');
  const firstPort = await freePort(), secondPort = await freePort(), thirdPort = await freePort();
  const target = { targetHost: '127.0.0.1', targetPort: echo.address().port };
  const first = await post(app, 'rule', { agentId: a.id, name: 'A-SSH', enabled: true, config: { ...target, localPort: firstPort } });
  let second = await post(app, 'rule', { agentId: a.id, name: 'A-设备', enabled: true, config: { direction: 'reverse', protocol: 'tcp', deviceName: '设备', ...target, localPort: secondPort } });
  await post(app, 'rule', { agentId: b.id, name: 'B-SSH', enabled: true, config: { ...target, localPort: thirdPort } });
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.rules.every(r => r.state === 'active')), 'rules did not activate');
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.inventory?.interfaces.some(i => i.addresses.some(ip => ip.address === '127.0.0.1'))), 'IPv4 interface inventory missing');
  await until(async () => (await listing(app)).agents.slice(0, 2).every(a => a.rules.every(r => r.mapping.direct.available)), 'actual Pion/werift direct paths missing', 45000);
  const one = await connect(firstPort), two = await connect(secondPort), three = await connect(thirdPort);
  await exchange(one, 'A 正向直连\n'); await exchange(two, 'A 反向直连\n'); await exchange(three, 'B 独立直连\n');
  const before = await listing(app);
  const aMapping = before.agents.find(value => value.id === a.id).rules.find(r => r.id === first.id).mapping.id;
  const originalAccepted = accepted; assert.equal(originalAccepted, 3);
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
  const panelPort = app.panel.server.address().port;
  await app.panel.close(); app.config.webrtc = false;
  replacement = await createPanel(app.config); replacement.server.listen(panelPort, '127.0.0.1'); await once(replacement.server, 'listening');
  await app.login(); await app.claim();
  await until(async () => { const agent = (await listing(app)).agents[1]; return agent?.online && agent.rules[0]?.state === 'active'; }, 'saved rules did not recover after a panel restart');
  await until(() => three.destroyed, 'panel restart retained an old TCP stream');
  const relayed = await connect(thirdPort); await exchange(relayed, '节点重启后按保存规则新建中转 TCP\n');
  const restored = (await listing(app)).agents[1].rules[0].mapping; assert.equal(restored.directConnections, 0); assert.equal(restored.connections, 1);
  assert.equal(helperB.exit, null); assert(!helperA.output.includes(a.key)); assert(!helperB.output.includes(b.key));
  assert(helperA.output.includes('正在被控制台节点控制')); assert(helperA.output.includes('A-SSH')); assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
  console.log('✓ two real helpers, forward/reverse Pion paths, NIC inventory, isolated edits, preserved TCP during control reconnect, key revocation and saved rules restored over relay after panel restart');
} catch (error) {
  for (const child of children) console.error(child.output.slice(-6000), child.errors.slice(-2000)); throw error;
} finally {
  for (const child of children) child.child.kill('SIGINT');
  await until(() => children.every(c => c.exit), 'helper shutdown deadline', 10000).catch(() => { for (const c of children) c.child.kill('SIGKILL'); });
  for (const socket of sockets) socket.destroy(); await replacement?.close(); await app?.close(); if (echo) await new Promise(r => echo.close(r)); await rm(directory, { recursive: true, force: true });
}
