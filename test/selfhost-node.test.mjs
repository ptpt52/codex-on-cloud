import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frpcConfig, joinNode, leaveNode, nodeStatus, serviceUnit } from '../selfhost/node.mjs';

const key = 'coc_' + 'a'.repeat(43), credential = 'cocn_' + 'b'.repeat(43);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-selfhost-node-')), configHome = join(root, 'config'), calls = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (file, args) => { calls.push([file, ...args]); return { ok: true, stdout: args.includes('--value') ? 'yes' : '', stderr: '' }; };
  const joined = {
    name: '现场节点 A', entryBasePath: '/node/node-a/', credential, proxyHost: 'desk.example.test',
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
  assert.deepEqual(h.calls.slice(0, 2), [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'codex-cloud-selfhost-node.service']]);

  let secondPrompt = false;
  await joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => { secondPrompt = true; return key; } });
  assert.equal(secondPrompt, false); assert.equal(submitted.body.credential, credential); assert.equal(submitted.body.key, undefined);
  assert.deepEqual(await nodeStatus({ root: h.root, run: async () => ({ ok: true, stdout: 'active', stderr: '' }) }), { joined: true, origin: 'https://desk.example.test', slug: 'node-a', path: '/node/node-a/', mode: 'terminal', service: 'active' });
});

test('joining a different center requires an explicit replacement and imported CA paths are private inputs', async t => {
  const h = await setup(t), request = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...h.joined, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 }); };
  const common = { root: h.root, mode: 'desktop', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  await assert.rejects(joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b' }), /server:leave/);
  await joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b', replace: true });
  assert.match(await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8'), /other\.example\.test/);
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
