import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { rtcOffer as lanOffer, privateIPv4, rtcAddress } from '../panel/rtc.mjs';
import { fixture } from './fixture.mjs';

const fingerprint = Array(32).fill('AB').join(':');
const offer = candidates => ({ type: 'offer', sdp: [
  'v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  `a=fingerprint:sha-256 ${fingerprint}`, ...candidates, '',
].join('\r\n') });
const candidate = (host, extra = '') => `a=candidate:1 1 udp 123 ${host} 45678 typ host${extra}`;

test('LAN negotiation bounds SDP and keeps only private IPv4/mDNS UDP host candidates', () => {
  const result = lanOffer(offer([
    candidate('192.168.16.15'), candidate('browser-uuid.local'), candidate('127.0.0.1'),
    candidate('8.8.8.8'), candidate('attacker.example'), candidate('2001:db8::1'),
    'a=candidate:1 1 tcp 123 192.168.16.15 45678 typ host tcptype passive',
    'a=candidate:1 1 udp 123 192.168.16.15 443 typ host',
  ]));
  assert.equal(result.sdp.match(/^a=candidate:/gm).length, 3);
  assert.ok(!result.sdp.includes('8.8.8.8') && !result.sdp.includes('attacker.example'));
  const many = lanOffer(offer(Array.from({ length: 30 }, (_, i) => candidate(`10.0.0.${i + 1}`))));
  assert.equal(many.sdp.match(/^a=candidate:/gm).length, 8);
  for (const body of [{}, { type: 'answer', sdp: '' }, { type: 'offer', sdp: 'x'.repeat(32769) },
    { type: 'offer', sdp: offer([]).sdp.replace('sha-256', 'sha-1') },
    { type: 'offer', sdp: offer([]).sdp + '\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' }]) assert.throws(() => lanOffer(body));
  assert.equal(privateIPv4('172.31.1.1'), true);
  assert.equal(privateIPv4('172.32.1.1'), false);
  assert.equal(privateIPv4('169.254.1.1'), false);
  assert.equal(rtcAddress('127.0.0.1'), '127.0.0.1');
  assert.throws(() => rtcAddress('8.8.8.8'));
});

test('RTC signaling requires login, valid origin, CSRF and current viewer before processing SDP', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close());
  const post = options => app.request('/api/desktop/rtc', { method: 'POST', body: {}, ...options });
  assert.equal((await post()).status, 401);
  await app.login();
  assert.equal((await post()).status, 409);
  await app.claim();
  assert.equal((await post({ headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await post({ headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await post({ headers: { 'x-viewer-id': '2222222222222222' } })).status, 409);
  assert.equal((await post({ headers: { host: 'attacker.example' } })).status, 400);
  assert.equal((await post()).status, 400);
  const tooLarge = await post({ body: { type: 'offer', sdp: 'x'.repeat(50 * 1024) } });
  assert.equal(tooLarge.status, 413);
  assert.equal(app.received.some(item => item.method === 'VNC'), false);
});

test('a delayed RTC offer cannot survive takeover and a later reclaim by the same viewer', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close());
  await app.login(); await app.claim();
  const body = JSON.stringify(offer([candidate('127.0.0.1')]));
  const reading = once(app.panel.server, 'request');
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.config.origin + '/api/desktop/rtc', { method: 'POST', headers: {
      origin: app.config.origin, cookie: app.cookie, 'x-csrf-token': app.csrf, 'x-viewer-id': app.viewer,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  await reading;
  await app.claim('22222222-2222-4222-8222-222222222222');
  await app.claim();
  request.end(body.slice(1));
  assert.equal(await response, 409);
  assert.equal(app.received.some(item => item.method === 'VNC'), false);
});

test('disabled RTC does not allocate a peer or change the existing desktop stream', async t => {
  const app = await fixture(); t.after(() => app.close());
  await app.login(); await app.claim();
  assert.equal((await (await app.request('/api/me')).json()).webrtc, false);
  assert.equal((await app.request('/api/desktop/rtc', { method: 'POST', body: offer([]) })).status, 404);
});
