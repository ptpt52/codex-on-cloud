import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../selfhost/client-address.mjs';

const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('forwarded client addresses are trusted only from the loopback proxy', () => {
  assert.equal(clientAddress(request('127.0.0.1', '198.51.100.8, 127.0.0.1')), '198.51.100.8');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '2001:db8::8')), '2001:db8::8');
  assert.equal(clientAddress(request('203.0.113.9', '198.51.100.8')), '203.0.113.9');
  assert.equal(clientAddress(request('127.0.0.1', 'spoofed, 198.51.100.9')), '198.51.100.9');
  assert.equal(clientAddress(request('127.0.0.1', 'invalid')), '127.0.0.1');
});
