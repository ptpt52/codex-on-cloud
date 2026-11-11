import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfhostRegistry } from '../selfhost/registry.mjs';
import { SELFHOST_LIMITS } from '../selfhost/protocol.mjs';

async function setup(t, { host = 'desk.example.test', now = Date.now() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-registry-'));
  const clock = { value: now }, closed = [];
  const registry = await new SelfhostRegistry({ file: join(directory, 'state.json'), host, now: () => clock.value,
    onClose: async (slug, reason) => closed.push({ slug, reason }) }).open();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, registry, clock, closed };
}

const metadata = (credential, slug, nodeId) => ({ credential, slug, nodeId });

test('authorization keys are returned once while state contains only hashes and survives restart', async t => {
  const { directory, registry } = await setup(t), future = Date.now() + 60000;
  const finite = await registry.createKey({ name: '深圳测试机', slug: 'shenzhen-test', expiresAt: future });
  const infinite = await registry.createKey({ name: '永久节点', slug: 'permanent-node', expiresAt: null });
  assert.match(finite.key, /^coc_[A-Za-z0-9_-]{43}$/);
  assert.equal(finite.path, '/node/shenzhen-test/');
  assert.equal(infinite.expiresAt, null);
  const disk = await readFile(join(directory, 'state.json'), 'utf8');
  assert(!disk.includes(finite.key)); assert(!disk.includes(infinite.key));
  assert.match(disk, /"keyHash":"[a-f0-9]{64}"/);

  const reopened = await new SelfhostRegistry({ file: join(directory, 'state.json'), host: 'desk.example.test' }).open();
  const list = await reopened.list();
  assert.deepEqual(list.map(item => item.slug).sort(), ['permanent-node', 'shenzhen-test']);
  assert(list.every(item => !('key' in item) && !('keyHash' in item) && !('credentialHash' in item)));
  await assert.rejects(registry.createKey({ name: '重复', slug: 'shenzhen-test' }), /已有授权/);
  await assert.rejects(registry.createKey({ name: '坏路径', slug: '../escape' }), /节点路径/);
});

test('one slug has one live connection, resumes only in its grace window, and then releases the name', async t => {
  const { registry, clock } = await setup(t), key = await registry.createKey({ name: '节点 A', slug: 'node-a' });
  const first = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' }, source: '192.0.2.10' });
  assert.match(first.credential, /^cocn_[A-Za-z0-9_-]{43}$/);
  await assert.rejects(registry.join({ version: 1, slug: key.slug, credential: first.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } }), /已有在线连接/);
  assert.equal(await registry.authorizeLogin({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a' }), true);
  assert.equal(await registry.authorizeProxy({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] }), true);
  assert.equal((await registry.list())[0].status, 'online');
  await registry.closeProxy({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a' });
  assert.equal((await registry.list())[0].status, 'grace');
  const resumed = await registry.join({ version: 1, slug: key.slug, credential: first.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  assert.equal(resumed.credential, first.credential);

  assert.equal(await registry.authorizeLogin({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a2' }), true);
  assert.equal(await registry.authorizeProxy({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a2', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] }), true);
  await registry.closeProxy({ metas: metadata(first.credential, key.slug, 'a'.repeat(32)), runId: 'run-a2' });
  clock.value += SELFHOST_LIMITS.graceMs + 1;
  const released = await registry.join({ version: 1, slug: key.slug, credential: first.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  assert.equal(released.credential, first.credential);
});

test('frp login and proxy authorization require the exact node, host, proxy and location', async t => {
  const { registry } = await setup(t), key = await registry.createKey({ name: '节点 A', slug: 'node-a' });
  const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'desktop' } });
  const metas = metadata(joined.credential, key.slug, 'a'.repeat(32));
  assert.equal(await registry.authorizeLogin({ metas: metadata(joined.credential, key.slug, 'invalid'), runId: 'bad-run' }), false);
  assert.equal(await registry.authorizeLogin({ metas, runId: '' }), true);
  const proxy = { metas, runId: 'run-a', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] };
  assert.equal(await registry.authorizeProxy({ ...proxy, runId: 'wrong-run', customDomains: ['evil.example.test'] }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, customDomains: ['desk.example.test', 'evil.example.test'] }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, subdomain: 'extra' }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, httpUser: 'private' }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, hostHeaderRewrite: 'evil.example.test' }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, locations: ['/node/node-a'] }), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, name: 'other' }), false);
  assert.equal(await registry.authorizeProxy(proxy), true);
  assert.equal((await registry.list())[0].status, 'online');
  assert.equal(await registry.authorizeLogin({ metas, runId: 'run-b' }), false);
  assert.equal(await registry.authorizeLogin({ metas, runId: 'run-b', proxyOnline: async () => true }), false);
  assert.equal(await registry.authorizePing({ metas, runId: 'run-a' }), true);
  assert.equal(await registry.authorizeLogin({ metas, runId: 'run-b', proxyOnline: async () => false }), true);
  assert.equal(await registry.authorizeProxy({ ...proxy, runId: 'run-b' }), true);
});

test('revocation immediately removes the session, invalidates its credential and requests a tunnel close', async t => {
  const { registry, closed } = await setup(t), key = await registry.createKey({ name: '节点 A', slug: 'node-a' });
  const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  await registry.revoke(key.id);
  assert.deepEqual(closed, [{ slug: 'node-a', reason: 'authorization_revoked' }]);
  await assert.rejects(registry.join({ version: 1, slug: key.slug, credential: joined.credential, node: { id: 'a'.repeat(32), mode: 'terminal' } }), /授权已撤销/);
  assert.equal((await registry.list())[0].status, 'revoked');
});

test('the center refuses the sixty-fifth live node and counts only live sessions', async t => {
  const { registry } = await setup(t), joined = [];
  for (let index = 0; index < SELFHOST_LIMITS.nodes; index++) {
    const slug = 'node-' + index, key = await registry.createKey({ name: slug, slug }), value = await registry.join({ version: 1, slug, key: key.key, node: { id: index.toString(16).padStart(32, '0'), mode: 'terminal' } });
    joined.push({ slug, credential: value.credential, nodeId: index.toString(16).padStart(32, '0') });
  }
  const extra = await registry.createKey({ name: 'node-64', slug: 'node-64' });
  await assert.rejects(registry.join({ version: 1, slug: 'node-64', key: extra.key, node: { id: 'f'.repeat(32), mode: 'terminal' } }), /在线节点已达到上限/);
  await registry.closeProxy({ metas: metadata(joined[0].credential, joined[0].slug, joined[0].nodeId), runId: '' }); // Not online yet, remains non-live.
  const status = await registry.status();
  assert.equal(status.onlineNodes, 0);
  assert.equal(status.connectingNodes, SELFHOST_LIMITS.nodes);
});

test('explicit finite intent rejects missing dates and updates preserve revoked state and fixed paths', async t => {
  const { registry, clock } = await setup(t);
  for (const expiresAt of [null, undefined, '', NaN, clock.value - 1]) await assert.rejects(registry.createKey({ name: '有限期', slug: 'finite', neverExpires: false, expiresAt }), { status: 400 });
  await assert.rejects(registry.createKey({ name: '冲突期限', slug: 'bad', neverExpires: true, expiresAt: clock.value + 60000 }), { status: 400 });
  const key = await registry.createKey({ name: '原名称', slug: 'finite', neverExpires: false, expiresAt: clock.value + 60000 });
  const revision = (await registry.snapshot()).revision;
  const updated = await registry.updateKey(key.id, { name: '新名称', revision });
  assert.equal(updated.name, '新名称'); assert.equal(updated.path, key.path); assert.equal(updated.expiresAt, key.expiresAt);
  await assert.rejects(registry.updateKey(key.id, { name: '过时写入', revision }), { status: 409 });
  await assert.rejects(registry.reissueKey(key.id, { neverExpires: true, revision }), { status: 409 });
  await assert.rejects(registry.updateKey(key.id, { slug: 'changed' }), { status: 400 });
  await assert.rejects(registry.reissueKey(key.id, {}), { status: 400 });
  await assert.rejects(registry.updateKey(key.id, { neverExpires: false, expiresAt: null }), { status: 400 });
  await registry.revoke(key.id);
  assert.equal((await registry.updateKey(key.id, { name: '历史记录', neverExpires: true, expiresAt: null })).status, 'revoked');
  assert.equal((await registry.list()).length, 1);
});

test('reissue preserves node identity, rotates keys and invalidates live credentials immediately and after restart', async t => {
  const { registry, directory, closed } = await setup(t), key = await registry.createKey({ name: '节点 A', slug: 'node-a' });
  const input = { version: 1, slug: key.slug, node: { id: 'a'.repeat(32), mode: 'terminal' } };
  const joined = await registry.join({ ...input, key: key.key });
  const metas = metadata(joined.credential, key.slug, input.node.id);
  await registry.authorizeLogin({ metas, runId: 'old' });
  await registry.authorizeProxy({ metas, runId: 'old', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] });
  const fresh = await registry.reissueKey(key.id, { neverExpires: true, expiresAt: null, revision: (await registry.snapshot()).revision });
  assert.equal(fresh.id, key.id); assert.equal(fresh.path, key.path); assert.equal(fresh.createdAt, key.createdAt); assert.notEqual(fresh.key, key.key);
  assert.equal(await registry.routeAllowed(key.slug), false); assert.equal(await registry.authorizePing({ metas, runId: 'old' }), false);
  assert.equal(await registry.authorizeLogin({ metas, runId: 'old' }), false);
  assert.deepEqual(closed, [{ slug: key.slug, reason: 'authorization_reissued' }]);
  await assert.rejects(registry.join({ ...input, key: key.key }), { status: 401 });
  await assert.rejects(registry.join({ ...input, credential: joined.credential }), { status: 401 });
  const disk = await readFile(join(directory, 'state.json'), 'utf8');
  for (const secret of [key.key, fresh.key, joined.credential]) assert(!disk.includes(secret));
  assert.match(disk, /key_reissued/);
  const reopened = await new SelfhostRegistry({ file: join(directory, 'state.json'), host: 'desk.example.test' }).open();
  assert.equal((await reopened.list()).length, 1);
  await assert.rejects(reopened.join({ ...input, key: key.key }), { status: 401 });
  const next = await reopened.join({ ...input, key: fresh.key }); assert.notEqual(next.credential, joined.credential);
  await reopened.revoke(key.id); const restored = await reopened.reissueKey(key.id, { neverExpires: true });
  assert.equal(restored.revokedAt, null); assert.equal(restored.path, key.path);
});

test('overview separates connection stages and excludes stale online heartbeats', async t => {
  const { registry, clock } = await setup(t), key = await registry.createKey({ name: '节点', slug: 'node-a' });
  const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  assert.equal((await registry.snapshot()).status.connectingNodes, 1); assert.equal((await registry.status()).onlineNodes, 0);
  const metas = metadata(joined.credential, key.slug, 'a'.repeat(32));
  await registry.authorizeLogin({ metas, runId: 'r' }); assert.equal((await registry.status()).connectingNodes, 1);
  await registry.authorizeProxy({ metas, runId: 'r', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] });
  const snapshot = await registry.snapshot(); assert.equal(snapshot.status.onlineNodes, 1); assert.equal(snapshot.keys[0].status, 'online'); assert.equal(snapshot.revision, snapshot.status.revision);
  clock.value += SELFHOST_LIMITS.heartbeatMs + 1;
  assert.equal((await registry.status()).onlineNodes, 0); assert.equal((await registry.list())[0].session, null); assert.equal(await registry.routeAllowed(key.slug), false);
});
