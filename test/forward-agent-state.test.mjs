import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createForwarding } from '../panel/forward.mjs';
import { createForwardAgentState, AGENT_LIMITS } from '../panel/forward-agent-state.mjs';

const config = { port: 36080, agentPort: 36902, fileAgentPort: 36904, tunnelMetricsPort: 20241, forwardPorts: '*' };
const identity = { entry: 'https://desk.example/node/office/', id: 'a'.repeat(32) };
const decode = key => JSON.parse(Buffer.from(key.slice('COCA2.'.length), 'base64url'));
const token = key => { const v = decode(key); return v.agent + '.' + v.secret; };
const rule = (agentId, port = 2222, extra = {}) => ({ agentId, name: 'SSH', enabled: true, config: { localPort: port, targetHost: '192.168.1.1', targetPort: 22 }, ...extra });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-agent-state-')), forwarding = createForwarding(config);
  t.after(async () => { await forwarding.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, forwarding, open: () => createForwardAgentState(directory, forwarding.validate, identity) };
}

test('fresh state creates exactly eight stable slots and administrator-readable independently rotatable keys', async t => {
  const { directory, open } = await setup(t), state = open();
  assert.equal(state.all().length, 8); assert.deepEqual(state.all().map(a => a.name), Array.from({ length: 8 }, (_, i) => '助手' + (i + 1)));
  const [a, b] = state.all(), first = state.key({ id: a.id }), second = state.key({ id: b.id });
  assert.equal(decode(first.key).server, identity.entry); assert.equal(decode(first.key).node, identity.id);
  assert.equal(state.authenticate(token(first.key)).slot, 1); assert.equal(state.authenticate(token(second.key)).slot, 2);
  assert.equal((await stat(join(directory, 'forward-agents.json'))).mode & 0o777, 0o600);
  assert.equal(open().key({ id: a.id }).key, first.key); assert.equal(state.key({ id: a.id }).key, first.key);
  const next = state.rekey({ id: a.id, revision: first.revision });
  assert.equal(state.authenticate(token(first.key)), null); assert(state.authenticate(token(next.key))); assert(state.authenticate(token(second.key)));
  assert.equal(open().all().length, 8); assert.equal(open().key({ id: a.id }).key, next.key);
  assert.throws(() => state.rekey({ id: a.id, revision: first.revision }), /已重新生成/);
  assert.equal(typeof state.create, 'undefined'); assert.equal(typeof state.remove, 'undefined');
});

test('per-helper temporary key visibility is opt-in, persistent and independent of key and rule revisions', async t => {
  const { open } = await setup(t), state = open(), [a, b] = state.all();
  assert(state.all().every(agent => agent.temporaryKeyVisible === false && agent.visibilityRevision === 1));
  const key = state.key({ id: a.id }), saved = state.saveRule(rule(a.id));
  const visibility = state.visibility({ id: a.id, revision: 1, visible: true });
  assert.deepEqual(visibility, { visible: true, revision: 2 });
  assert.equal(open().find(a.id).temporaryKeyVisible, true); assert.equal(open().find(b.id).temporaryKeyVisible, false);
  assert.equal(state.key({ id: a.id }).key, key.key); assert.equal(state.find(a.id).rules[0].revision, saved.revision);
  assert.throws(() => state.visibility({ id: a.id, revision: 1, visible: false }), { status: 409 });
  for (const visible of ['true', 1, null]) assert.throws(() => state.visibility({ id: a.id, revision: 2, visible }), { status: 400 });
  const next = state.rekey({ id: a.id, revision: key.revision }); assert.notEqual(next.key, key.key);
  assert.equal(state.find(a.id).temporaryKeyVisible, true); assert.equal(state.find(a.id).visibilityRevision, 2);
  state.visibility({ id: a.id, revision: 2, visible: false }); assert.equal(open().find(a.id).temporaryKeyVisible, false);
});

test('existing fixed-slot state gains private-by-default visibility without replacing any key', async t => {
  const { directory, open } = await setup(t), state = open(), keys = state.all().map(a => state.key({ id: a.id }).key);
  const file = join(directory, 'forward-agents.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  for (const a of saved.agents) { delete a.temporaryKeyVisible; delete a.visibilityRevision; }
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const reopened = open(); assert(reopened.all().every(a => !a.temporaryKeyVisible && a.visibilityRevision === 1));
  assert.deepEqual(reopened.all().map(a => reopened.key({ id: a.id }).key), keys);
  saved.agents[0].temporaryKeyVisible = 'false'; await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  assert.throws(open, /助手配置无法读取/);
});

test('desired rules survive reopening and reject stale edits, shared listener conflicts and duplicate serial devices', async t => {
  const { open } = await setup(t), state = open(), [a, b] = state.all();
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
  assert.equal(state.all().length, AGENT_LIMITS.agents);
  const agentId = state.all()[0].id;
  assert.throws(() => state.saveRule(rule(agentId, 0, { config: { localPort: 2222, targetHost: 'example.com', targetPort: 22 } })), /目标 IP/);
  for (let i = 0; i < AGENT_LIMITS.rules; i++) state.saveRule(rule(agentId, 2000 + i));
  assert.throws(() => state.saveRule(rule(agentId, 3000)), /最多保存/);
  assert.equal(state.authenticate('not-a-key'), null);
  assert((await stat(join(directory, 'forward-agents.json'))).size <= AGENT_LIMITS.file);
});

test('changed target policies do not prevent startup, but still reject applying disallowed rules', async t => {
  const { open, directory } = await setup(t), state = open(), [a] = state.all();
  state.saveRule(rule(a.id));
  const restricted = createForwarding({ ...config, forwardPorts: [443] }); t.after(() => restricted.close());
  const reopened = createForwardAgentState(directory, restricted.validate, identity);
  assert.equal(reopened.find(a.id).rules.length, 1);
  assert.throws(() => restricted.create(reopened.find(a.id).rules[0].config, 'managed', () => '', { helperId: a.id }), /目标端口/);
});

test('helper state rejects links, unsafe permissions and oversized input before loading', async t => {
  const { directory, open } = await setup(t), file = join(directory, 'forward-agents.json');
  open();
  await chmod(file, 0o644); assert.throws(open, /无法读取/);
  await chmod(file, 0o600); await writeFile(file, Buffer.alloc(AGENT_LIMITS.file + 1)); assert.throws(open, /无法读取/);
  await rm(file); await symlink('missing', file); assert.throws(open, /无法读取/);
});

test('old configurations are rejected and never silently migrated or erased', async t => {
  const { directory, open } = await setup(t), file = join(directory, 'forward-agents.json');
  await writeFile(file, JSON.stringify({ version: 1, agents: [] }), { mode: 0o600 });
  assert.throws(open, /仅支持全新配置/); assert.equal(JSON.parse(await readFile(file)).version, 1);
});
