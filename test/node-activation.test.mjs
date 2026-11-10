import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createNodeActivation, activationMarker } from '../scripts/node-activation.mjs';
import { createCloudflarePublication } from '../scripts/cloudflare-publication.mjs';

const account = 'a'.repeat(32), zone = 'b'.repeat(32), recordId = 'c'.repeat(32), domain = 'shared.example.test';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'node-activation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const tunnels = new Map([[id(1), { name: 'codex-on-cloud-shared', config: { ingress: [{ hostname: domain, service: 'http://127.0.0.1:36080' }, { service: 'http_status:404' }] } }]]);
  let dns = { id: recordId, type: 'CNAME', name: domain, content: id(1) + '.cfargotunnel.com', proxied: true, ttl: 1, comment: 'keep' }, failure, serial = 1;
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body: structuredClone(body) }); const fault = failure?.({ path, method, body });
    if (fault?.before) throw Error('synthetic lost request');
    let result;
    if (path === '/zones?name=example.test') result = [{ name: 'example.test', id: zone, account: { id: account } }];
    else if (path.startsWith('/accounts/' + account + '/cfd_tunnel?')) result = [...tunnels].filter(([, value]) => value.name === new URL(path, 'https://mock.test').searchParams.get('name')).map(([id, value]) => ({ id, name: value.name }));
    else if (path === '/accounts/' + account + '/cfd_tunnel' && method === 'POST') { const value = id(++serial); tunnels.set(value, { name: body.name, config: { ingress: [{ service: 'http_status:404' }] } }); result = { id: value }; }
    else if (path.startsWith('/accounts/' + account + '/cfd_tunnel/')) {
      const [, tunnelId, action] = path.match(/cfd_tunnel\/([^/]+)\/(token|configurations)$/) || [];
      const value = tunnels.get(tunnelId); assert(value, 'known mock tunnel');
      if (action === 'token') result = 'synthetic_tunnel_' + tunnelId;
      else { if (method === 'PUT') value.config = structuredClone(body.config); result = { config: structuredClone(value.config) }; }
    } else if (path.startsWith('/zones/' + zone + '/dns_records')) {
      if (method === 'GET') result = dns ? [structuredClone(dns)] : [];
      else if (['PUT', 'POST'].includes(method)) { dns = { id: recordId, ...structuredClone(body) }; result = structuredClone(dns); }
      else throw Error('unexpected DNS mutation');
    } else throw Error('unexpected mock API path');
    if (fault?.after) throw Error('synthetic lost acknowledgement'); return result;
  };
  async function host(n, { legacy = false, hooks = {} } = {}) {
    const root = join(directory, 'host-' + n); await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 }); await mkdir(join(root, 'secrets'), { mode: 0o700 });
    await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://' + domain + '\nMAX_TERMINALS=8\n', { mode: 0o600 });
    await writeFile(join(root, 'secrets/credentials.txt'), '工作台：https://' + domain + '\n密码：synthetic-only\n', { mode: 0o600 });
    if (legacy) await writeFile(join(root, 'data/cloudflare-deployment.json'), JSON.stringify({ hostname: domain, accountId: account, zoneId: zone, tunnelId: id(1), dnsRecordId: recordId }), { mode: 0o600 });
    const events = [], socketPath = '/tmp/mock-node-' + n + '.sock';
    const make = () => createNodeActivation({ root, socketPath, api,
      services: async value => { events.push({ panelChanged: value.panelChanged, tunnelChanged: value.tunnelChanged }); await hooks.services?.(value); },
      ready: async (_socket, hostname, nodeId) => { const env = parseEnv(await readFile(join(root, '.env'), 'utf8')); assert.equal(hostname, domain); assert.equal(env.NODE_ID, nodeId); assert.equal(env.SHARED_ENTRY, '1'); await hooks.ready?.(); },
      connected: async value => { await hooks.connected?.(value); },
      publicReady: async profile => { assert.equal(dns.content, profile.tunnelId + '.cfargotunnel.com'); await hooks.publicReady?.(); },
    });
    return { root, make, events, values: { domain, zone: 'example.test', tokenFile: join(directory, 'private-api-token') } };
  }
  return { host, api, calls, tunnels, get dns() { return dns; }, set dns(value) { dns = value; }, set failure(value) { failure = value; } };
}
const dnsWrites = h => h.calls.filter(call => call.path.includes('/dns_records') && call.method !== 'GET');

test('an existing owner initializes sharing, arbitrary new nodes activate without a fixed directory, and repeat activation reuses its tunnel and configuration', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values);
  const initial = activationMarker(h.dns.comment); assert.match(h.dns.comment, /^keep /); assert.equal(h.tunnels.size, 1);
  for (let n = 2; n <= 7; n++) {
    const node = await h.host(n), result = await node.make().activate(node.values);
    assert.equal(result.active, true); assert.equal(result.reachable, true); assert.equal(activationMarker(h.dns.comment).group, initial.group);
    assert.equal(h.tunnels.size, n); assert.equal((await node.make().status()).active, true); assert.equal((await a.make().status()).active, false);
    await node.make().activate({}); assert.equal(h.tunnels.size, n); assert.deepEqual(node.events.at(-1), { panelChanged: false, tunnelChanged: false });
  }
  await a.make().activate({}); assert.equal(h.tunnels.size, 7); assert.equal((await a.make().status()).active, true);
  assert.equal(parseEnv(await readFile(join(a.root, '.env'), 'utf8')).MAX_TERMINALS, '8');
});

test('an owner can enable sharing when Cloudflare returns a null comment for an unannotated DNS record', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); h.dns.comment = null;
  await a.make().activate(a.values); assert.equal((await a.make().status()).active, true);
  const first = activationMarker(h.dns.comment); assert.equal(first.prefix, '');
  await a.make().activate({}); assert.equal(activationMarker(h.dns.comment).group, first.group); assert.equal(h.tunnels.size, 1);
});

test('a new host cannot silently adopt an unmarked domain, and ordinary publication cannot steal a shared domain from another active node', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }), b = await h.host(2);
  await assert.rejects(b.make().activate(b.values), /原节点/); assert.equal(h.tunnels.size, 1); assert.equal(dnsWrites(h).length, 0);
  await a.make().activate(a.values); await b.make().activate(b.values); const before = structuredClone(h.dns), count = dnsWrites(h).length;
  const publication = createCloudflarePublication({ root: a.root, socketPath: '/tmp/mock-node-1.sock', api: h.api, ready: async () => {} });
  await assert.rejects(publication.prepare({ domain, zone: 'example.test' }), /其他DNS记录/);
  assert.deepEqual(h.dns, before); assert.equal(dnsWrites(h).length, count);
});

test('readiness, connection failures and operator edits preserve the existing public entry and never restart other nodes', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values);
  let fail = true;
  const b = await h.host(2, { hooks: { ready: async () => { if (fail) throw Error('not ready'); } } }), before = structuredClone(h.dns), count = dnsWrites(h).length;
  await assert.rejects(b.make().activate(b.values), /not ready/); assert.deepEqual(h.dns, before); assert.equal(dnsWrites(h).length, count);
  await writeFile(join(b.root, '.env'), 'PUBLIC_ORIGIN=https://operator.example.test\n', { mode: 0o600 }); fail = false;
  await assert.rejects(b.make().activate({}), /配置已被修改/); assert.equal(await readFile(join(b.root, '.env'), 'utf8'), 'PUBLIC_ORIGIN=https://operator.example.test\n'); assert.deepEqual(h.dns, before);
});

test('lost accepted DNS acknowledgements are reconciled with one read and never rolled back or retried', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values); const b = await h.host(2), count = dnsWrites(h).length;
  h.failure = ({ path, method }) => path.includes('/dns_records') && method === 'PUT' ? { after: true } : null;
  const result = await b.make().activate(b.values); assert.equal(result.active, true); assert.equal(dnsWrites(h).length, count + 1);
  assert.equal((await b.make().status()).pending, null); assert.equal((await a.make().status()).active, false);
});

test('an unknown unaccepted write blocks automatic replay; explicit resolution only reads and clears local recovery state', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values); const b = await h.host(2), before = structuredClone(h.dns);
  h.failure = ({ path, method }) => path.includes('/dns_records') && method === 'PUT' ? { before: true } : null;
  await assert.rejects(b.make().activate(b.values), /未重试或回退/); const count = dnsWrites(h).length;
  h.failure = null; await assert.rejects(b.make().activate({}), /上次切换结果未知/); assert.equal(dnsWrites(h).length, count); assert.deepEqual(h.dns, before);
  const status = await b.make().status(); assert.equal(status.active, false); assert.equal(status.pending, 'committing');
  await b.make().resolveUnknown(); assert.equal(dnsWrites(h).length, count); assert.deepEqual(h.dns, before);
  await b.make().activate({}); assert.equal(dnsWrites(h).length, count + 1);
});

test('a lost tunnel creation acknowledgement is recovered by its persisted unique name without another tunnel', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values); const b = await h.host(2);
  h.failure = ({ path, method }) => path.endsWith('/cfd_tunnel') && method === 'POST' ? { after: true } : null;
  await assert.rejects(b.make().activate(b.values), /synthetic/); assert.equal(h.tunnels.size, 2);
  h.failure = null; await b.make().activate({}); assert.equal(h.tunnels.size, 2); assert.equal((await b.make().status()).active, true);
});

test('an intervening explicit node activation is not overwritten by an older prepared operation', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values);
  const c = await h.host(3), b = await h.host(2, { hooks: { connected: () => c.make().activate(c.values) } });
  await assert.rejects(b.make().activate(b.values), /其他操作变更/); assert.equal((await c.make().status()).active, true); assert.equal((await b.make().status()).active, false);
});

test('public propagation failures report committed DNS without reissuing or rolling back the switch', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values);
  const b = await h.host(2, { hooks: { publicReady: async () => { throw Error('edge still propagating'); } } }), count = dnsWrites(h).length;
  const result = await b.make().activate(b.values); assert.equal(result.published, true); assert.equal(result.reachable, false); assert.equal(dnsWrites(h).length, count + 1); assert.equal((await b.make().status()).active, true);
});

test('unrelated records, malformed markers and full comments are refused before node or tunnel creation', async t => {
  for (const change of [{ type: 'A', content: '192.0.2.1' }, { comment: '[codex-cloud:corrupt]' }, { comment: 'x'.repeat(100) }]) {
    const h = await fixture(t), a = await h.host(1, { legacy: true }); h.dns = { ...h.dns, ...change };
    await assert.rejects(a.make().activate(a.values)); assert.equal(dnsWrites(h).length, 0); assert.equal(h.tunnels.size, 1);
  }
});

test('a prepared initial owner may explicitly accept the unchanged old entry without a DNS write', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true, hooks: { ready: async () => { throw Error('initial readiness failed'); } } });
  await assert.rejects(a.make().activate(a.values), /readiness/); assert.equal(dnsWrites(h).length, 0);
  const result = await a.make().resolveUnknown(); assert.equal(result.active, false); assert.equal(result.pending, null); assert.equal(dnsWrites(h).length, 0);
});

test('profile or tunnel changes during readiness are preserved and prevent public cutover', async t => {
  for (const change of ['profile', 'tunnel']) {
    const h = await fixture(t), a = await h.host(1, { legacy: true }); await a.make().activate(a.values);
    let b;
    b = await h.host(2, { hooks: { connected: async profile => {
      if (change === 'tunnel') h.tunnels.get(profile.tunnelId).config.ingress[0].service = 'http://operator.invalid';
      else { const file = join(b.root, 'data/cloudflare-node.json'), value = JSON.parse(await readFile(file)); value.nodeId = 'f'.repeat(32); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }
    } } });
    const before = structuredClone(h.dns); await assert.rejects(b.make().activate(b.values), /修改/); assert.deepEqual(h.dns, before);
  }
});

test('corrupted recovery JSON is reported without printing its private contents', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true });
  await writeFile(join(a.root, 'data/cloudflare-activation.json'), '{"private":"synthetic-private-value",oops', { mode: 0o600 });
  await assert.rejects(a.make().activate(a.values), error => error.message === '节点切换恢复记录格式无效'); assert.equal(h.calls.length, 0);
});

test('unfinished ordinary publication and node activation cannot overwrite each other across separate invocations', async t => {
  const h = await fixture(t), a = await h.host(1, { legacy: true });
  const ordinary = join(a.root, 'data/cloudflare-publication.json'), activation = join(a.root, 'data/cloudflare-activation.json');
  await writeFile(ordinary, '{}', { mode: 0o600 });
  await assert.rejects(a.make().activate(a.values), /普通公网发布待完成/); assert.equal(h.calls.length, 0);
  await rm(ordinary); await writeFile(activation, '{}', { mode: 0o600 });
  const publication = createCloudflarePublication({ root: a.root, socketPath: '/tmp/mock.sock', api: h.api, ready: async () => {} });
  for (const method of ['prepare', 'commit', 'rollback']) await assert.rejects(publication[method]({ domain, zone: 'example.test' }), /共享入口切换待核对/);
  assert.equal(h.calls.length, 0); assert.equal(await readFile(activation, 'utf8'), '{}');
});
