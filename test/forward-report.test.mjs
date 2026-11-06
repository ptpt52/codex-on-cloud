import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardReport, forwardFaultArea } from '../panel/public/forward-report.js';
import { fixture } from './fixture.mjs';

test('mapping diagnostics use an explicit allowlist and never copy names, addresses, ports, IDs, credentials or arbitrary server errors', () => {
  const secret = 'private-token-192.168.1.1-device';
  const report = forwardReport({ maxConnections: 8, mappings: [{ id: secret, deviceName: secret, targetHost: secret, localPort: 22001, code: secret, streamToken: secret, sent: 1, connections: 1, state: 'active', error: secret,
    errorCode: secret, direct: { reason: secret, note: secret, family: secret }, authorization: { role: 'temporary', createdHere: true, expiresAt: 1000 }, targetStatus: { state: 'failed' } }], recent: [{ code: 'heartbeat_timeout', endedAt: 1000, targetHost: secret }] });
  assert.ok(!report.includes(secret)); assert.ok(!report.includes('22001')); assert.match(report, /助手在线/); assert.match(report, /1970-01-01T00:00:01.000Z/); assert.match(report, /最近失败/); assert.match(report, /heartbeat_timeout/);
  assert.equal(forwardFaultArea('rtc_ice_timeout'), '直连协商（中转仍可用）'); assert.equal(forwardFaultArea('target_unavailable'), '助手/服务器到目标设备');
});

test('authorization provenance and actual login expiry are visible without leaking login identifiers and remain scoped after takeover', async t => {
  const app = await fixture(); t.after(() => app.close()); await app.login(); await app.claim();
  const created = await (await app.request('/api/forward', { method: 'POST', body: { localPort: 2222, targetPort: 22 } })).json();
  const own = await (await app.request('/api/forward')).json(), item = own.mappings.find(item => item.id === created.id);
  assert.equal(item.authorization.createdHere, true); assert.equal(item.authorization.role, 'admin'); assert.ok(item.authorization.expiresAt > Date.now()); assert.ok(item.createdAt <= Date.now());
  assert.ok(!JSON.stringify(own).includes(created.code)); assert.ok(!JSON.stringify(own).includes('session'));
  const previousCookie = app.cookie; await app.login();
  const other = await (await app.request('/api/forward')).json(); assert.equal(other.mappings[0].authorization.createdHere, false);
  await app.request('/api/logout', { method: 'POST', body: {} });
  assert.equal((await app.request('/api/forward', { headers: { cookie: previousCookie } })).status, 200);
});
