import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { requestTurnCredentials, validateTurnResponse } from '../panel/turn-client.mjs';
import { rtcOffer } from '../panel/rtc-network.mjs';
import { rtcIceServers } from '../panel/public/rtc-ice.js';
import { fixture } from './fixture.mjs';

const now = Date.now();
const iceServers = [
  { urls: ['stun:desk.example.test:3478'] },
  { urls: ['turn:desk.example.test:3478?transport=udp', 'turn:desk.example.test:3478?transport=tcp', 'turns:desk.example.test:5349?transport=tcp'], username: '200:signed', credential: 'short-secret' },
];

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

test('relay candidates are accepted only when TURN is available', () => {
  const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
    'a=candidate:1 1 udp 123 47.119.157.242 49160 typ relay', ''].join('\r\n');
  assert(!rtcOffer({ type: 'offer', sdp }).sdp.includes('typ relay'));
  assert(rtcOffer({ type: 'offer', sdp }, { allowRelay: true }).sdp.includes('47.119.157.242 49160 typ relay'));
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
