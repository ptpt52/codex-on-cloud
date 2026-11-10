import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setupGateway } from '../scripts/setup-gateway.mjs';
import { buildGateway } from '../scripts/build-gateway.mjs';
import { createGatewayJoin } from '../scripts/gateway-node.mjs';
import { readGatewayConnection } from '../native/gateway-config.mjs';
import { createNodeActivation } from '../scripts/node-activation.mjs';
import { createCloudflarePublication } from '../scripts/cloudflare-publication.mjs';
import { gatewayFixture } from './gateway-fixture.mjs';

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-node-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'secrets'), { mode: 0o700 }); await mkdir(join(root, 'data'), { mode: 0o700 });
  await writeFile(join(root, '.env'), 'DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=https://node-1.example.test\n', { mode: 0o600 });
  await writeFile(join(root, 'secrets/credentials.txt'), '工作台：https://node-1.example.test\n密码：synthetic-not-real\n', { mode: 0o600 }); return root;
}
test('gateway setup and build preserve passwords and emit a bounded standalone Worker without CF credentials', async t => {
  const root = await rootFixture(t), options = { root, origin: 'https://desk.example.test', backendZone: 'example.test' };
  const configured = await setupGateway(options), password = await readFile(configured.passwordFile, 'utf8'); await setupGateway(options); assert.equal(await readFile(configured.passwordFile, 'utf8'), password);
  await assert.rejects(setupGateway({ ...options, origin: 'https://other.example.test' }), /改绑/);
  const built = await buildGateway({ config: configured.config, passwordFile: configured.passwordFile, output: join(root, 'build') }), source = await readFile(join(built.output, 'worker.mjs'), 'utf8');
  assert(source.includes('class GatewayState')); assert(!source.includes(password.trim())); assert(!source.includes('api.cloudflare.com')); assert(Buffer.byteLength(source) < 262144);
  const config = JSON.parse(await readFile(join(built.output, 'wrangler.json'))); assert.equal(config.routes[0].pattern, 'desk.example.test'); assert.equal(config.workers_dev, false);
  for (const name of ['worker.mjs', 'wrangler.json', 'worker-secrets.json']) assert.equal((await stat(join(built.output, name))).mode & 0o777, 0o600);
});

test('an independently configured Tunnel node joins and reuses its identity with no CF token and no default-route mutation', async t => {
  const root = await rootFixture(t), gateway = await gatewayFixture({ probe: async () => true }); await gateway.login(); const code = await gateway.code();
  await writeFile(join(root, 'secrets/gateway_code'), code.code, { mode: 0o600 }); let loaded = false, reloads = 0; const calls = [];
  const engine = createGatewayJoin({ root, socketPath: '/tmp/fixture.sock', ready: async (_socket, connection) => { const env = parseEnv(await readFile(join(root, '.env'), 'utf8')); assert.equal(env.PUBLIC_ORIGIN, gateway.origin); assert.equal(env.NODE_ID, connection.nodeId); return loaded; }, reload: async () => { loaded = true; reloads++; }, request: async (url, options) => { calls.push(url); return gateway.fetch(url, options); } });
  const result = await engine.join({ gateway: gateway.origin, backend: 'https://node-1.example.test', name: '节点 $(literal)' }); assert.equal(result.registered, true); assert.equal(reloads, 1);
  const connection = readGatewayConnection(root); assert.equal(connection.nodeId, result.nodeId); assert.equal(connection.name, '节点 $(literal)'); assert.equal(gateway.storage.value.activeId, null);
  await engine.join({}); assert.equal(readGatewayConnection(root).secret, connection.secret); assert.equal(reloads, 1); assert.equal(gateway.storage.value.nodes.length, 1);
  assert(calls.every(url => url === gateway.origin + '/__nodes/api/register')); await assert.rejects(readFile(join(root, 'secrets/cf_token')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'data/gateway-join.json')), { code: 'ENOENT' });
});

test('join preparation is resumable and preserves operator edits instead of overwriting them', async t => {
  const root = await rootFixture(t); const engine = createGatewayJoin({ root, socketPath: '/tmp/fixture.sock', ready: async () => true, reload: async () => { throw Error('must not reload'); } });
  const values = { gateway: 'https://desk.example.test', backend: 'https://node-1.example.test', name: '待登记节点', prepareOnly: true };
  assert.equal((await engine.join(values)).prepared, true); const connection = readGatewayConnection(root); assert.equal(connection.registeredAt, 0);
  await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://operator.example.test\n', { mode: 0o600 });
  await assert.rejects(engine.join(values), /已被修改/); assert.equal(await readFile(join(root, '.env'), 'utf8'), 'PUBLIC_ORIGIN=https://operator.example.test\n');
});

test('a malformed confirmed recovery is rejected before applying any prepared local file', async t => {
  const root = await rootFixture(t), engine = createGatewayJoin({ root, socketPath: '/tmp/mock.sock', reload: async () => {} });
  const original = await readFile(join(root, '.env'), 'utf8');
  await engine.join({ gateway: 'https://desk.example.test', backend: 'https://node-1.example.test', prepareOnly: true });
  const path = join(root, 'data/gateway-join.json'), stage = JSON.parse(await readFile(path));
  stage.phase = 'registered'; stage.completed = { ...stage.connection, registeredAt: 'invalid' };
  await writeFile(path, JSON.stringify(stage), { mode: 0o600 }); await writeFile(join(root, '.env'), original, { mode: 0o600 });
  await assert.rejects(engine.join({}), /网关配置无效/); assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
});

test('a lost registration reply requires an explicit retry and reuses the original durable identity', async t => {
  const root = await rootFixture(t), gateway = await gatewayFixture({ probe: async () => true }); await gateway.login(); const code = await gateway.code(); await writeFile(join(root, 'secrets/gateway_code'), code.code, { mode: 0o600 });
  let lost = true, count = 0;
  const engine = createGatewayJoin({ root, socketPath: '/tmp/fixture.sock', ready: async () => true, reload: async () => {}, request: async (url, options) => { count++; const response = await gateway.fetch(url, options); if (lost) throw Error('synthetic reply loss'); return response; } });
  await assert.rejects(engine.join({ gateway: gateway.origin, backend: 'https://node-1.example.test', name: '断线接入' }), /reply loss/); assert.equal(count, 1); const original = readGatewayConnection(root); assert.equal(gateway.storage.value.nodes.length, 1);
  lost = false; await engine.join({}); assert.equal(count, 2); assert.equal(readGatewayConnection(root).nodeId, original.nodeId); assert.equal(gateway.storage.value.nodes.length, 1);
});

test('legacy DNS activation and publication are blocked for a gateway node before any Cloudflare request', async t => {
  const root = await rootFixture(t); await writeFile(join(root, 'data/gateway-node.json'), '{}', { mode: 0o600 }); let calls = 0; const api = async () => { calls++; throw Error('CF must not be used'); };
  const activation = createNodeActivation({ root, socketPath: '/tmp/private.sock', api, services: async () => {} });
  await assert.rejects(activation.activate({}), /固定网关/);
  const publication = createCloudflarePublication({ root, socketPath: '/tmp/private.sock', api }); await assert.rejects(publication.prepare({ domain: 'desk.example.test', zone: 'example.test' }), /固定网关/); assert.equal(calls, 0);
});

test('confirmed enrollment preserves operator changes, retains recovery, and resumes without another registration request', async t => {
  const root = await rootFixture(t), gateway = await gatewayFixture({ probe: async () => true }); await gateway.login(); const code = await gateway.code(); await writeFile(join(root, 'secrets/gateway_code'), code.code, { mode: 0o600 }); let calls = 0;
  const engine = createGatewayJoin({ root, socketPath: '/tmp/mock.sock', ready: async () => true, reload: async () => {}, request: async (url, options) => { calls++; const result = await gateway.fetch(url, options); await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://operator.example.test\n', { mode: 0o600 }); return result; } });
  await assert.rejects(engine.join({ gateway: gateway.origin, backend: 'https://node-1.example.test', name: '人工修改' }), /人工修改/); assert.equal(calls, 1);
  const stage = JSON.parse(await readFile(join(root, 'data/gateway-join.json'))); assert.equal(stage.phase, 'registered');
  await writeFile(join(root, '.env'), stage.files.env.after, { mode: 0o600 }); assert.equal((await engine.join({})).registered, true); assert.equal(calls, 1);
});

test('an unsent preparation can be explicitly restored without contacting CF or erasing edited files', async t => {
  const root = await rootFixture(t), original = await readFile(join(root, '.env'), 'utf8'); let reloads = 0;
  const engine = createGatewayJoin({ root, socketPath: '/tmp/mock.sock', ready: async () => true, reload: async () => { reloads++; }, request: async () => { throw Error('must not network'); } });
  await engine.join({ gateway: 'https://desk.example.test', backend: 'https://node-1.example.test', name: '可撤销', prepareOnly: true });
  assert.equal((await engine.join({ abort: true })).aborted, true); assert.equal(await readFile(join(root, '.env'), 'utf8'), original); assert.equal(reloads, 1); assert.equal(readGatewayConnection(root), null);
  await assert.rejects(readFile(join(root, 'data/gateway-join.json')), { code: 'ENOENT' });
});

test('an unknown registration cannot be locally restored while the node is registered or active', async t => {
  const root = await rootFixture(t), gateway = await gatewayFixture({ probe: async () => true }); await gateway.login(); const code = await gateway.code(); await writeFile(join(root, 'secrets/gateway_code'), code.code, { mode: 0o600 });
  let lost = true;
  const engine = createGatewayJoin({ root, socketPath: '/tmp/mock.sock', ready: async () => true, reload: async () => {}, request: async (url, options) => { const result = await gateway.fetch(url, options); if (lost && url.endsWith('/register')) throw Error('lost'); return result; } });
  await assert.rejects(engine.join({ gateway: gateway.origin, backend: 'https://node-1.example.test', name: '已登记' }), /lost/);
  await assert.rejects(engine.join({ abort: true }), /网页切换到其他节点并移除/);
  const current = await (await gateway.api('nodes')).json(); await gateway.api('nodes/' + readGatewayConnection(root).nodeId, { method: 'DELETE', body: { revision: current.revision } });
  lost = false; assert.equal((await engine.join({ abort: true })).aborted, true); assert.equal(readGatewayConnection(root), null);
});
