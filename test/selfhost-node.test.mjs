import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frpcConfig, joinNode, leaveNode, nodeDoctor, nodeStatus, serviceUnit } from '../selfhost/node.mjs';

const key = 'coc_' + 'a'.repeat(43), credential = 'cocn_' + 'b'.repeat(43);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-selfhost-node-')), configHome = join(root, 'config'), calls = [];
  t.after(async () => { await chmod(join(root, 'secrets'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'secrets'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.env'), 'DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=https://old.example.test\nSHARED_ENTRY=1\nNODE_ID=' + 'c'.repeat(32) + '\n', { mode: 0o600 });
  await writeFile(join(root, 'secrets', 'credentials.txt'), '工作台：https://old.example.test\n用户名：admin\n', { mode: 0o600 });
  const run = async (file, args) => { calls.push([file, ...args]); return { ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-active') ? 'active' : '', stderr: '' }; };
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
  assert.deepEqual(h.calls.slice(0, 4), [['systemctl', '--user', 'restart', 'codex-cloud-panel.service'], ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', 'codex-cloud-selfhost-node.service'], ['systemctl', '--user', 'restart', 'codex-cloud-selfhost-node.service']]);
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
  const h = await setup(t), request = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...h.joined, turnEndpoint: null, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 }); };
  const common = { root: h.root, mode: 'desktop', panelPort: 36080, configHome: h.configHome, request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  await assert.rejects(joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b' }), /server:leave/);
  await joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b', replace: true });
  assert.equal(h.calls.some(([, ...args]) => args.join(' ') === '--user disable --now codex-cloud-selfhost-node.service'), true);
  assert.equal(h.calls.filter(([, ...args]) => args.join(' ') === '--user restart codex-cloud-selfhost-node.service').length >= 2, true);
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

test('a rejected replacement restores the previous relay service and connection files', async t => {
  const h = await setup(t); let relayActive = false, joins = 0;
  const run = async (_file, args) => {
    h.calls.push([_file, ...args]);
    if (args.includes('disable')) relayActive = false;
    if (args.includes('restart') && args.includes('codex-cloud-selfhost-node.service')) relayActive = true;
    return { ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-enabled') ? 'enabled' : args.includes('is-active') ? relayActive ? 'active' : 'inactive' : '', stderr: '' };
  };
  const request = async (_url, options) => {
    joins++; const body = JSON.parse(options.body);
    if (joins === 2) return new Response('{"error":"center rejected replacement"}', { status: 409 });
    return new Response(JSON.stringify({ ...h.joined, turnEndpoint: null, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 });
  };
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request, run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const connection = await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8');
  await assert.rejects(joinNode({ ...common, server: 'https://other.example.test', slug: 'node-b', replace: true }), /center rejected replacement/);
  assert.equal(relayActive, true);
  assert.equal(await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8'), connection);
  assert.match(await readFile(join(h.root, '.env'), 'utf8'), /ENTRY_BASE_PATH=\/node\/node-a\//);
});

test('a failed same-node refresh restores the active prior relay', async t => {
  const h = await setup(t); let relayActive = false, nodeStarts = 0;
  const run = async (_file, args) => {
    h.calls.push([_file, ...args]);
    if (args.includes('disable')) relayActive = false;
    if (args.includes('restart') && args.includes('codex-cloud-selfhost-node.service')) {
      nodeStarts++;
      if (nodeStarts === 2) return { ok: false, stdout: '', stderr: 'refresh failed' };
      relayActive = true;
    }
    return { ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-enabled') ? 'enabled' : args.includes('is-active') ? relayActive ? 'active' : 'inactive' : '', stderr: '' };
  };
  const request = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome, request, run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode(common);
  const connection = await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8');
  await assert.rejects(joinNode(common), /回滚/);
  assert.equal(relayActive, true);
  assert.equal(await readFile(join(h.root, 'data', 'selfhost-node', 'connection.json'), 'utf8'), connection);
  await assert.rejects(access(join(h.root, 'data', 'selfhost-node', 'join-recovery.json')));
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
  const request = async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify({ ...h.joined, turnEndpoint: null, entryBasePath: '/node/' + body.slug + '/' }), { status: 200 }); };
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

test('leave preserves all enrollment state when frpc cannot be confirmed stopped', async t => {
  const h = await setup(t), joined = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request: joined, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  let released = 0;
  const failed = async (_file, args) => args.includes('disable') ? { ok: false, stderr: 'stop failed' } : { ok: true, stdout: 'active', stderr: '' };
  await assert.rejects(leaveNode({ root: h.root, configHome: h.configHome, run: failed, request: async () => { released++; return new Response('{"ok":true}', { status: 200 }); } }), /无法确认节点中继已停止/);
  assert.equal(released, 0);
  await access(join(h.root, 'data', 'selfhost-node', 'connection.json'));
  await access(join(h.root, 'data', 'selfhost-node', 'panel-backup.json'));
  await access(join(h.configHome, 'systemd', 'user', 'codex-cloud-selfhost-node.service'));
});

test('leave keeps recovery state when the restored Panel fails to restart', async t => {
  const h = await setup(t), joined = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request: joined, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const failedRestart = async (_file, args) => args.includes('restart') ? { ok: false, stderr: 'restart failed' } : { ok: true, stdout: 'active', stderr: '' };
  await assert.rejects(leaveNode({ root: h.root, configHome: h.configHome, run: failedRestart, request: async () => new Response('{"ok":true}', { status: 200 }) }), /Panel 原配置已恢复/);
  await access(join(h.root, 'data', 'selfhost-node', 'connection.json'));
  await access(join(h.root, 'data', 'selfhost-node', 'panel-backup.json'));
});

test('leave allows offline center cleanup only after frpc stops and returns a warning', async t => {
  const h = await setup(t), joined = async () => new Response(JSON.stringify(h.joined), { status: 200 });
  const common = { root: h.root, mode: 'terminal', panelPort: 36080, configHome: h.configHome, request: joined, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key };
  await joinNode({ ...common, server: 'https://desk.example.test', slug: 'node-a' });
  const result = await leaveNode({ root: h.root, configHome: h.configHome, run: h.run, request: async () => { throw Error('offline'); } });
  assert.equal(result.left, true); assert.match(result.warning, /网络不可达/);
  await assert.rejects(access(join(h.root, 'data', 'selfhost-node', 'connection.json')));
  await assert.rejects(access(join(h.root, 'data', 'selfhost-node', 'panel-backup.json')));
});

test('join prepares frpc before requesting central authorization and leaves no half-enrollment when service startup fails', async t => {
  const h = await setup(t), originalEnv = await readFile(join(h.root, '.env'), 'utf8');
  let joins = 0, leaves = 0, installed = 0;
  const request = async url => { if (url.endsWith('/api/join')) { joins++; return new Response(JSON.stringify(h.joined), { status: 200 }); } if (url.endsWith('/api/leave')) { leaves++; return new Response('{"ok":true}', { status: 200 }); } throw Error('unexpected URL'); };
  const run = async (_file, args) => ({ ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-active') ? 'inactive' : '', stderr: '' });
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run, install: async () => { installed++; return '/opt/frpc'; }, promptKey: async () => key }), /未进入 active 状态.*已回滚/);
  assert.equal(installed, 1); assert.equal(joins, 1); assert.equal(leaves, 1);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), originalEnv);
  for (const path of [join(h.root, 'data', 'selfhost-node', 'connection.json'), join(h.root, 'data', 'selfhost-node', 'panel-backup.json'), join(h.configHome, 'systemd', 'user', 'codex-cloud-selfhost-node.service')]) await assert.rejects(access(path));
});

test('join rolls Panel and center state back when Panel restart fails', async t => {
  const h = await setup(t), originalEnv = await readFile(join(h.root, '.env'), 'utf8'); let panelRestarts = 0, leaves = 0;
  const request = async url => { if (url.endsWith('/api/join')) return new Response(JSON.stringify(h.joined), { status: 200 }); if (url.endsWith('/api/leave')) { leaves++; return new Response('{"ok":true}', { status: 200 }); } throw Error('unexpected URL'); };
  const run = async (_file, args) => {
    if (args.includes('restart') && args.includes('codex-cloud-panel.service')) { panelRestarts++; return panelRestarts === 1 ? { ok: false, stderr: 'panel start failed' } : { ok: true, stdout: '', stderr: '' }; }
    return { ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-active') ? 'active' : '', stderr: '' };
  };
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run, install: async () => '/opt/frpc', promptKey: async () => key }), /Panel 重启失败.*已回滚/);
  assert.equal(panelRestarts, 2); assert.equal(leaves, 1);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), originalEnv);
  await assert.rejects(access(join(h.root, 'data', 'selfhost-node', 'connection.json')));
});

test('join never contacts the center when local frpc preparation fails', async t => {
  const h = await setup(t); let requests = 0;
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request: async () => { requests++; throw Error('should not run'); }, run: h.run, install: async () => { throw Error('download failed'); }, promptKey: async () => key }), /download failed/);
  assert.equal(requests, 0);
});

test('failed center release preserves a recovery record that can be retried safely', async t => {
  const h = await setup(t), originalEnv = await readFile(join(h.root, '.env'), 'utf8'); let leaveStatus = 500, leaves = 0;
  const request = async url => {
    if (url.endsWith('/api/join')) return new Response(JSON.stringify(h.joined), { status: 200 });
    if (url.endsWith('/api/leave')) { leaves++; return leaveStatus === 200 ? new Response('{"ok":true}', { status: 200 }) : new Response('{"error":"temporary"}', { status: leaveStatus }); }
    throw Error('unexpected URL');
  };
  const inactive = async (_file, args) => ({ ok: true, stdout: args.includes('--value') ? 'yes' : args.includes('is-active') ? 'inactive' : '', stderr: '' });
  const error = await joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: inactive, install: async () => '/opt/frpc', promptKey: async () => key }).catch(value => value);
  assert.match(error.message, /回滚未完全确认/); assert.equal(error.outcome, 'unknown'); assert.equal(leaves, 1);
  const recoveryPath = join(h.root, 'data', 'selfhost-node', 'join-recovery.json');
  await access(recoveryPath);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), originalEnv);
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key }), /server:leave --recover/);
  assert.equal((await nodeDoctor({ root: h.root, run: h.run, request: async () => { throw Error('offline'); } })).issues.some(issue => issue.includes('server:leave --recover')), true);

  leaveStatus = 200;
  const recovered = await leaveNode({ root: h.root, configHome: h.configHome, recover: true, run: h.run, request });
  assert.equal(recovered.recovered, true);
  await assert.rejects(access(recoveryPath));
  assert.equal((await nodeStatus({ root: h.root, run: h.run })).joined, false);
});

test('doctor verifies self-signed centers with the enrolled CA instead of disabling TLS checks', async t => {
  const h = await setup(t), certDir = join(h.root, 'certs'); await mkdir(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-subj', '/CN=desk.example.test', '-addext', 'subjectAltName=DNS:desk.example.test,IP:127.0.0.1'], { stdio: 'ignore' });
  const server = https.createServer({ key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const nodeDir = join(h.root, 'data', 'selfhost-node'); await mkdir(nodeDir, { recursive: true, mode: 0o700 });
  const connection = { version: 1, origin: `https://127.0.0.1:${server.address().port}`, slug: 'node-a', name: 'A', path: '/node/node-a/', nodeId: 'a'.repeat(32), mode: 'terminal', credential,
    proxyHost: 'desk.example.test', turnEndpoint: null, frp: { serverAddr: 'desk.example.test', serverPort: 7000, tlsServerName: 'desk.example.test', token: 'frp_secret_token_1234' } };
  await writeFile(join(nodeDir, 'connection.json'), JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
  const untrusted = await nodeDoctor({ root: h.root, run: h.run });
  assert.equal(untrusted.ok, false); assert(untrusted.issues.includes('中心健康检查失败'));
  const caPath = join(nodeDir, 'frps-ca.pem'); await writeFile(caPath, await readFile(join(certDir, 'cert.pem')), { mode: 0o600 });
  const trusted = await nodeDoctor({ root: h.root, run: h.run });
  assert.equal(trusted.ok, true);
  await writeFile(caPath, await readFile(join(certDir, 'cert.pem')), { mode: 0o644 });
  await chmod(caPath, 0o644);
  const unsafe = await nodeDoctor({ root: h.root, run: h.run });
  assert.equal(unsafe.ok, false); assert(unsafe.issues.some(issue => issue.includes('节点 CA 文件无效')));
});

test('partial credentials write failure restores the environment and original backup', async t => {
  const h = await setup(t), env = await readFile(join(h.root, '.env'), 'utf8');
  await chmod(join(h.root, 'secrets'), 0o500);
  let released = false;
  const request = async url => { if (url.endsWith('/api/leave')) released = true; return new Response(JSON.stringify(h.joined)); };
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run: h.run, install: async () => '/opt/frpc', promptKey: async () => key }), /已回滚/);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), env);
  assert(released);
  for (const name of ['connection.json', 'panel-backup.json', 'join-recovery.json']) await assert.rejects(access(join(h.root, 'data/selfhost-node', name)));
});

test('rollback preserves operator edits and retains a prewritten recovery journal', async t => {
  const h = await setup(t), envPath = join(h.root, '.env'); let changed, journal;
  const request = async () => new Response(JSON.stringify(h.joined));
  const run = async (tool, args) => {
    if (args.includes('restart') && args.includes('codex-cloud-panel.service') && !changed) {
      journal = JSON.parse(await readFile(join(h.root, 'data/selfhost-node/join-recovery.json'), 'utf8'));
      changed = journal.after.env;
      await writeFile(envPath, changed + '# operator change\n', { mode: 0o600 });
      return { ok: false, stderr: 'injected failure' };
    }
    return h.run(tool, args);
  };
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request, run, install: async () => '/opt/frpc', promptKey: async () => key }), /未完全确认/);
  assert.equal(journal.version, 2); assert.equal(journal.before.connection, null);
  assert.match(await readFile(envPath, 'utf8'), /operator change/);
  await assert.rejects(leaveNode({ root: h.root, recover: true, configHome: h.configHome, request, run: h.run }), /未覆盖/);
  await writeFile(envPath, changed, { mode: 0o600 });
  assert((await leaveNode({ root: h.root, recover: true, configHome: h.configHome, request, run: h.run })).recovered);
  assert.equal(await readFile(envPath, 'utf8'), journal.before.env);
});

test('rollback confirms an absent relay unit after a failure before unit creation', async t => {
  const h = await setup(t), original = await readFile(join(h.root, '.env'), 'utf8');
  await chmod(join(h.root, 'secrets'), 0o500);
  const run = async (file, args) => {
    if (args.includes('disable')) return { ok: false, stderr: 'Unit does not exist' };
    if (args.includes('--property=LoadState')) return { ok: true, stdout: 'not-found' };
    if (args.includes('is-active')) return { ok: false, stdout: 'inactive' };
    return h.run(file, args);
  };
  await assert.rejects(joinNode({ root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome,
    request: async () => new Response(JSON.stringify(h.joined)), run, install: async () => '/opt/frpc', promptKey: async () => key }), /已回滚/);
  assert.equal(await readFile(join(h.root, '.env'), 'utf8'), original);
  await assert.rejects(access(join(h.root, 'data/selfhost-node/join-recovery.json')));
});

test('explicit reauthorization prompts for the new key at the same fixed node without changing identity', async t => {
  const h = await setup(t), submissions = []; let prompts = 0;
  const common = { root: h.root, server: 'https://desk.example.test', slug: 'node-a', mode: 'terminal', panelPort: 36080, configHome: h.configHome, run: h.run, install: async () => '/opt/frpc',
    promptKey: async () => { prompts++; return prompts === 1 ? key : 'coc_' + 'z'.repeat(43); },
    request: async (_url, options) => { submissions.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ...h.joined, credential: prompts > 1 ? 'cocn_' + 'z'.repeat(43) : credential })); } };
  const first = await joinNode(common);
  const next = await joinNode({ ...common, reauthorize: true });
  assert.equal(prompts, 2); assert.equal(submissions[1].key, 'coc_' + 'z'.repeat(43)); assert.equal(submissions[1].credential, undefined);
  assert.equal(next.connection.nodeId, first.connection.nodeId); assert.equal(next.connection.path, first.connection.path); assert.notEqual(next.connection.credential, first.connection.credential);
  assert(h.calls.every(call => !call.includes('codex-cloud-desktop.service')));
});
