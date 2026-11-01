import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Message, methods, classes } from 'werift';
import { guardIceAgent } from '../panel/rtc-guard.mjs';
import { globalIPv6 } from '../panel/rtc-network.mjs';

function agent() {
  const accepted = [], protocol = { transport: { onData: (bytes, address) => accepted.push({ bytes, address }) } };
  let valid = true;
  const connection = { protocols: [protocol], onIceCandidate: { subscribe(fn) { this.emit = fn; } },
    localUsername: 'local', remoteUsername: 'remote', localPassword: 'test-password', stunServer: ['unexpected-default', 19302],
    earlyChecksDone: true, earlyChecks: [], checkList: [] };
  guardIceAgent(connection, { valid: () => valid, allowed: globalIPv6 });
  return { connection, accepted, receive: (bytes, host = '2408:8000::1', port = 45000) => protocol.transport.onData(bytes, [host, port]), revoke() { valid = false; } };
}
const binding = (username = 'local:remote', password = 'test-password') => new Message(methods.BINDING, classes.REQUEST)
  .setAttribute('USERNAME', username).setAttribute('PRIORITY', 123).addMessageIntegrity(Buffer.from(password)).addFingerprint().bytes;

test('public ICE guard verifies username and original-wire HMAC before any response or peer learning', () => {
  const a = agent(); assert.equal(a.connection.stunServer, undefined);
  a.receive(binding('other:remote')); a.receive(binding('local:remote', 'wrong'));
  a.receive(new Message(methods.BINDING, classes.REQUEST).setAttribute('USERNAME', 'local:remote').bytes);
  a.receive(binding(), '2001:db8::1'); a.receive(binding(), '2408:8000::1', 53);
  a.receive(Buffer.from([22, 0, 0])); assert.equal(a.accepted.length, 0);
  const base = new Message(methods.BINDING, classes.REQUEST).setAttribute('USERNAME', 'local:remote').bytes;
  const unknown = Buffer.concat([base, Buffer.from([0xc0, 0x57, 0, 4, 0, 1, 0, 0, 0, 8, 0, 20]), Buffer.alloc(20)]);
  unknown.writeUInt16BE(unknown.length - 20, 2);
  createHmac('sha1', 'test-password').update(unknown.subarray(0, unknown.length - 24)).digest().copy(unknown, unknown.length - 20);
  a.receive(unknown); assert.equal(a.accepted.length, 1);
  a.receive(Buffer.from([22, 0, 0])); assert.equal(a.accepted.length, 2);
  a.revoke(); a.receive(binding()); assert.equal(a.accepted.length, 2);
});

test('public ICE peer learning, early checks, packet sizes and per-second requests remain bounded', () => {
  const peers = agent();
  for (let i = 0; i < 25; i++) peers.receive(binding(), `2408:8000::${i + 1}`);
  assert.equal(peers.accepted.length, 16);
  const early = agent(); early.connection.earlyChecksDone = false; early.connection.earlyChecks = Array(16).fill(null);
  early.receive(binding()); assert.equal(early.accepted.length, 0);
  const flood = agent(); for (let i = 0; i < 80; i++) flood.receive(binding());
  assert.equal(flood.accepted.length, 64);
  const large = agent(), packet = new Message(methods.BINDING, classes.REQUEST).setAttribute('USERNAME', 'local:remote')
    .appendRawAttribute(0x7fff, Buffer.alloc(2200)).addMessageIntegrity(Buffer.from('test-password')).bytes;
  large.receive(packet); assert.equal(large.accepted.length, 0);
});
