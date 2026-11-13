import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalIPv4, globalIPv6, rtcAddress, rtcIPv6Address, rtcOffer, stunURL, rtcIceConfiguration, rtcBindAddresses, peerAddress } from '../panel/rtc-network.mjs';
import { selectedRoute, gatherCandidates, rtcRouteKind, rtcRouteLabel } from '../panel/public/rtc-stats.js';

const offer = candidates => ({ type: 'offer', sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), ...candidates].join('\r\n') });
const candidate = (host, type = 'host', port = 45000) => `a=candidate:1 1 udp 123 ${host} ${port} typ ${type}`;

test('LAN selection prefers an up default route by metric, skips unusable VPNs and preserves explicit overrides', () => {
  const interfaces = { lo: [{ address: '127.0.0.1', internal: true }], ethernet: [{ address: '192.168.15.224' }],
    wifi: [{ address: '192.168.16.224' }], vpn: [{ address: '100.64.0.2' }] };
  const route = (name, metric, flags = '0003', mask = '00000000') => `${name}\t00000000\t0100000A\t${flags}\t0\t0\t${metric}\t${mask}`;
  const routes = [route('ethernet', 100, '0000'), route('wifi', 600), route('vpn', 1), route('ethernet', 2, '0201')];
  assert.equal(rtcAddress(undefined, interfaces, routes), '192.168.16.224');
  assert.equal(rtcAddress(undefined, interfaces, [...routes, route('ethernet', 50)]), '192.168.15.224');
  assert.equal(rtcAddress('192.168.15.224', interfaces, routes), '192.168.15.224');
  assert.equal(rtcAddress('127.0.0.1', interfaces, routes), '127.0.0.1');
  assert.equal(rtcAddress(undefined, interfaces, [route('wifi', 1, '0003', '00FFFFFF'), 'malformed']), '192.168.15.224');
  interfaces.wifi[0].address = '192.168.16.225';
  assert.equal(rtcAddress(undefined, interfaces, routes), '192.168.16.225');
  assert.equal(rtcAddress(undefined, {}, routes), '127.0.0.1');
  assert.throws(() => rtcAddress('192.168.16.224', interfaces, routes));
});

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
  for (const ip of ['2408:8000::8', '::1']) assert.throws(() => rtcIPv6Address(ip, '192.168.1.2', interfaces));
});

test('dual-stack offers reserve both families and deduplicate candidates', () => {
  const mixed = [...Array.from({ length: 20 }, (_, i) => candidate(`192.168.1.${i + 1}`)),
    ...Array.from({ length: 20 }, (_, i) => candidate(`2408:8000::${i + 1}`, i ? 'host' : 'srflx')),
    candidate('2408:8000::f', 'relay'), candidate('203.0.113.1', 'srflx'), candidate('fd00::1'), candidate('2001:db8::1'),
    candidate('2408:8000::ffff').replace(' udp ', ' tcp '), candidate('2408:8000::ffff', 'host', 80)];
  const lines = rtcOffer(offer(mixed), { ipv6: true }).sdp.split('\r\n').filter(x => x.startsWith('a=candidate:'));
  assert.equal(lines.length, 8); assert.equal(lines.filter(x => x.includes('192.168.')).length, 4);
  assert.equal(lines.filter(x => x.includes('2408:8000:')).length, 4); assert.ok(lines.some(x => x.endsWith('typ srflx')));
  assert.equal(rtcOffer(offer(Array(30).fill(candidate('2408:8000::1'))), { ipv6: true }).sdp.match(/a=candidate:/g).length, 1);
  assert.ok(!rtcOffer(offer(mixed)).sdp.includes('2408:8000:'));
  assert.ok(!rtcOffer(offer(['a=remote-candidates:1 8.8.8.8 53'])).sdp.includes('remote-candidates'));
});

test('local address hints bind assigned interfaces per negotiation and aliases keep the existing bind', () => {
  const interfaces = { lan: [{ address: '192.168.1.2' }, { address: '2408::2' }], vpn: [{ address: '100.64.0.2' }, { address: 'fd00::2' }] };
  const config = { webrtcAddress: '192.168.1.2', webrtcIPv6: true, webrtcIPv6Address: '2408::2' };
  assert.deepEqual(rtcBindAddresses(config, ['100.64.0.2', 'fd00::2'], interfaces), { address: '100.64.0.2', ipv6Address: 'fd00::2' });
  assert.deepEqual(rtcBindAddresses(config, '10.123.254.253', interfaces), { address: '192.168.1.2', ipv6Address: '2408::2' });
  assert.deepEqual(rtcBindAddresses({ ...config, webrtcIPv6: false }, 'fd00::2', interfaces), { address: '192.168.1.2', ipv6Address: undefined });
  assert.equal(rtcIPv6Address('fd00::2', '192.168.1.2', interfaces), 'fd00::2');
  assert.equal(rtcRouteLabel({ family: 'IPv4', local: { address: '100.64.0.2', type: 'host' }, remote: { address: '100.64.0.3', type: 'host' } }), 'WebRTC 加密直连（VPN）');
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

test('route labels require candidate types and distinguish either TURN allocation from direct paths', () => {
  const route = (local, remote) => ({ local: { type: local, address: '203.0.113.8', port: 49161 }, remote: { type: remote, address: '203.0.113.8', port: 49162 } });
  for (const local of ['host', 'srflx', 'prflx']) for (const remote of ['host', 'srflx', 'prflx']) {
    assert.equal(rtcRouteKind(route(local, remote)), 'direct');
    assert.match(rtcRouteLabel(route(local, remote)), /^WebRTC 加密直连/);
  }
  for (const other of ['host', 'srflx', 'prflx', 'relay', 'unknown', undefined]) {
    for (const pair of [route('relay', other), route(other, 'relay')]) {
      assert.equal(rtcRouteKind(pair), 'relay');
      assert.equal(rtcRouteLabel(pair), 'WebRTC 加密中继（TURN）');
    }
  }
  for (const pair of [null, {}, route(undefined, 'host'), route('srflx', 'unknown'), route('host', 'invalid')]) {
    assert.equal(rtcRouteKind(pair), 'unknown');
    assert.equal(rtcRouteLabel(pair), 'WebRTC 加密通道（路径待确认）');
  }
  const hidden = route('host', 'srflx'); hidden.local.address = hidden.remote.address = null;
  assert.equal(rtcRouteKind(hidden), 'direct'); // Address privacy and identical IPs do not determine the path.
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

test('IPv4 NAT candidates retain slots beside LAN, IPv6 and center relay candidates', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '11.0.0.2']) assert.equal(globalIPv4(address), true);
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::ffff:8.8.8.8', undefined]) assert.equal(globalIPv4(address), false, String(address));
  const rows = [...Array.from({ length: 25 }, (_, i) => candidate(`10.0.0.${i+1}`)), candidate('11.0.0.2', 'srflx'), candidate('12.0.0.2', 'srflx'), candidate('2606:4700::1'), candidate('203.0.113.2', 'relay', 49161), candidate('100.64.0.1', 'srflx'), candidate('169.254.1.1', 'srflx')];
  const sdp = rtcOffer(offer(rows), { ipv6: true, relay: { addresses: ['203.0.113.2'], minPort: 49160, maxPort: 49223 } }).sdp;
  assert.equal((sdp.match(/a=candidate:/g) || []).length, 8);
  for (const address of ['11.0.0.2', '12.0.0.2', '2606:4700::1', '203.0.113.2']) assert.ok(sdp.includes(address));
  for (const address of ['100.64.0.1', '169.254.1.1']) assert.ok(!sdp.includes(address));
  assert.ok(rtcOffer(offer([candidate('11.0.0.2','srflx')])).sdp.includes('typ srflx'));
  assert.equal(rtcAddress(undefined, { wan: [{ address: '11.0.0.2' }] }, []), '11.0.0.2');
  assert.equal(rtcAddress(undefined, { mobile: [{ address: '100.64.2.2' }] }, []), '100.64.2.2');
  assert.equal(rtcAddress('100.64.2.2', { mobile: [{ address: '100.64.2.2' }] }, []), '100.64.2.2');
});

test('STUN discovery is explicit and does not depend on IPv6', () => {
  assert.equal(rtcIceConfiguration().stun, false);
  const ice = rtcIceConfiguration('stun:stun.example:3478');
  assert.equal(ice.stun, true); assert.equal(ice.iceStunGatherTimeout, 1.5);
  assert.deepEqual(ice.iceServers, [{ urls: 'stun:stun.example:3478' }]);
});

test('route labels distinguish LAN, IPv6, IPv4 NAT, public IPv4 and unknown addresses', () => {
  const route = (family, local, remote, type='host') => ({ family, local: {type:'host',address:local}, remote:{type,address:remote} });
  assert.equal(rtcRouteLabel(route('IPv4','10.0.0.1','192.168.1.2')), 'WebRTC 加密直连（局域网）');
  assert.equal(rtcRouteLabel(route('IPv4','10.0.0.1','192.168.1.2','prflx')), 'WebRTC 加密直连（局域网）');
  assert.equal(rtcRouteLabel(route('IPv6','2606:4700::1','2408:8000::2')), 'WebRTC 加密直连（IPv6）');
  assert.equal(rtcRouteLabel(route('IPv4','10.0.0.1','11.0.0.2','srflx')), 'WebRTC 加密直连（NAT 打洞）');
  assert.equal(rtcRouteLabel(route('IPv4','11.0.0.1','12.0.0.2')), 'WebRTC 加密直连（公网 IPv4）');
  assert.equal(rtcRouteLabel(route('unknown',null,null)), 'WebRTC 加密直连');
});
