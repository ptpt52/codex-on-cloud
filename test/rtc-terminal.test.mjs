import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { attachRTCTerminal } from '../panel/rtc-terminal.mjs';
import { controlDecoder, sendControl } from '../panel/public/control.js';

async function until(probe) { for (let i = 0; i < 150; i++) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('RTC terminal mock deadline'); }
function attach(app) {
  const records = []; let failures = 0, valid = true;
  const decoder = controlDecoder(value => { records.push(value); if (records.length > 64) records.shift(); }, () => assert.fail('invalid server output'));
  const channel = { readyState: 'open', bufferedAmount: 0, send: bytes => decoder.push(bytes), close() { this.readyState = 'closed'; } };
  const terminal = attachRTCTerminal(channel, { terminalId: 'main', terminalToken: '%0:4000', valid: () => valid, verify: async () => valid,
    readClipboard: async () => '', launch: () => app.config.terminalLaunch({ terminalId: 'main' }) }, () => failures++);
  const send = value => sendControl({ readyState: 'open', bufferedAmount: 0, send: bytes => terminal.receive(Buffer.from(bytes)) }, value);
  return { terminal, channel, records, send, revoke() { valid = false; }, get failures() { return failures; } };
}

test('RTC terminal shares input validation and independent read-only health while idle tracks accepted input', async t => {
  let release, started; const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const app = await fixture({ terminalHook: async () => { started(); await hold; } }); t.after(() => { release(); return app.close(); });
  const current = attach(app); t.after(() => current.terminal.close()); await until(() => current.records.some(value => value.type === 'ready'));
  assert.equal(current.terminal.idle, true); current.send({ type: 'control', id: 1, action: 'key', key: 'Enter' }); await entered;
  assert.equal(current.terminal.idle, false); current.send({ type: 'health', nonce: 1 });
  assert.ok(current.records.some(value => value.type === 'health' && value.nonce === 1)); assert.equal(current.records.some(value => value.type === 'result'), false);
  release(); await until(() => current.terminal.idle); assert.deepEqual(app.terminalInputs, [{ terminalId: 'main', text: '\r' }]);
  current.revoke(); current.send({ type: 'input', id: 2, data: '不能发送' }); assert.equal(current.failures, 1); assert.equal(current.channel.readyState, 'closed');
  current.send({ type: 'input', id: 3, data: '不能重放' }); assert.equal(app.terminalInputs.length, 1); assert.equal(current.failures, 1);
});

test('RTC terminal frames worst-case 32 KiB protected paste separately from Enter and pauses output until render ACK', async t => {
  const app = await fixture(); t.after(() => app.close()); const current = attach(app); t.after(() => current.terminal.close());
  await until(() => current.records.some(value => value.type === 'ready'));
  const initial = current.records.filter(value => value.type === 'output').reduce((sum, value) => sum + Buffer.from(value.data, 'base64').length, 0);
  current.send({ type: 'ack', bytes: initial }); current.records.length = 0;
  current.send({ type: 'control', id: 1, action: 'paste', text: '\b'.repeat(32768), bracketed: true });
  await until(() => current.records.some(value => value.id === 1)); assert.equal(app.terminalInputs.length, 1); assert.equal(Buffer.byteLength(app.terminalInputs[0].text), 32780);
  let rendered = current.records.filter(value => value.type === 'output').reduce((sum, value) => sum + Buffer.from(value.data, 'base64').length, 0);
  current.send({ type: 'ack', bytes: rendered }); current.records.length = 0;
  current.send({ type: 'control', id: 2, action: 'key', key: 'Enter' }); await until(() => current.records.some(value => value.id === 2));
  rendered = current.records.filter(value => value.type === 'output').reduce((sum, value) => sum + Buffer.from(value.data, 'base64').length, 0);
  current.send({ type: 'ack', bytes: rendered }); current.records.length = 0;
  assert.equal(app.terminalInputs[1].text, '\r'); const child = app.terminalChildren[0];
  for (let i = 0; i < 10; i++) child.stdout.write(JSON.stringify({ type: 'output', data: Buffer.alloc(8192, 65).toString('base64') }) + '\n');
  await until(() => child.stdout.isPaused()); rendered = current.records.filter(value => value.type === 'output').reduce((sum, value) => sum + Buffer.from(value.data, 'base64').length, 0);
  current.send({ type: 'ack', bytes: rendered }); await until(() => !child.stdout.isPaused()); assert.equal(current.failures, 0);
});

test('RTC terminal malformed framing, repeated IDs and outbound pressure close only the attached client', async t => {
  const app = await fixture(); t.after(() => app.close());
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385), Buffer.from([0, 4, 0, 1]), Buffer.from([0, 0, 0, 1, 255])]) {
    const current = attach(app); current.terminal.receive(bytes); assert.equal(current.channel.readyState, 'closed'); assert.equal(current.failures, 1);
  }
  let current = attach(app); await until(() => current.terminal.idle);
  current.send({ type: 'resize', id: 1, cols: 100, rows: 20 }); current.send({ type: 'input', id: 1, data: '不能重放' }); assert.equal(current.failures, 1);
  current = attach(app); await until(() => current.terminal.idle); current.channel.bufferedAmount = 256 * 1024 + 1;
  current.send({ type: 'health', nonce: 1 }); assert.equal(current.failures, 1);
  assert.deepEqual(app.terminalInputs, []); assert.equal((await app.controls.get()).session.pid, 4000); assert.equal(app.managementStats.restarts, 0);
});

const offer = { type: 'offer', terminalId: 'main', terminalToken: '%0:4000', sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}`, ''].join('\r\n') };
test('terminal signaling authenticates Host, Origin, CSRF, owner and exact target before allocating PTY', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close());
  const post = options => app.request('/api/terminal/rtc', { method: 'POST', body: offer, ...options });
  assert.equal((await post()).status, 401); await app.login(); assert.equal((await post()).status, 409); await app.claim();
  for (const [headers, status] of [[{ origin: 'https://evil.test' }, 403], [{ 'x-csrf-token': 'bad' }, 403], [{ 'x-viewer-id': '2222222222222222' }, 409]]) assert.equal((await post({ headers })).status, status);
  // fetch ignores a custom Host in this Node runtime; use actual HTTP headers.
  const invalidHost = await new Promise((resolve, reject) => {
    const request = http.request(app.config.origin + '/api/terminal/rtc', { method: 'POST', headers: { host: 'evil.test', origin: app.config.origin,
      cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer, 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end(JSON.stringify(offer));
  });
  assert.equal(invalidHost, 400);
  for (const body of [{}, { ...offer, terminalId: undefined, terminalToken: undefined }, { ...offer, terminalId: '../main' }]) assert.equal((await post({ body })).status, 400);
  assert.equal((await post({ body: { ...offer, terminalToken: '%0:9999' } })).status, 409);
  assert.equal((await post({ body: { ...offer, sdp: 'x'.repeat(50 * 1024) } })).status, 413);
  for (const path of ['/terminal/terminal-rtc.js', '/terminal/terminal-health.js']) assert.equal((await app.request(path)).status, 200);
  assert.equal(app.terminalConnections, 0); assert.equal(app.vncConnections, 0);
});

test('a delayed terminal offer cannot survive takeover and reclaim by the same viewer', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close()); await app.login(); await app.claim();
  const body = JSON.stringify(offer), reading = once(app.panel.server, 'request'); let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/terminal/rtc', { method: 'POST', headers: { origin: app.config.origin, cookie: app.cookie,
      'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.write(body.slice(0, 1));
  });
  await reading; await app.claim('22222222-2222-4222-8222-222222222222'); await app.claim(); request.end(body.slice(1));
  assert.equal(await response, 409); assert.equal(app.terminalConnections, 0); assert.equal(app.vncConnections, 0);
});
