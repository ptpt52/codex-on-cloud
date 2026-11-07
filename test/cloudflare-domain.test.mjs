import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareDomainPlan, assertManagedIngress, renamedDNSRecord } from '../native/cloudflare-domain.mjs';
test('domain changes require explicit intent, preserve the owned tunnel and resume only the pending target', () => {
  const state = { hostname: 'remote.example.com', accountId: 'account', zoneId: 'zone', tunnelId: 'tunnel', dnsRecordId: 'old-record' };
  const options = { domain: 'home.example.com', accountId: 'account', zoneId: 'zone' };
  assert.equal(cloudflareDomainPlan(null, options), null);
  assert.throws(() => cloudflareDomainPlan(state, options), /--rename/);
  assert.throws(() => cloudflareDomainPlan(state, { ...options, rename: true, zoneId: 'other' }), /区域/);
  const next = cloudflareDomainPlan(state, { ...options, rename: true }); assert.equal(next.tunnelId, state.tunnelId); assert.equal(next.previousHostname, state.hostname);
  assert.deepEqual(cloudflareDomainPlan(next, options), next);
  assert.throws(() => cloudflareDomainPlan(next, { ...options, domain: 'third.example.com', rename: true }), /尚未完成/);
  assertManagedIngress(next, { config: { ingress: [{ hostname: state.hostname }, { service: 'http_status:404' }] } });
  assert.throws(() => assertManagedIngress(next, { config: { ingress: [{ hostname: 'unrelated.example.com' }] } }), /不会覆盖/);
  const old = { id: 'old-record', name: state.hostname, type: 'CNAME', content: 'tunnel.cfargotunnel.com' };
  assert.equal(renamedDNSRecord(next, [old]), old);
  for (const wrong of [{ ...old, content: 'another.cfargotunnel.com' }, { ...old, id: 'other-record' }, { ...old, name: 'unrelated.example.com' }]) assert.equal(renamedDNSRecord(next, [wrong]), null);
});
