import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createForwarding } from '../panel/forward.mjs';
import { createForwardAgentState, AGENT_LIMITS } from '../panel/forward-agent-state.mjs';

const config = { port: 36080, agentPort: 36902, fileAgentPort: 36904, tunnelMetricsPort: 20241, forwardPorts: '*' };
const identity = { entry: 'https://desk.example/node/office/', id: 'a'.repeat(32) };
const decode = key => JSON.parse(Buffer.from(key.slice('COCA1.'.length), 'base64url'));
const token = key => { const v = decode(key); return v.agent + '.' + v.secret; };
const rule = (agentId, port = 2222, extra = {}) => ({ agentId, name: 'SSH', enabled: true, config: { localPort: port, targetHost: '192.168.1.1', targetPort: 22 }, ...extra });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-agent-state-')), forwarding = createForwarding(config);
  t.after(async () => { await forwarding.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, forwarding, open: () => createForwardAgentState(directory, forwarding.validate, identity) };
}

test('helper keys are independently revocable, bound to the node entry, and persisted only as hashes', async t => {
  const { directory, open } = await setup(t), state = open();
  const a = state.create({ name: '办公室电脑' }), b = state.create({ name: '测试电脑' });
  assert.equal(decode(a.key).server, identity.entry); assert.equal(decode(a.key).node, identity.id);
  assert.equal(state.authenticate(token(a.key)).name, '办公室电脑');
  assert.equal(state.authenticate(token(b.key)).name, '测试电脑');
  const bytes = await readFile(join(directory, 'forward-agents.json'), 'utf8');
  assert(!bytes.includes(decode(a.key).secret)); assert(!bytes.includes(a.key));
  assert.equal((await stat(join(directory, 'forward-agents.json'))).mode & 0o777, 0o600);
  assert(open().authenticate(token(a.key)));
  const next = state.rekey({ id: a.id });
  assert.equal(state.authenticate(token(a.key)), null); assert(state.authenticate(token(next.key)));
  assert(state.authenticate(token(b.key)));
  state.remove({ id: a.id });
  assert.equal(open().authenticate(token(next.key)), null); assert(open().authenticate(token(b.key)));
});

test('desired rules survive reopening and reject stale edits, shared listener conflicts and duplicate serial devices', async t => {
  const { open } = await setup(t), state = open(), a = state.create({ name: 'A' }), b = state.create({ name: 'B' });
  const first = state.saveRule(rule(a.id)); state.saveRule(rule(b.id)); // Same local port, different helper computers.
  assert.throws(() => state.saveRule(rule(a.id)), /监听端口/);
  const changed = state.saveRule(rule(a.id, 2223, { id: first.id, revision: first.revision }));
  assert.equal(changed.revision, 2);
  assert.throws(() => state.saveRule(rule(a.id, 2224, { id: first.id, revision: first.revision })), /已更新/);
  assert.equal(open().find(a.id).rules[0].config.localPort, 2223);
  const reverse = { direction: 'reverse', deviceName: '路由器', protocol: 'ssh', localPort: 22001, targetHost: '192.168.1.1', targetPort: 22 };
  state.saveRule(rule(a.id, 0, { config: reverse }));
  assert.throws(() => state.saveRule(rule(b.id, 0, { config: reverse })), /监听端口/);
  const serial = { direction: 'reverse', protocol: 'serial', deviceName: '串口', localPort: 22002, serial: { path: 'COM3', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false } };
  state.saveRule(rule(a.id, 0, { config: serial }));
  assert.throws(() => state.saveRule(rule(a.id, 0, { config: { ...serial, localPort: 22003 } })), /同一个串口/);
  assert.throws(() => state.removeRule({ agentId: a.id, id: first.id, revision: 1 }), /已变化/);
  state.removeRule({ agentId: a.id, id: first.id, revision: 2 });
  assert(!open().find(a.id).rules.some(r => r.id === first.id));
});

test('bounded helper and rule stores reject malformed input without creating extra files', async t => {
  const { open, directory } = await setup(t), state = open();
  assert.throws(() => state.create({ name: 'bad\u001bname' }), /名称/);
  assert.throws(() => state.create({ name: 'A', secret: 'injected' }), /名称/);
  for (let i = 0; i < AGENT_LIMITS.agents; i++) state.create({ name: String(i) });
  assert.throws(() => state.create({ name: 'overflow' }), /最多保留/);
  const agentId = state.all()[0].id;
  assert.throws(() => state.saveRule(rule(agentId, 0, { config: { localPort: 2222, targetHost: 'example.com', targetPort: 22 } })), /目标 IP/);
  for (let i = 0; i < AGENT_LIMITS.rules; i++) state.saveRule(rule(agentId, 2000 + i));
  assert.throws(() => state.saveRule(rule(agentId, 3000)), /最多保存/);
  assert.equal(state.authenticate('not-a-key'), null);
  assert((await stat(join(directory, 'forward-agents.json'))).size <= AGENT_LIMITS.file);
});

test('changed target policies do not prevent startup, but still reject applying disallowed rules', async t => {
  const { open, directory } = await setup(t), state = open(), a = state.create({ name: 'A' });
  state.saveRule(rule(a.id));
  const restricted = createForwarding({ ...config, forwardPorts: [443] }); t.after(() => restricted.close());
  const reopened = createForwardAgentState(directory, restricted.validate, identity);
  assert.equal(reopened.find(a.id).rules.length, 1);
  assert.throws(() => restricted.create(reopened.find(a.id).rules[0].config, 'managed', () => '', { helperId: a.id }), /目标端口/);
});

test('helper state rejects links, unsafe permissions and oversized input before loading', async t => {
  const { directory, open } = await setup(t), file = join(directory, 'forward-agents.json');
  open().create({ name: 'A' });
  await chmod(file, 0o644); assert.throws(open, /无法读取/);
  await chmod(file, 0o600); await writeFile(file, Buffer.alloc(AGENT_LIMITS.file + 1)); assert.throws(open, /无法读取/);
  await rm(file); await symlink('missing', file); assert.throws(open, /无法读取/);
});
