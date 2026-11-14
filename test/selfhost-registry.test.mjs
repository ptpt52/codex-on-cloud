import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfhostRegistry } from '../selfhost/registry.mjs';
import { SELFHOST_LIMITS } from '../selfhost/protocol.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

async function setup(t, { host = 'desk.example.test', now = Date.now() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-registry-'));
  const clock = { value: now }, closed = [];
  const registry = await new SelfhostRegistry({ file: join(directory, 'state.json'), host, now: () => clock.value,
    onClose: async (slug, reason) => closed.push({ slug, reason }) }).open();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, registry, clock, closed };
}

const metadata = (credential, slug, nodeId) => ({ credential, slug, nodeId });

test('registry admission bounds pending writes and reserves space for revocation', async t => {
  const { registry } = await setup(t), key = await registry.createKey({ name: 'Revocable', slug: 'revocable' });
  let release; registry.queue = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const ordinary = SELFHOST_LIMITS.mutations - SELFHOST_LIMITS.mutationReserve;
  assert(ordinary > 0 && ordinary < 64);
  const writes = Array.from({ length: ordinary }, (_, i) => registry.createKey({ name: 'Queued', slug: 'queued-' + i }));
  const drained = Promise.allSettled(writes), tail = registry.queue;
  await assert.rejects(registry.createKey({ name: 'Overflow', slug: 'overflow' }), { status: 503, outcome: 'rejected' });
  assert.equal(registry.queue, tail, 'rejected writes must not extend the promise chain');
  const cleanup = Array.from({ length: SELFHOST_LIMITS.mutationReserve }, () => registry.revoke(key.id));
  const cleaned = Promise.allSettled(cleanup), full = registry.queue;
  await assert.rejects(registry.revoke(key.id), { status: 503 });
  assert.equal(registry.queue, full);
  release();
  assert((await drained).every(result => result.status === 'fulfilled'));
  assert((await cleaned).every(result => result.status === 'fulfilled'));
  assert.equal((await registry.list()).find(item => item.id === key.id).status, 'revoked');
  await registry.createKey({ name: 'After drain', slug: 'after-drain' });
});

test('invalid machine credentials never join the registry queue, even while storage is blocked', async t => {
  const { registry } = await setup(t), key = await registry.createKey({ name: 'Node', slug: 'node' });
  let release; const gate = registry.queue = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const join = registry.join({ version: 1, slug: key.slug, key: 'coc_' + 'x'.repeat(43), node: { id: 'a'.repeat(32), mode: 'terminal' } }).catch(error => error);
  const leave = registry.leave({ slug: key.slug, credential: 'cocn_' + 'x'.repeat(43) }).catch(error => error);
  assert.equal(registry.queue, gate);
  assert.equal((await join).status, 401); assert.equal((await leave).status, 401);
});

test('an admitted join revalidates its key after a queued revocation commits', async t => {
  const { registry } = await setup(t), key = await registry.createKey({ name: 'Node', slug: 'node' });
  let release; registry.queue = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const revoked = registry.revoke(key.id), joined = registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  const refused = assert.rejects(joined, { status: 401 });
  release(); await revoked; await refused;
  assert.equal(registry.sessions.size, 0);
});

test('a revoked key stays revoked in memory and closes its tunnel after a post-commit durability error', async t => {
  const { registry, directory, closed } = await setup(t), key = await registry.createKey({ name: 'Node', slug: 'node-a' });
  const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  const metas = metadata(joined.credential, key.slug, 'a'.repeat(32));
  await registry.authorizeLogin({ metas, runId: 'run' });
  await registry.authorizeProxy({ metas, runId: 'run', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] });
  assert.equal(await registry.routeAllowed(key.slug), true);
  const fsync = fs.fsyncSync; let failure;
  t.mock.method(fs, 'fsyncSync', descriptor => { if (fs.fstatSync(descriptor).isDirectory()) throw Error('simulated directory durability failure'); return fsync(descriptor); });
  syncBuiltinESMExports();
  try { await registry.revoke(key.id).catch(error => { failure = error; }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.match(failure?.message || '', /durability failure/);
  assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).keys[0].revokedAt > 0, true);
  assert.equal(await registry.routeAllowed(key.slug), false);
  assert.equal(await registry.authorizePing({ metas, runId: 'run' }), false);
  assert.deepEqual(closed, [{ slug: key.slug, reason: 'authorization_revoked' }]);
  assert.equal(failure.outcome, 'unknown');
  await registry.createKey({ name: 'Next node', slug: 'next' });
});

test('heartbeat cleanup still works for a legacy state at the byte limit without audit space to reclaim', async t => {
  const { directory, clock } = await setup(t), at = clock.value;
  const value = { version: 1, revision: 1, keys: [], audit: [] }, size = () => Buffer.byteLength(JSON.stringify(value) + '\n');
  for (let index = 0; ; index++) {
    value.keys.push({ id: index.toString(16).padStart(32, '0'), slug: 'n-' + index, name: 'N', keyHash: index.toString(16).padStart(64, '0'), credentialHash: null, createdAt: at, expiresAt: null, revokedAt: null });
    if (size() > SELFHOST_LIMITS.stateBytes) { value.keys.pop(); break; }
  }
  for (const key of value.keys) { key.name += 'x'.repeat(Math.min(79, SELFHOST_LIMITS.stateBytes - size())); if (size() === SELFHOST_LIMITS.stateBytes) break; }
  const file = join(directory, 'state.json'); await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  const closed = [], registry = await new SelfhostRegistry({ file, now: () => at + SELFHOST_LIMITS.heartbeatMs + 1, onClose: async slug => closed.push(slug) }).open();
  for (const key of value.keys.slice(0, 2)) registry.sessions.set(key.slug, { keyId: key.id, status: 'online', lastSeenAt: at });
  assert.equal(await registry.sweep(), true); assert.equal(registry.sessions.size, 0); assert.equal(closed.length, 2);
  assert.equal((await registry.list()).length, value.keys.length);
  assert(Buffer.byteLength(await readFile(file)) <= SELFHOST_LIMITS.stateBytes);
});

test('cleanup attempts every tunnel close even if an earlier close fails', async t => {
  const { registry, clock } = await setup(t), attempted = [];
  for (const slug of ['first', 'second']) { const key = await registry.createKey({ name: slug, slug }); registry.sessions.set(slug, { keyId: key.id, status: 'online', lastSeenAt: clock.value }); }
  registry.onClose = async slug => { attempted.push(slug); if (slug === 'first') throw Error('tunnel close failed'); };
  clock.value += SELFHOST_LIMITS.heartbeatMs + 1;
  await assert.rejects(registry.sweep(), /tunnel close failed/);
  assert.deepEqual(attempted, ['first', 'second']); assert.equal(registry.sessions.size, 0);
});

test('registry authorization is checked again before publishing an asynchronous mutation', async t => {
  const { registry, directory } = await setup(t);
  await registry.createKey({ name: 'Original', slug: 'original' });
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  let permitted = true, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const result = registry.mutate(async ({ value }) => { entered(); await gate; value.keys[0].name = 'Unauthorized change'; }, {
    valid() { if (!permitted) throw Object.assign(Error('Session revoked'), { status: 401 }); },
  });
  await started; permitted = false; release(); await assert.rejects(result, { status: 401 });
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
  assert.equal((await registry.list())[0].name, 'Original');
});

test('the online owner can refresh configuration without resetting its live lease or admitting a second peer', async t => {
  const { registry } = await setup(t), key = await registry.createKey({ name: 'online', slug: 'online' }), node = { id: 'a'.repeat(32), mode: 'terminal' };
  const first = await registry.join({ version: 1, slug: key.slug, key: key.key, node });
  const metas = { credential: first.credential, slug: key.slug, nodeId: node.id, mode: node.mode }, runId = 'original-run';
  assert.equal(await registry.authorizeLogin({ metas, runId }), true);
  assert.equal(await registry.authorizeProxy({ metas, runId, name: 'node-online', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/online/'] }), true);
  const before = structuredClone(registry.sessions.get(key.slug));
  const refreshed = await registry.join({ version: 1, slug: key.slug, credential: first.credential, node });
  assert.equal(refreshed.credential, first.credential); assert.deepEqual(registry.sessions.get(key.slug), before);
  await assert.rejects(registry.join({ version: 1, slug: key.slug, credential: first.credential, node: { ...node, id: 'b'.repeat(32) } }), { status: 409 });
  await assert.rejects(registry.join({ version: 1, slug: key.slug, key: key.key, node }), { status: 409 });
  assert.equal(await registry.authorizeLogin({ metas, runId: 'second-run', proxyOnline: async () => true }), false);
  assert.equal(await registry.routeAllowed(key.slug), true);
});

test('a full legacy state can revoke a key without dropping authorizations or exceeding its byte bound', async t => {
  const { directory, clock } = await setup(t), at = clock.value;
  const value = { version: 1, revision: 1, keys: [], audit: Array.from({ length: 512 }, () => ({ at, type: 'key_created', slug: 'n-0' })) };
  const size = () => Buffer.byteLength(JSON.stringify(value) + '\n');
  for (let i = 0; ; i++) {
    value.keys.push({ id: i.toString(16).padStart(32, '0'), slug: 'n-' + i, name: 'N', keyHash: i.toString(16).padStart(64, '0'), credentialHash: null, createdAt: at, expiresAt: null, revokedAt: null });
    if (size() > SELFHOST_LIMITS.stateBytes) { value.keys.pop(); break; }
  }
  for (const key of value.keys) { key.name += 'x'.repeat(Math.min(79, SELFHOST_LIMITS.stateBytes - size())); if (size() === SELFHOST_LIMITS.stateBytes) break; }
  const file = join(directory, 'state.json'); await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  const closed = [], registry = await new SelfhostRegistry({ file, onClose: async slug => closed.push(slug), now: () => at }).open();
  const last = value.keys.at(-1); await registry.revoke(last.id);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.keys.length, value.keys.length); assert.equal(saved.keys.at(-1).revokedAt, at);
  assert.equal(saved.audit.at(-1).type, 'key_revoked'); assert(saved.audit.length < 512);
  assert(Buffer.byteLength(await readFile(file)) <= SELFHOST_LIMITS.stateBytes); assert.deepEqual(closed, [last.slug]);
  await new SelfhostRegistry({ file }).open();
  await registry.createKey({ name: 'more', slug: 'more' });
  const next = JSON.parse(await readFile(file, 'utf8'));
  assert(SELFHOST_LIMITS.stateBytes - Buffer.byteLength(await readFile(file)) >= 2048 + next.keys.filter(item => !item.revokedAt).length * 16);
  assert.equal((await registry.list()).length, value.keys.length + 1);
});

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

test('more than sixty-four nodes can join, recover and appear in the public directory', async t => {
  const { registry, directory } = await setup(t), joined = [];
  for (let index = 0; index < 66; index++) {
    const slug = 'node-' + index, key = await registry.createKey({ name: slug, slug });
    const nodeId = index.toString(16).padStart(32, '0');
    const value = await registry.join({ version: 1, slug, key: key.key, node: { id: nodeId, mode: 'terminal' } });
    const metas = metadata(value.credential, slug, nodeId), runId = 'run-' + index;
    assert.equal(await registry.authorizeLogin({ metas, runId }), true);
    assert.equal(await registry.authorizeProxy({ metas, runId, name: 'node-' + slug, type: 'http', customDomains: ['desk.example.test'], locations: ['/node/' + slug + '/'] }), true);
    joined.push({ metas, runId });
  }
  assert.equal((await registry.status()).onlineNodes, 66);
  assert.equal((await registry.status()).maximumNodes, null);
  assert.equal(registry.publicNodes().length, 66);
  await registry.closeProxy(joined[0]);
  await registry.join({ version: 1, slug: joined[0].metas.slug, credential: joined[0].metas.credential, node: { id: joined[0].metas.nodeId, mode: 'terminal' } });
  const reopened = await new SelfhostRegistry({ file: join(directory, 'state.json'), host: 'desk.example.test' }).open();
  // frpc Login alone must also recover saved credentials beyond the old limit.
  for (const item of joined) assert.equal(await reopened.authorizeLogin(item), true);
  assert.equal((await reopened.status()).connectingNodes, 66);
});

test('authorization storage has byte and audit bounds without a fixed record count', async t => {
  const { registry, directory } = await setup(t);
  await registry.createKey({ name: 'Node', slug: 'seed' });
  const disk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  disk.keys = Array.from({ length: 512 }, (_, index) => ({ ...disk.keys[0], id: index.toString(16).padStart(32, '0'), slug: 'node-' + index }));
  await writeFile(join(directory, 'state.json'), JSON.stringify(disk), { mode: 0o600 });
  const reopened = await new SelfhostRegistry({ file: join(directory, 'state.json') }).open();
  await reopened.createKey({ name: '513th', slug: 'over-old-record-limit' });
  assert.equal((await reopened.list()).length, 513);
  assert(Buffer.byteLength(await readFile(join(directory, 'state.json'))) <= SELFHOST_LIMITS.stateBytes);
});

test('a fresh frps recovery handshake survives sweeping after a long online session', async t => {
  const { registry, clock } = await setup(t), key = await registry.createKey({ name: '恢复节点', slug: 'recover' });
  const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
  const metas = metadata(joined.credential, key.slug, 'a'.repeat(32));
  const proxy = { metas, name: 'node-recover', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/recover/'] };
  await registry.authorizeLogin({ metas, runId: 'old' }); await registry.authorizeProxy({ ...proxy, runId: 'old' });
  clock.value += SELFHOST_LIMITS.connectMs + 60000;
  await registry.authorizePing({ metas, runId: 'old' });
  assert.equal(await registry.authorizeLogin({ metas, runId: 'new', proxyOnline: async () => false }), true);
  assert.equal((await registry.list())[0].status, 'authenticated');
  assert.equal((await registry.list())[0].session.connectedAt, clock.value);
  assert.equal(await registry.sweep(), false);
  assert.equal(await registry.authorizeProxy({ ...proxy, runId: 'new' }), true);
  await registry.closeProxy({ metas, runId: 'new' });
  clock.value += 1000;
  assert.equal(await registry.authorizeLogin({ metas, runId: 'grace' }), true);
  assert.equal((await registry.list())[0].session.connectedAt, clock.value);
  assert.equal(await registry.authorizePing({ metas, runId: 'new' }), false);
  clock.value += SELFHOST_LIMITS.connectMs + 1;
  assert.equal(await registry.sweep(), true); // Failed new handshakes still expire.
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
