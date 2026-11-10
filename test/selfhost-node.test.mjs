import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frpcConfig, joinNode, leaveNode, nodeStatus, serviceUnit } from '../selfhost/node.mjs';

const key = 'coc_' + 'a'.repeat(43), credential = 'cocn_' + 'b'.repeat(43);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-selfhost-node-')), configHome = join(root, 'config'), calls = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'secrets'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.env'), 'DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=https://old.example.test\nSHARED_ENTRY=1\nNODE_ID=' + 'c'.repeat(32) + '\n', { mode: 0o600 });
  await writeFile(join(root, 'secrets', 'credentials.txt'), '工作台：https://old.example.test\n用户名：admin\n', { mode: 0o600 });
  const run = async (file, args) => { calls.push([file, ...args]); return { ok: true, stdout: args.includes('--value') ? 'yes' : '', stderr: '' }; };
  const joined = {
    name: '现场节点 A', entryBasePath: '/node/node-a/', credential, proxyHost: 'desk.example.test', turnEndpoint: 'https://desk.example.test/api/turn-credentials',
    frp: { serverAddr: 'desk.example.test', serverPort: 7000, tlsServerName: 'desk.example.test', token: 'frp_secret_token_1234' },
  };
  return { root, configHome, calls, run, joined };
}

test('join stores only the node credential, generates bounded frpc and systemd files, and resumes without another key', async t => {
  const h = await setup(t); let prompts = 0, submitted;
  const request = async (url, options) => { submitted = { url, body: JSON.parse(options.body) }; return new Response(JSON.stringify(h.joined), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const result = await joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => { prompts++; return key; } });
  assert.equal(submitted.url, 'https://desk.example.test/api/join');
  assert.equal(submitted.body.key, key); assert.equal(submitted.body.node.mode, 'terminal');
  assert.equal(result.connection.credential, credential); assert.equal(prompts, 1);

  const connectionText = await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8');
  const config = await readFile(join(h.root, 'data', 'selfhost-node', 'frpc.toml'), 'utf8');
  const unit = await readFile(join(h.configHome, 'systemd', 'user', 'codex-cloud-selfhost-node.service'), 'utf8');
  assert(!connectionText.includes(key)); assert(!config.includes(key)); assert.match(config, /useSystemCa = true/);
  assert.match(config, /locations = \["\/node\/node-a\/"\]/); assert.match(config, /metadatas\.credential/); assert.match(unit, /Restart=on-failure/);
  assert.deepEqual(h.calls.slice(0, 3), [['systemctl', '--user', 'restart', 'codex-cloud-panel.service'], ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'codex-cloud-selfhost-node.service']]);
  const env = await readFile(join(h.root, '.env'), 'utf8');
  assert.match(env, /PUBLIC_ORIGIN=https:\/\/desk\.example\.test/); assert.match(env, /ENTRY_BASE_PATH=\/node\/node-a\//); assert.match(env, /SHARED_ENTRY=0/);
  assert.match(env, new RegExp('^NODE_ID=' + result.connection.nodeId + '$', 'm'));
  assert.match(env, /SELFHOST_CA_FILE=\n/);
  assert.match(await readFile(join(h.root, 'secrets', 'credentials.txt'), 'utf8'), /工作台：https:\/\/desk\.example\.test/);
  const backup = JSON.parse(await readFile(join(h.root, 'data', 'selfhost-node', 'panel-backup.json'), 'utf8'));
  assert.deepEqual(backup.target, { origin: 'https://desk.example.test', slug: 'node-a', nodeId: result.connection.nodeId, path: '/node/node-a/' });

  let secondPrompt = false;
  await joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => { secondPrompt = true; return key; } });
  assert.equal(secondPrompt, false); assert.equal(submitted.body.credential, credential); assert.equal(submitted.body.key, undefined);
  assert.deepEqual(await nodeStatus({ root: h.root, run: async () => ({ ok: true, stdout: 'active', stderr: '' }) }), { joined: true, origin: 'https://desk.example.test', slug: 'node-a', path: '/node/node-a/', mode: 'terminal', service: 'active', panel: 'active' });
});

test('joining a different center requires an explicit replacement and imported CA paths are private inputs', async t => {
  const h = await setup(t), request = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...h.joined, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 }); };
  const common = { root: h.root, mode: 'desktop', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  await assert.rejects(joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b' }), /server:leave/);
  await joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b', replace: true });
  assert.match(await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8'), /other\.example\.test/);
  const env = await readFile(join(h.root, '.env'), 'utf8');
  assert.match(env, /PUBLIC_ORIGIN=https:\/\/other\.example\.test/);
  assert.match(env, /ENTRY_BASE_PATH=\/node\/node-b\//);
  const backup = JSON.parse(await readFile(join(h.root, 'data', 'selfhost-node', 'panel-backup.json'), 'utf8'));
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.target, { origin: 'https://other.example.test', slug: 'node-b', nodeId: backup.target.nodeId, path: '/node/node-b/' });
  assert.equal(backup.envBefore.includes('PUBLIC_ORIGIN=https://old.example.test'), true);
  await leaveNode({ root: h.root, configHome: h.configHome, run: h.run, request: async () => new Response('{"ok":true}', { status: 200 }) });
  assert.match(await readFile(join(h.root, '.env'), 'utf8'), /PUBLIC_ORIGIN=https:\/\/old\.example\.test/);
  assert.match(await readFile(join(h.root, '.env'), 'utf8'), /^NODE_ID=c{32}$/m);
});

test('a version 1 Panel backup is migrated using the prior node identity', async t => {
  const h = await setup(t), request = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  const result = await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const path = join(h.root, 'data', 'selfhost-node', 'panel-backup.json'), backup = JSON.parse(await readFile(path, 'utf8'));
  delete backup.target; backup.version = 1;
  await writeFile(path, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.target, { origin: 'https://desk.example.test', slug: 'node-a', nodeId: result.connection.nodeId, path: '/node/node-a/' });
});

test('existing Cloudflare or Gateway state requires explicit takeover and leave restores every prior file', async t => {
  const h = await setup(t), gatewayPath = join(h.root, 'data', 'gateway-node.json'), gateway = JSON.stringify({ version: 1, origin: 'https://old.example.test' }, null, 2) + '\n';
  await mkdir(join(h.root, 'data'), { recursive: true, mode: 0o700 });
  await writeFile(gatewayPath, gateway, { mode: 0o600 });
  const request = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...h.joined, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 }); };
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  const beforeEnv = await readFile(join(h.root, '.env'), 'utf8'), beforeCredentials = await readFile(join(h.root, 'secrets', 'credentials.txt'), 'utf8');
  await assert.rejects(joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' }), /switch-existing/);
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a', switchExisting: true });
  await assert.rejects(access(gatewayPath));
  await leaveNode({ root: h.root, configHome: h.configHome, run: h.run, request: async () => new Response('{"ok":true}', { status: 200 }) });
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), beforeEnv);
  assert.equal(await readFile(join(h.root, 'secrets', 'credentials.txt'), 'utf8'), beforeCredentials);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), beforeEnv);
  assert.equal(await readFile(gatewayPath, 'utf8'), gateway);
});

test('frpc output keeps the public Host, exact slash-boundary, node mode and verified TLS identity', () => {
  const connection = { version: 1, origin: 'https://desk.example.test', slug: 'node-a', name: 'A', path: '/node/node-a/', nodeId: 'a'.repeat(32), mode: 'desktop', credential,
    proxyHost: 'desk.example.test', frp: { serverAddr: 'desk.example.test', serverPort: 7000, tlsServerName: 'desk.example.test', token: 'frp_secret_token_1234' } };
  const config = frpcConfig(connection, { panelPort: 36080, caFile: '/private/ca.pem' });
  assert.match(config, /trustedCaFile = "\/private\/ca\.pem"/); assert.match(config, /serverName = "desk\.example\.test"/);
  assert.match(config, /locations = \["\/node\/node-a\/"\]/); assert.match(config, /type = "http"/); assert.match(config, /localPort = 36080/);
  assert.match(serviceUnit({ frpc: '/bin/frpc', config: '/data/frpc.toml' }), /ExecStart="\/bin\/frpc" -c "\/data\/frpc\.toml"/);
});

test('leave releases the center grant and removes only generated node files', async t => {
  const h = await setup(t), request = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const left = await leaveNode({ root: h.root, configHome: h.configHome, run: h.run, request: async () => new Response('{"ok":true}', { status: 200 }) });
  assert.equal(left.left, true);
  await assert.rejects(access(join(h.root, 'data', 'selfhost-node', 'connection.json')));
  await assert.rejects(access(join(h.configHome, 'systemd', 'user', 'codex-cloud-selfhost-node.service')));
  assert.equal((await nodeStatus({ root: h.root, run: h.run })).joined, false);
});
