import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { RTCPeerConnection, Message, methods, classes, parseMessage } from 'werift';
import { rtcAddress, rtcIPv6Address } from '../panel/rtc.mjs';
import { fixture } from './fixture.mjs';

test('real IPv6 UDP accepts authenticated peer-reflexive ICE checks and drops unsigned or wrong-key checks before VNC', async t => {
  const address = rtcIPv6Address(undefined, rtcAddress());
  if (!address) return t.skip('需要本机已分配公网 IPv6，不用模拟地址替代真实 IPv6 socket');
  const app = await fixture({ webrtc: true, webrtcIPv6: true, webrtcIPv6Address: address });
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv4: false, iceUseIpv6: true, iceUseTcp: false,
    iceInterfaceAddresses: { udp6: address }, icePortRange: [40000, 40015] });
  const socket = dgram.createSocket('udp6'); let received = 0;
  socket.on('message', () => received++);
  t.after(async () => { socket.close(); await peer.close(); await app.close(); });
  peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' });
  for (const transport of peer.iceTransports) transport.connection.stunServer = undefined;
  await peer.setLocalDescription(await peer.createOffer());
  const localUfrag = /^a=ice-ufrag:(.+)$/m.exec(peer.localDescription.sdp)[1].trim();
  await app.login(); await app.claim();
  const result = await app.request('/api/desktop/rtc', { method: 'POST', body: { type: 'offer', sdp: peer.localDescription.sdp } });
  assert.equal(result.status, 200); const { sdp } = await result.json();
  const target = sdp.split(/\r?\n/).find(line => line.startsWith('a=candidate:') && line.split(' ')[4].includes(':')).split(' ');
  const username = /^a=ice-ufrag:(.+)$/m.exec(sdp)[1].trim(), password = /^a=ice-pwd:(.+)$/m.exec(sdp)[1].trim();
  socket.bind(0, address); await once(socket, 'listening');
  const send = bytes => new Promise((resolve, reject) => socket.send(bytes, Number(target[5]), target[4], error => error ? reject(error) : resolve()));
  const binding = () => new Message(methods.BINDING, classes.REQUEST).setAttribute('USERNAME', `${username}:${localUfrag}`).setAttribute('PRIORITY', 123);
  await send(binding().bytes); await send(binding().addMessageIntegrity(Buffer.from('wrong-key')).addFingerprint().bytes);
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(received, 0); assert.equal(app.vncConnections, 0);
  const response = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  await send(binding().addMessageIntegrity(Buffer.from(password)).addFingerprint().bytes);
  const [bytes] = await response, parsed = parseMessage(bytes, Buffer.from(password));
  assert.equal(parsed?.messageClass, classes.RESPONSE); assert.equal(parsed.messageMethod, methods.BINDING);
  assert.equal(app.vncConnections, 0); assert.deepEqual(app.inputCalls, []);
});
