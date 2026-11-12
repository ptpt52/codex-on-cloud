import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Message, methods, classes, parseMessage } from 'werift';

const [mode, serverPid, clientPid, binary] = process.argv.slice(2), children = [];
const stun = dgram.createSocket('udp4'); let requests = 0;
stun.on('message', (bytes, peer) => {
  if (++requests > 128 || bytes.length > 2048) return;
  const request = parseMessage(bytes);
  if (request?.messageClass !== classes.REQUEST || request.messageMethod !== methods.BINDING) return;
  const response = new Message(methods.BINDING, classes.RESPONSE, request.transactionId)
    .setAttribute('XOR-MAPPED-ADDRESS', [peer.address, peer.port]).addFingerprint();
  stun.send(response.bytes, peer.port, peer.address);
});
stun.bind(3478, '13.0.0.1'); await once(stun, 'listening');
function worker(pid, args, env = {}) {
  const child = spawn('nsenter', ['-t', pid, '-n', '--', ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child); let stderr = '', size = 0, stage = 'startup';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  const listeners = new Set(), lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    size += Buffer.byteLength(line); if (size > 131072) { child.kill(); return; }
    if (!line.startsWith('{')) return;
    const value = JSON.parse(line);
    if (value.type === 'stage') { stage = value.stage; return; }
    for (const listener of listeners) listener(value);
  });
  return { child, listeners, write: record => child.stdin.write(JSON.stringify(record) + '\n'), error: () => `[${stage}] ${stderr}` };
}
let server, client;
try {
  server = worker(serverPid, [process.execPath, 'test/rtc-nat-peer.mjs', 'answer', mode]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('answer worker startup timeout: ' + server.error())), 10000);
    server.listeners.add(value => { if (value.type === 'ready') { clearTimeout(timer); resolve(); } });
    server.child.once('exit', code => { clearTimeout(timer); reject(Error(`answer worker exited ${code}: ${server.error()}`)); });
  });
  client = mode === 'go' ? worker(clientPid, [binary, '-test.run', '^TestNATPeerWorker$'], { FORWARD_NAT_WORKER: '1' })
    : worker(clientPid, [process.execPath, 'test/rtc-nat-peer.mjs', 'browser', mode]);
  let offers = 0, answers = 0;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('NAT flow timeout: ' + server.error() + client.error())), 35000);
    const fail = error => { clearTimeout(timer); reject(Error(`${error.message}; offers=${offers}, answers=${answers}; server ${server.error()}; client ${client.error()}`)); };
    client.listeners.add(value => {
      if (['offer', 'rtc_offer'].includes(value.type)) { offers++; server.write(value); }
      else if (value.type === 'done') { clearTimeout(timer); resolve(value); }
      else if (value.type === 'error') fail(Error(value.message));
    });
    server.listeners.add(value => {
      if (['answer', 'rtc_answer'].includes(value.type)) answers++;
      if (['answer', 'rtc_answer', 'rtc_status'].includes(value.type)) client.write(value);
      else if (value.type === 'error') fail(Error(value.message));
    });
    for (const peer of [server, client]) peer.child.once('exit', code => { if (code) fail(Error(`worker exited ${code}: ${peer.error()}`)); });
  });
  assert.ok(requests >= 2); assert.equal(offers, 1); assert.equal(answers, 1);
  assert.equal(result.blocked === true, mode === 'blocked');
  if (mode !== 'blocked') assert.equal(result.bytes, 262144);
  console.log(`✓ actual isolated Linux SNAT: ${mode === 'go' ? 'Go/Pion helper' : mode === 'browser' ? 'Chrome/werift' : 'UDP-blocked Chrome'}; ${result.bytes || 0} encrypted bytes; ${requests} STUN queries`);
} finally {
  for (const child of children) child.stdin.end();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  stun.close();
}
