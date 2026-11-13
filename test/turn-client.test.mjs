import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestTurnCredentials, validateTurnResponse, createTurnCache } from '../panel/turn-client.mjs';
import { rtcOffer } from '../panel/rtc-network.mjs';
import { rtcIceServers } from '../panel/public/rtc-ice.js';
import { fixture } from './fixture.mjs';

const now = Date.now();
const iceServers = [
  { urls: ['stun:desk.example.test:3478'] },
  { urls: ['turn:desk.example.test:3478?transport=udp', 'turn:desk.example.test:3478?transport=tcp', 'turns:desk.example.test:5349?transport=tcp'], username: '200:signed', credential: 'short-secret' },
];

test('TURN status reads stay nonblocking, coalesce refreshes and retain only unexpired credentials through failure backoff', async () => {
  let time = 100000, release, reject, calls = 0;
  const cache = createTurnCache(() => { calls++; return new Promise((ok, fail) => { release = ok; reject = fail; }); }, () => time);
  try {
    assert.equal(await cache.read({ wait: false }), null); assert.equal(calls, 1);
    assert.equal(await cache.read({ wait: false }), null); assert.equal(calls, 1);
    const first = cache.read(); release({ expiresAt: time + 120000, iceServers });
    const saved = await first; assert.deepEqual(saved.iceServers, iceServers);
    time += 61000;
    assert.equal(await cache.read({ wait: false }), saved); assert.equal(calls, 2);
    const waiting = cache.read(); reject(Error('center unavailable')); assert.equal(await waiting, saved);
    time += 14000; assert.equal(await cache.read(), saved); assert.equal(calls, 2);
    time += 1000; const retry = cache.read(); await Promise.resolve(); assert.equal(calls, 3);
    release({ expiresAt: time + 61000, iceServers }); await retry;
    time += 62000; const expired = cache.read({ wait: false }); assert.equal(await expired, null);
    const last = cache.read(); reject(Error('offline')); assert.equal(await last, null);
    assert.equal(await cache.read(), null); assert.equal(calls, 4);
  } finally { cache.close(); }
});

test('closing a TURN cache cancels its sole refresh and cannot publish a late result', async () => {
  let release, signal;
  const cache = createTurnCache(value => { signal = value; return new Promise(resolve => { release = resolve; }); });
  const pending = cache.read(); await Promise.resolve(); cache.close(); assert.equal(signal.aborted, true);
  release({ expiresAt: Date.now() + 3600000, iceServers }); assert.equal(await pending, null); assert.equal(await cache.read(), null);
});

test('TURN responses accept only bounded STUN/TURN URLs and short-lived credentials', async () => {
  const value = validateTurnResponse({ expiresAt: now + 3600000, ttlMs: 3600000, iceServers }, now);
  assert.deepEqual(value.iceServers, iceServers);
  for (const bad of [
    { expiresAt: now + 3700000, ttlMs: 3600000, iceServers },
    { expiresAt: now + 3600000, ttlMs: 3600000, iceServers: [{ urls: ['https://evil.test'] }] },
    { expiresAt: now + 3600000, ttlMs: 3600000, iceServers: [{ urls: ['turn:desk.example.test:3478?transport=udp'] }] },
    { expiresAt: now + 3600000, ttlMs: 3600000, iceServers: [{ urls: ['turn:user:pass@desk.example.test:3478'] }] },
  ]) assert.throws(() => validateTurnResponse(bad, now));

  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ expiresAt: now + 3600000, ttlMs: 3600000, iceServers })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  try {
    const value = await requestTurnCredentials({ endpoint: `http://127.0.0.1:${port}/api/turn-credentials`, node: { slug: 'node-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'b'.repeat(43) }, now });
    assert.equal(value.iceServers[1].credential, 'short-secret');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('relay candidates require the trusted address and port range', () => {
  const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
    'a=candidate:1 1 udp 123 47.119.157.242 49160 typ relay', ''].join('\r\n');
  assert(!rtcOffer({ type: 'offer', sdp }).sdp.includes('typ relay'));
  assert(rtcOffer({ type: 'offer', sdp }, { relay: { addresses: ['47.119.157.242'], minPort: 49160, maxPort: 49223 } }).sdp.includes('47.119.157.242 49160 typ relay'));
});

test('browser ICE sanitizer deduplicates TURN credentials and ignores malformed entries', () => {
  assert.deepEqual(rtcIceServers({ rtcIceServers: [...iceServers, iceServers[0], { urls: ['https://evil.test'], username: 'x', credential: 'y' }, { urls: ['turn:no-credentials.test:3478'] }] }), iceServers);
  assert.deepEqual(rtcIceServers({ rtcStunUrl: 'stun:legacy.example.test:3478' }), [{ urls: ['stun:legacy.example.test:3478'] }]);
});

test('panel returns fresh TURN ICE configuration to authenticated pages', async t => {
  const server = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ expiresAt: now + 3600000, ttlMs: 3600000, iceServers, echoed: body.slug })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/api/turn-credentials`;
  const app = await fixture({ webrtc: true, selfhostNode: { slug: 'node-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'b'.repeat(43), turnEndpoint: endpoint } });
  t.after(async () => { await app.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const login = await app.login(), me = await (await app.request('/api/me')).json();
  assert.equal(login.csrf.length > 0, true); assert.deepEqual(me.rtcIceServers, iceServers); assert(me.rtcIceExpiresAt > Date.now());
  const state = await (await app.request('/api/state')).json(); assert.deepEqual(state.rtc.rtcIceServers, iceServers);
});

test('TURN client can pin an imported center CA without disabling certificate verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turn-ca-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = https.createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ expiresAt: now + 3600000, ttlMs: 3600000, iceServers })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `https://127.0.0.1:${server.address().port}/api/turn-credentials`, node = { slug: 'node-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'b'.repeat(43) };
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(requestTurnCredentials({ endpoint, node }), /fetch failed|certificate/);
  assert.deepEqual((await requestTurnCredentials({ endpoint, node, ca: await readFile(join(directory, 'cert.pem')) })).iceServers, iceServers);
});

test('relay policy rejects unrelated public hosts and ports in SDP and both ICE filters', async () => {
  const { RTCPeerConnection } = await import('werift');
  const { createRTCBridge } = await import('../panel/rtc.mjs');
  const relay = { addresses: ['203.0.113.10'], minPort: 49160, maxPort: 49223 };
  const description = host => ({ type: 'offer', sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
    `a=candidate:1 1 udp 123 ${host} 49160 typ relay`, `a=candidate:2 1 udp 123 ${host} 443 typ relay`, ''].join('\r\n') });
  assert(!rtcOffer(description('203.0.113.11'), { relay }).sdp.includes('typ relay'));
  const accepted = rtcOffer(description('203.0.113.10'), { relay }).sdp;
  assert(accepted.includes('49160 typ relay')); assert(!accepted.includes('443 typ relay'));
  let pc;
  const create = RTCPeerConnection.prototype.createSctpTransport;
  RTCPeerConnection.prototype.createSctpTransport = function(...args) { pc = this; return create.apply(this, args); };
  let bridge;
  try {
    bridge = createRTCBridge({ address: '127.0.0.1', relay, valid: () => true, closed() {} });
    const config = pc.getConfiguration();
    for (const [host, port, expected] of [['203.0.113.10', 49160, true], ['203.0.113.10', 3478, false], ['203.0.113.11', 49160, false]]) {
      assert.equal(config.iceFilterStunResponse({}, [host, port]), expected);
      assert.equal(config.iceFilterCandidatePair({ remoteCandidate: { host, port } }), expected);
    }
  } finally { RTCPeerConnection.prototype.createSctpTransport = create; await bridge?.destroy(); }
});
