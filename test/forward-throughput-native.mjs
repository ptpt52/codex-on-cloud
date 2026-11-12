// Opt-in measurement: real Go/Pion + werift, loopback TCP echo, isolated panel.
// This measures local transport throughput, not a physical LAN or WAN link.
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { createForwardPeer } from '../panel/forward-rtc.mjs';

const exec = promisify(execFile);
const sockets = new Set(), block = Buffer.alloc(65536, 91), bytes = 8 * 1024 * 1024;
const expected = createHash('sha256'); for (let at = 0; at < bytes; at += block.length) expected.update(block);
const digest = expected.digest('hex');
let app, helper, echo, output = '', directOpens = 0;
const window = Number(process.env.FORWARD_BENCH_WINDOW || 8);
assert.ok([4, 8, 16].includes(window), 'FORWARD_BENCH_WINDOW must be 4, 8 or 16');
const directory = await mkdtemp(join(tmpdir(), 'codex-forward-bench-'));
const until = async probe => { const end = Date.now() + 45000; while (!await probe()) { if (Date.now() >= end) throw Error('benchmark readiness timeout'); await new Promise(resolve => setTimeout(resolve, 25)); } };
const freePort = async () => { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
async function connect(port) { const socket = net.connect(port, '127.0.0.1'); sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); await once(socket, 'connect'); return socket; }
async function transfer(port) {
  const socket = await connect(port), hash = createHash('sha256'); let received = 0;
  socket.on('error', error => { error.message += ` (received ${received}/${bytes})`; });
  socket.setTimeout(90000, () => socket.destroy(Error('benchmark transfer timeout')));
  socket.on('data', data => { received += data.length; hash.update(data); });
  const end = once(socket, 'end');
  void end.catch(() => {});
  for (let at = 0; at < bytes; at += block.length) if (!socket.write(block)) await once(socket, 'drain');
  socket.end(); await end; socket.destroy();
  assert.equal(received, bytes); assert.equal(hash.digest('hex'), digest);
}
async function probe(socket) {
  const data = once(socket, 'data'), start = performance.now(); socket.write('probe');
  assert.equal((await data)[0].toString(), 'probe'); return performance.now() - start;
}
async function helperCPU() {
  const text = await readFile(`/proc/${helper.pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return (Number(fields[11]) + Number(fields[12])) / 100; // Linux CLK_TCK=100, checked below.
}
try {
  assert.equal((await exec('getconf', ['CLK_TCK'])).stdout.trim(), '100');
  await exec('go', ['build', '-p', '2', '-mod=readonly', '-o', join(directory, 'helper'), '.'], { cwd: new URL('../client/forward/', import.meta.url), env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 150000, maxBuffer: 16384 });
  echo = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket); });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  app = await fixture({ webrtc: true, forwardPorts: '*', forwardPeerFactory(options) {
    const peer = createForwardPeer({ ...options, maxWindow: window, connect(...args) { directOpens++; options.connect(...args); } });
    const destroy = peer.destroy; peer.destroy = reason => { if (reason && reason !== 'rtc_unavailable') console.error('benchmark peer retired:',reason); return destroy(reason); }; return peer;
  } }); await app.login(); await app.claim();
  const listing = async () => (await (await app.request('/api/forward/agents')).json()).agents[0];
  const agent = await listing(), key = await (await app.request('/api/forward/agents/key?id=' + agent.id)).json();
  helper = spawn(join(directory, 'helper'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' } });
  helper.on('error', error => { output = error.message; });
  for (const stream of [helper.stdout, helper.stderr]) stream.on('data', data => { output = (output + data).slice(-16384); });
  helper.stdin.end(key.key + '\n'); await until(async () => (await listing()).online);
  const bulk = await freePort(), interactive = await freePort();
  for (const [name, port] of [['bulk', bulk], ['interactive', interactive]]) {
    const response = await app.request('/api/forward/agents/rule', { method: 'POST', body: { agentId: agent.id, name, enabled: true, config: { localPort: port, targetHost: '127.0.0.1', targetPort: echo.address().port } } });
    assert.equal(response.status, 200);
  }
  await until(async () => (await listing()).rules.every(rule => rule.mapping?.direct.available));
  const latency = await connect(interactive); latency.setTimeout(10000, () => latency.destroy(Error('benchmark probe timeout'))); await probe(latency);
  for (const streams of [1, 4, 8]) {
    await until(async () => (await listing()).rules.find(rule => rule.config.localPort === bulk).mapping.connections === 0);
    const samples = []; let sampling = true;
    const measuring = (async () => { while (sampling) { if (samples.length >= 3000) throw Error('probe sample bound'); samples.push(await probe(latency)); await new Promise(resolve => setTimeout(resolve, 50)); } })();
    void measuring.catch(() => {});
    const cpu = process.cpuUsage(), helperStart = await helperCPU(), start = performance.now(), opened = directOpens;
    try { await Promise.all(Array.from({ length: streams }, () => transfer(bulk))); }
    finally { sampling = false; }
    const elapsed = (performance.now() - start) / 1000, used = process.cpuUsage(cpu), helperSeconds = await helperCPU() - helperStart;
    await measuring; samples.sort((a, b) => a - b);
    assert.equal(directOpens - opened, streams, 'measurement must stay on RTC');
    const rule = (await listing()).rules.find(rule => rule.config.localPort === bulk);
    console.log(JSON.stringify({ transport: 'actual Pion/werift loopback echo', streams, MiB: streams * bytes / 1048576, seconds: +elapsed.toFixed(3), MiBps: +(streams * bytes / 1048576 / elapsed).toFixed(2), probeP95ms: +samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(2), nodeCPUPercent: +((used.user + used.system) / elapsed / 10000).toFixed(1), helperCPUPercent: +(helperSeconds / elapsed * 100).toFixed(1), window: rule.mapping.direct.window || 4 }));
    await until(async () => (await listing()).rules.find(rule => rule.config.localPort === bulk).mapping.connections === 0);
  }
  assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
} catch (error) { console.error(output.slice(-4000)); throw error; }
finally {
  for (const socket of sockets) socket.destroy();
  if (helper && helper.exitCode === null && helper.signalCode === null) {
    const done = once(helper, 'exit'); helper.kill('SIGTERM');
    const guard = setTimeout(() => helper.kill('SIGKILL'), 5000); await done; clearTimeout(guard);
  }
  await app?.close(); if (echo) await new Promise(resolve => echo.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
