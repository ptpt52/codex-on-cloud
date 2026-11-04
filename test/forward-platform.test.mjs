import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORWARD_CLIENTS, forwardOS, detectForwardClient } from '../panel/public/forward-platform.js';

test('download recommendations use explicit architecture hints rather than the misleading MacIntel platform', async () => {
  const mac = { platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
  assert.deepEqual(await detectForwardClient(mac), { os: 'darwin', arch: null });
  for (const [architecture, expected] of [['arm', 'darwin-arm64'], ['x86', 'darwin-amd64']]) {
    const device = { ...mac, userAgentData: { platform: 'macOS', async getHighEntropyValues(keys) {
      assert.deepEqual(keys, ['architecture', 'bitness']); return { architecture, bitness: '64' };
    } } };
    assert.deepEqual(await detectForwardClient(device), { os: 'darwin', arch: expected });
  }
  assert.equal((await detectForwardClient({ userAgentData: { platform: 'Windows', async getHighEntropyValues() { return { architecture: 'arm', bitness: '64' }; } } })).arch, 'windows-arm64');
  assert.equal(forwardOS({ ...mac, maxTouchPoints: 5 }), null);
  for (const userAgent of ['iPhone', 'Android', 'Linux']) assert.equal(forwardOS({ userAgent }), null);
  assert.equal(Object.keys(FORWARD_CLIENTS).length, 4);
});

test('denied, absent, invalid or stalled architecture hints fall back to manual selection within a fixed deadline', async t => {
  const device = { platform: 'MacIntel', userAgentData: { platform: 'macOS', async getHighEntropyValues() { throw new Error('denied'); } } };
  assert.deepEqual(await detectForwardClient(device), { os: 'darwin', arch: null });
  device.userAgentData.getHighEntropyValues = async () => ({ architecture: 'other', bitness: '64' });
  assert.deepEqual(await detectForwardClient(device), { os: 'darwin', arch: null });
  device.userAgentData.getHighEntropyValues = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = detectForwardClient(device); t.mock.timers.tick(500);
  assert.deepEqual(await pending, { os: 'darwin', arch: null });
});
