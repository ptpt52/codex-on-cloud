import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalIPv6, rtcIPv6Address, rtcOffer, stunURL } from '../panel/rtc-network.mjs';
import { selectedRoute, gatherCandidates } from '../panel/public/rtc-stats.js';

const offer = candidates => ({ type: 'offer', sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), ...candidates].join('\r\n') });
const candidate = (host, type = 'host', port = 45000) => `a=candidate:1 1 udp 123 ${host} ${port} typ ${type}`;

test('IPv6 policy accepts ordinary global unicast and rejects scoped, mapped, multicast and reserved addresses', () => {
  for (const ip of ['2408:8000::1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(globalIPv6(ip), true);
  for (const ip of ['::', '::1', '::ffff:192.168.1.1', '64:ff9b::808:808', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'ff02::1',
    '2001:db8::1', '2001::1', '2002:c000:201::', '3fff::1', '4000::1', '8.8.8.8', 'example.com', undefined]) assert.equal(globalIPv6(ip), false, String(ip));
});

test('IPv6 selection prefers the LAN interface, reselects after address changes and validates explicit assignment', () => {
  const interfaces = { vpn: [{ address: '2606:4700::2' }], wifi: [{ address: '192.168.1.2' }, { address: '2408:8000::2' }, { address: 'fd00::2' }] };
  assert.equal(rtcIPv6Address(undefined, '192.168.1.2', interfaces), '2408:8000::2');
  interfaces.wifi[1].address = '2408:8000::3';
  assert.equal(rtcIPv6Address(undefined, '192.168.1.2', interfaces), '2408:8000::3');
  assert.equal(rtcIPv6Address('2408:8000:0:0:0:0:0:3', '192.168.1.2', interfaces), '2408:8000::3');
  assert.equal(rtcIPv6Address(undefined, '127.0.0.1', {}), undefined);
  for (const ip of ['2408:8000::8', 'fd00::2', '::1']) assert.throws(() => rtcIPv6Address(ip, '192.168.1.2', interfaces));
});

test('dual-stack offers reserve both families, deduplicate and accept only global IPv6 reflexive UDP candidates', () => {
  const mixed = [candidate('8.8.8.8'), ...Array.from({ length: 20 }, (_, i) => candidate(`192.168.1.${i + 1}`)),
    ...Array.from({ length: 20 }, (_, i) => candidate(`2408:8000::${i + 1}`, i ? 'host' : 'srflx')),
    candidate('2408:8000::f', 'relay'), candidate('8.8.8.8', 'srflx'), candidate('fd00::1'), candidate('2001:db8::1'),
    candidate('2408:8000::ffff').replace(' udp ', ' tcp '), candidate('2408:8000::ffff', 'host', 80)];
  const lines = rtcOffer(offer(mixed), { ipv6: true }).sdp.split('\r\n').filter(x => x.startsWith('a=candidate:'));
  assert.equal(lines.length, 8); assert.equal(lines.filter(x => x.includes('192.168.')).length, 4);
  assert.equal(lines.filter(x => x.includes('2408:8000:')).length, 4); assert.ok(lines.some(x => x.endsWith('typ srflx')));
  assert.equal(rtcOffer(offer(Array(30).fill(candidate('2408:8000::1'))), { ipv6: true }).sdp.match(/a=candidate:/g).length, 1);
  assert.ok(!rtcOffer(offer(mixed)).sdp.includes('2408:8000:'));
  assert.ok(!rtcOffer(offer(['a=remote-candidates:1 8.8.8.8 53'])).sdp.includes('remote-candidates'));
});

test('STUN configuration permits one bounded UDP URL and rejects relays, credentials and URL injection', () => {
  assert.equal(stunURL(), 'stun:stun.cloudflare.com:3478');
  for (const value of ['', 'stun:stun.example:3478', 'stun:127.0.0.1:45678', 'stun:[2606:4700:49::]:3478']) assert.equal(stunURL(value), value);
  for (const value of ['turn:relay.example:3478', 'stuns:x:5349', 'stun:user:pass@host:3478', 'stun:x:0', 'stun:x:65536', 'stun:x?transport=tcp', 'stun:x/anything', 'stun:x\nstun:y', 'x'.repeat(257)]) assert.throws(() => stunURL(value));
});

test('route diagnostics report the selected candidate pair rather than another succeeded pair', () => {
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['wrong', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'bad', remoteCandidateId: 'bad' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.023 }],
    ['local', { address: '2408:8000::1', port: 45000, candidateType: 'host', protocol: 'udp' }],
    ['remote', { address: '2606:4700::1', port: 45001, candidateType: 'prflx', protocol: 'udp' }],
  ]);
  const route = selectedRoute(stats);
  assert.equal(route.family, 'IPv6'); assert.equal(route.protocol, 'UDP'); assert.equal(route.rttMs, 23); assert.equal(route.remote.port, 45001);
  stats.get('local').address = '';
  assert.equal(selectedRoute(stats).local.address, null); assert.equal(selectedRoute(stats).family, 'IPv6');
  stats.get('selected').state = 'failed'; assert.equal(selectedRoute(stats), null);
});

test('STUN gathering has a fixed deadline and cancellation removes its listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new EventTarget(); peer.iceGatheringState = 'gathering';
  const first = gatherCandidates(peer, new AbortController().signal);
  t.mock.timers.tick(1500); await first;
  const controller = new AbortController(), canceled = assert.rejects(gatherCandidates(peer, controller.signal), /取消/);
  controller.abort(); await canceled;
  peer.iceGatheringState = 'complete'; await gatherCandidates(peer, new AbortController().signal);
});
