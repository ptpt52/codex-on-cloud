import test from 'node:test';
import assert from 'node:assert/strict';
import { caddyConfig } from '../selfhost/server-config.mjs';
import { caddyAdminCidrs, normalizeAdminCidrs, resolveAdminCidrs, serverSettings } from '../selfhost/server-settings.mjs';

test('admin CIDRs are validated, persisted and reused when update omits the option', () => {
  assert.deepEqual(normalizeAdminCidrs('198.51.100.0/24, 2001:db8::/32,198.51.100.0/24'), ['198.51.100.0/24', '2001:db8::/32']);
  assert.deepEqual(normalizeAdminCidrs('none'), []);
  for (const value of ['invalid', '198.51.100.8', '198.51.100.0/33', '2001:db8::/129']) assert.throws(() => normalizeAdminCidrs(value), /CIDR/);
  const persisted = serverSettings(['198.51.100.0/24']);
  assert.deepEqual(resolveAdminCidrs({ settingsText: persisted }), ['198.51.100.0/24']);
  assert.deepEqual(resolveAdminCidrs({ provided: 'none', settingsText: persisted }), []);
  assert.deepEqual(resolveAdminCidrs({ provided: '192.0.2.10/32', settingsText: persisted }), ['192.0.2.10/32']);
  assert.throws(() => resolveAdminCidrs({ settingsText: '{"version":1,"adminCidrs":"bad"}' }), /内容无效/);
});

test('legacy generated Caddyfiles migrate their admin whitelist before regeneration', () => {
  const text = caddyConfig('desk.example.com', { adminCidrs: ['198.51.100.0/24', '192.0.2.10/32'] });
  assert.deepEqual(caddyAdminCidrs(text), ['198.51.100.0/24', '192.0.2.10/32']);
  assert.deepEqual(resolveAdminCidrs({ caddyText: text }), ['198.51.100.0/24', '192.0.2.10/32']);
  assert.deepEqual(resolveAdminCidrs({ caddyText: caddyConfig('desk.example.com') }), []);
});
