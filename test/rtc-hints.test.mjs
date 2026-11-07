import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, parseMessage, classes } from 'werift';
import { once } from 'node:events';
import dgram from 'node:dgram';
import { rtcHints, hintIP, createRTCHints, RTC_HINTS_KEY, RTC_HINTS_LIMIT } from '../panel/public/rtc-hints.js';
import { withHintCandidates, RTC_HINT_CANDIDATES } from '../panel/rtc-hints.mjs';
import { rtcOffer, peerAddress } from '../panel/rtc-network.mjs';
import { fixture } from './fixture.mjs';

const offer = candidates => ({ type: 'offer', sdp: ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:original', 'a=ice-pwd:original-password', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
  ...candidates, 'a=end-of-candidates', ''].join('\r\n') });
const candidate = (host, port = 45000) => `a=candidate:1 1 udp 2130706431 ${host} ${port} typ host`;
const candidates = description => description.sdp.split('\r\n').filter(line => line.startsWith('a=candidate:'));

test('optional address hints use the direct-connect IP policy and reject ports, URLs, hostnames and unbounded input', () => {
  assert.deepEqual(rtcHints(), { server: '', browser: '' });
  assert.deepEqual(rtcHints({ server: ' 192.168.1.1 ', browser: '2408:8000:0:0::1' }), { server: '192.168.1.1', browser: '2408:8000::1' });
  for (const address of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '2408::1', '2001:4860::1', '3ffe::1', '3fff:1000::1']) {
    assert.equal(peerAddress(address, true), true, address); assert.ok(hintIP(address), address);
  }
  for (const address of ['8.8.8.8', '100.64.0.1', '169.254.1.1', '0.0.0.0', '192.168.1.256', '192.168.01.1',
    'localhost', 'chrome.local', 'http://192.168.1.1', '192.168.1.1:40000', '[2408::1]', '::1', '::', 'fd00::1', 'fe80::1%eth0',
    '2001::1', '2001:100::1', '2001:db8::1', '2002::1', '3fff:fff::1', '4000::1', '::ffff:192.168.1.1', 'x'.repeat(46)]) {
    assert.equal(hintIP(address), null, address);
    assert.throws(() => rtcHints({ server: address }), /服务器 IP/);
  }
  for (const value of [null, [], '192.168.1.1', { browser: [] }, { server: 123 }, { command: 'anything' }]) assert.throws(() => rtcHints(value));
});

test('browser storage keeps one bounded pair, rejects corrupt data and works without storage', () => {
  const store = { text: null, getItem(key) { assert.equal(key, RTC_HINTS_KEY); return this.text; }, setItem(key, value) {
    assert.equal(key, RTC_HINTS_KEY); assert.ok(value.length <= RTC_HINTS_LIMIT); this.text = value;
  } };
  const hints = createRTCHints(store); hints.save({ browser: '192.168.1.2' });
  assert.deepEqual(createRTCHints(store).value, { server: '', browser: '192.168.1.2' });
  const snapshot = hints.value; snapshot.browser = '10.0.0.1'; assert.equal(hints.value.browser, '192.168.1.2');
  assert.throws(() => hints.save({ browser: 'invalid' })); assert.equal(hints.value.browser, '192.168.1.2');
  hints.save({}); assert.deepEqual(createRTCHints(store).value, { server: '', browser: '' });
  for (const text of ['{', 'null', 'x'.repeat(RTC_HINTS_LIMIT + 1), JSON.stringify({ server: 'attacker.example' })]) {
    store.text = text; assert.deepEqual(createRTCHints(store).value, { server: '', browser: '' });
  }
  for (const store of [undefined, { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } }]) {
    const hints = createRTCHints(store); hints.save({ server: '10.0.0.1' }); assert.equal(hints.persisted, false); assert.equal(hints.value.server, '10.0.0.1');
  }
});

test('hint candidates preserve all automatic candidates, credentials, families and gathered ports with a fixed extra bound', () => {
  const automatic = rtcOffer(offer([candidate('chrome.local'), ...Array.from({ length: 7 }, (_, n) => candidate(`192.168.1.${n + 1}`, 45001 + n))]));
  const hinted = withHintCandidates(automatic, '10.0.0.8');
  assert.equal(candidates(hinted).length, 8 + RTC_HINT_CANDIDATES);
  for (const original of automatic.sdp.split('\r\n')) assert.ok(hinted.sdp.split('\r\n').includes(original));
  assert.deepEqual(candidates(hinted).slice(8).map(line => line.split(' ')[5]), ['45000', '45001', '45002', '45003']);
  assert.ok(hinted.sdp.indexOf('hint1') < hinted.sdp.indexOf('a=end-of-candidates'));
  assert.equal(candidates(withHintCandidates(hinted, '10.0.0.8')).length, 12);
  for (const address of ['', '8.8.8.8', '2408::1']) assert.equal(withHintCandidates(automatic, address), automatic);
  const v6 = rtcOffer(offer([candidate('2408::1')]), { ipv6: true });
  assert.equal(candidates(withHintCandidates(v6, '2408::2', { ipv6: true })).length, 2);
  const expanded = offer([candidate('2408:0:0:0:0:0:0:1')]);
  assert.equal(withHintCandidates(expanded, '2408::1', { ipv6: true }), expanded);
  assert.equal(candidates(withHintCandidates(offer([candidate('chrome.local')]), '2408::2', { ipv6: true })).length, 2);
  assert.equal(withHintCandidates(v6, '10.0.0.1', { ipv6: true }), v6);
  const same = offer([candidate('10.0.0.1'), candidate('chrome.local')]); assert.equal(withHintCandidates(same, '10.0.0.1'), same);
});

test('hints remain behind signaling authentication and never become arbitrary targets or ports', async t => {
  const app = await fixture({ webrtc: true }); t.after(() => app.close());
  const body = { ...offer([candidate('chrome.local')]), hints: { browser: '10.0.0.1' } };
  assert.equal((await app.request('/api/desktop/rtc', { method: 'POST', body })).status, 401);
  await app.login(); await app.claim();
  assert.equal((await app.request('/api/desktop/rtc', { method: 'POST', body, headers: { origin: 'https://invalid.example' } })).status, 403);
  for (const hints of [{ browser: '10.0.0.1:22' }, { server: 'attacker.example' }, { server: '8.8.8.8' }, { browser: ['10.0.0.1'] }, { port: 22 }]) {
    assert.equal((await app.request('/api/desktop/rtc', { method: 'POST', body: { ...body, hints } })).status, 400);
  }
  assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
});

test('real ICE sends authenticated checks to a browser hint while preserving unresolved mDNS and returns an unassigned server alias', async t => {
  const app = await fixture({ webrtc: true });
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: '127.0.0.1' } });
  t.after(async () => { await peer.close(); await app.close(); });
  peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' });
  for (const transport of peer.iceTransports) transport.connection.stunServer = undefined;
  await peer.setLocalDescription(await peer.createOffer());
  const password = /^a=ice-pwd:(.+)$/m.exec(peer.localDescription.sdp)[1].trim();
  const checks = new EventTarget();
  for (const protocol of peer.iceTransports[0].connection.protocols) {
    const original = protocol.transport.onData;
    protocol.transport.onData = (bytes, address) => {
      try { if (parseMessage(bytes, Buffer.from(password))?.messageClass === classes.REQUEST) checks.dispatchEvent(new Event('check')); } catch {}
      original(bytes, address);
    };
  }
  const received = once(checks, 'check', { signal: AbortSignal.timeout(5000) });
  await app.login(); await app.claim();
  const sdp = peer.localDescription.sdp.replace(/^(a=candidate:\S+ 1 udp \d+) 127\.0\.0\.1 /gm, '$1 unresolved-hint-test.local ');
  assert.ok(sdp.includes('unresolved-hint-test.local'));
  const response = await app.request('/api/desktop/rtc', { method: 'POST', body: { type: 'offer', sdp, hints: { browser: '127.0.0.1', server: '10.123.254.253' } } });
  assert.equal(response.status, 200); const answer = await response.json();
  assert.ok(answer.sdp.includes(' 127.0.0.1 ')); assert.ok(answer.sdp.includes(' 10.123.254.253 '));
  const ports = candidates(answer).map(line => line.split(' ')[5]); assert.equal(new Set(ports).size, 1);
  await received;
  assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
});

test('a server hint can establish real ICE and DTLS through an IP alias without changing the server bind address', async t => {
  const app = await fixture({ webrtc: true });
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false, iceInterfaceAddresses: { udp4: '127.0.0.1' } });
  const proxy = dgram.createSocket('udp4'); let client, forwarded = 0;
  t.after(async () => { proxy.close(); await peer.close(); await app.close(); });
  const channel = peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' });
  for (const transport of peer.iceTransports) transport.connection.stunServer = undefined;
  await peer.setLocalDescription(await peer.createOffer());
  await app.login(); await app.claim();
  // Suppress the direct path in this isolated test; the client must use the
  // hinted alias and its same-port forwarding path to reach the server socket.
  const sdp = peer.localDescription.sdp.replace(/^(a=candidate:\S+ 1 udp \d+) 127\.0\.0\.1 /gm, '$1 10.123.254.253 ');
  const response = await app.request('/api/desktop/rtc', { method: 'POST', body: { type: 'offer', sdp, hints: { server: '127.0.0.2' } } });
  assert.equal(response.status, 200); const answer = await response.json();
  const port = Number(candidates(answer).find(line => line.includes(' 127.0.0.2 ')).split(' ')[5]);
  proxy.on('message', (bytes, sender) => {
    forwarded++;
    if (sender.address === '127.0.0.1' && sender.port === port) { if (client) proxy.send(bytes, client.port, client.address); }
    else { client = sender; proxy.send(bytes, port, '127.0.0.1'); }
  });
  proxy.bind(port, '127.0.0.2'); await once(proxy, 'listening');
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('hinted alias failed to establish DTLS')), 5000);
    channel.stateChange.subscribe(state => { if (state === 'open') { clearTimeout(timer); resolve(); } });
  });
  await peer.setRemoteDescription({ ...answer, sdp: answer.sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || line.includes(' 127.0.0.2 ')).join('\r\n') });
  await connected;
  assert.equal(peer.connectionState, 'connected'); assert.ok(forwarded > 0);
  assert.equal(peer.iceTransports[0].connection.nominated.remoteCandidate.host, '127.0.0.2');
  assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
});
