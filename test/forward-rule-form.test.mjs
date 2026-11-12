import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardRuleDefaults, forwardRuleName, forwardRuleType } from '../panel/public/forward-rule-form.js';
import { validateForwardRule } from '../panel/forward-validation.mjs';
import { fixture } from './fixture.mjs';

const rule = (direction, localPort, enabled = true, name = '') => ({ enabled, name, config: { ...(direction === 'reverse' ? { direction } : {}), localPort } });
test('automatic listener ports reserve all node rules but only the selected helper namespace', () => {
  const agents = [{ id: 'a', name: '助手1', rules: [rule('reverse', 22001), rule('forward', 2222, false)] },
    { id: 'b', name: '助手2', rules: [rule('reverse', 22002, false), rule('forward', 2223)] }];
  assert.deepEqual(forwardRuleDefaults(agents, 'a', 'reverse', 'ssh', { reservedPorts: [22003] }), { localPort: 22004, name: '助手1 SSH 22004' });
  assert.deepEqual(forwardRuleDefaults(agents, 'a', 'forward', 'https', { reservedPorts: [2223] }), { localPort: 2223, name: '助手1 HTTPS 2223' });
  assert.equal(forwardRuleDefaults(agents, 'b', 'forward', 'http').localPort, 2222);
  assert.equal(forwardRuleDefaults(agents, 'a', 'reverse', 'serial', { mappings: [{ direction: 'reverse', localPort: 22003 }] }).localPort, 22004);
});
test('automatic names avoid saved names, remain bounded and type inference preserves explicit service types', () => {
  const agents = [{ id: 'a', name: '助手1', rules: [{ name: '助手1 SSH 22001' }, { name: '助手1 SSH 22001 (2)' }] }];
  assert.equal(forwardRuleName(agents, 'a', 'ssh', 22001), '助手1 SSH 22001 (3)');
  assert.ok(forwardRuleName([{ id: 'a', name: '长'.repeat(48), rules: [] }], 'a', 'https', 22001).length <= 48);
  assert.equal(forwardRuleType({ protocol: 'https', targetPort: 8443 }), 'https');
  assert.equal(forwardRuleType({ protocol: 'tcp', targetPort: 443 }), 'tcp');
  assert.equal(forwardRuleType({ targetPort: 22 }), 'ssh'); assert.equal(forwardRuleType({ targetPort: 443 }), 'https');
});
test('automatic listener search is bounded and wraps through the allowed port range', () => {
  const reservedPorts = Array.from({ length: 65535 - 1024 + 1 }, (_, i) => 1024 + i);
  assert.equal(forwardRuleDefaults([], '', 'reverse', 'tcp', { reservedPorts }).localPort, null);
  reservedPorts.splice(reservedPorts.indexOf(1500), 1);
  assert.equal(forwardRuleDefaults([], '', 'reverse', 'tcp', { reservedPorts }).localPort, 1500);
});
test('HTTP and HTTPS rule labels persist in both directions without permitting forward serial or extra fields', () => {
  for (const direction of ['forward', 'reverse']) for (const protocol of ['ssh', 'telnet', 'http', 'https', 'tcp']) {
    const config = { ...(direction === 'reverse' ? { direction, deviceName: '设备' } : {}), localPort: 22001, protocol, targetHost: '127.0.0.1', targetPort: 8443 };
    const saved = validateForwardRule(config); assert.equal(saved.protocol, protocol); assert.equal(saved.targetPort, 8443);
    assert.throws(() => validateForwardRule({ ...config, protocol: 'udp' }), /协议/);
    assert.throws(() => validateForwardRule({ ...config, command: 'must not execute' }));
  }
  assert.throws(() => validateForwardRule({ localPort: 22001, protocol: 'serial', targetPort: 22 }));
});

test('the browser policy API carries reserved listener ports through to automatic defaults without exposing them to temporary accounts', async t => {
  const app = await fixture({ forwardPorts: '*' }); t.after(() => app.close());
  app.config.tunnelMetricsPort = 22001; app.config.fileAgentPort = 22002;
  await app.login();
  const response = await app.request('/api/forward'); assert.equal(response.status, 200);
  const policy = await response.json(); assert.ok(policy.reservedPorts.includes(22001)); assert.ok(policy.reservedPorts.includes(22002));
  const { agents } = await (await app.request('/api/forward/agents')).json();
  assert.equal(forwardRuleDefaults(agents, agents[0].id, 'reverse', 'ssh', policy).localPort, 22003);
  assert.equal(Object.hasOwn(policy, 'mappings'), false);
  await app.claim();
  assert.equal((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'synthetic_guest_password', durationMs: 300000 } })).status, 200);
  const login = await app.request('/api/login', { method: 'POST', body: { username: 'visitor', password: 'synthetic_guest_password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const restricted = await app.request('/api/forward', { headers: { cookie } }); assert.equal(restricted.status, 200);
  assert.equal(Object.hasOwn(await restricted.json(), 'reservedPorts'), false);
});
