import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyOptions, loadVerificationConfig, verifyDeployment, verificationRequest, formatVerification, VERIFY_LIMITS } from '../scripts/verify-deployment.mjs';
import { fixture } from './fixture.mjs';
import { FORWARD_FILES } from '../native/forward-artifacts.mjs';
import { createSelfhostCenter } from '../selfhost/center.mjs';

const backendRevision = 'd'.repeat(64);
const runtimeVersions = names => ({ protocol: 1, components: Object.fromEntries(names.map(component => [component, { protocol: 1, component, revision: backendRevision, startedAt: 1, pid: 1 }])) });
const id = 'abcdef0123456789abcdef0123456789', revision = 'a'.repeat(24), csrf = 'b'.repeat(48), secret = 'DO_NOT_PRINT_password_or_cookie_123';
const goodRun = async (file, args) => ({ ok: true, stdout: args.includes('rev-parse') ? 'c'.repeat(40) : file === 'systemctl' ? 'active' : '' });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-verify-')); t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function config(root, changes = {}) {
  return { role: 'node', root, env: {}, entry: 'https://desk.example.test/', mode: 'terminal', kind: 'https', nodeId: id, username: 'admin',
    services: ['codex-cloud-terminal.service', 'codex-cloud-files.service', 'codex-cloud-manager.service', 'codex-cloud-panel.service'],
    passwordFile: join(root, 'secrets/panel_password'), forwardDirectory: join(root, 'data/forward-client'), webrtc: true, ...changes };
}
function requestFor(c, calls, overrides = {}) {
  return async (target, options) => {
    const url = new URL(target), path = url.pathname; calls.push({ url: url.href, ...options });
    const result = overrides[path]; if (result) return typeof result === 'function' ? result(options) : result.clone();
    if (path.endsWith('/readyz')) return json({ ok: true, host: true, files: true, nodeId: c.nodeId });
    if (path.endsWith('/ui-version')) return json({ revision });
    if (path.endsWith('/api/login')) return json({ mode: c.mode, csrf }, 200, { 'set-cookie': 'coc_session_' + id + '=' + secret + '; Path=/' });
    if (path.endsWith('/api/backend-version')) return json(runtimeVersions(c.role === 'center' ? ['center'] : ['panel', 'manager', 'files', 'actions']));
    if (path.endsWith('/api/logout')) return json({ ok: true });
    throw Error('unexpected request');
  };
}
function dependencies(c, calls = [], overrides) { return { loadConfig: async () => c, run: goodRun, expectedUI: async () => revision, expectedBackend: async () => Object.fromEntries(['panel', 'manager', 'files', 'actions', 'center'].map(name => [name, backendRevision])), request: requestFor(c, calls, overrides), readPassword: async () => secret }; }
const status = (report, key) => report.checks.find(check => check.id === key)?.status;

test('verification options are explicit and reject credentials, invalid roles and incompatible feature selections', () => {
  assert.equal(verifyOptions(['--json', '--login']).json, true);
  assert.equal(verifyOptions(['--helper-build', '0.9.0+abcdef0']).forward, true);
  for (const args of [['--password', secret], ['--role', secret], ['--role', 'center', '--forward'], ['--role', 'node', '--config-dir', '/tmp'], ['--helper-build', '../secret']]) assert.throws(() => verifyOptions(args));
});

test('configuration uses the persisted mode, identity and full entry instead of an inherited task environment', async t => {
  const root = await temporary(t); await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, '.env'), `DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=https://desk.example.test\nNODE_ID=${id}\n`, { mode: 0o600 });
  const previous = process.env.PUBLIC_ORIGIN; process.env.PUBLIC_ORIGIN = 'https://stale.example.test';
  try {
    const c = await loadVerificationConfig({}, { root }); assert.equal(c.entry, 'https://desk.example.test/'); assert.equal(c.mode, 'terminal');
    assert(!c.services.includes('codex-cloud-desktop.service'));
  } finally { if (previous === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = previous; }
  await writeFile(join(root, '.env'), `DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=https://desk.example.test\nNODE_ID=${id}\nENTRY_BASE_PATH=/node/work/\nSELFHOST_NODE_CONFIG_FILE=data/connection.json\n`);
  await writeFile(join(root, 'data/connection.json'), JSON.stringify({ version: 1, nodeId: id, credential: 'cocn_' + 'a'.repeat(43), slug: 'work', origin: 'https://desk.example.test', path: '/node/work/', turnEndpoint: null }), { mode: 0o600 });
  const c = await loadVerificationConfig({}, { root }); assert.equal(c.entry, 'https://desk.example.test/node/work/'); assert.equal(c.kind, 'selfhost-node');
  assert(c.services.includes('codex-cloud-selfhost-node.service')); assert(!c.services.includes('codex-cloud-tunnel.service'));
  await writeFile(join(root, '.env'), `PUBLIC_ORIGIN=https://user:${secret}@desk.example.test\n`);
  await assert.rejects(loadVerificationConfig({}, { root }));
  await writeFile(join(root, '.env'), 'x'.repeat(VERIFY_LIMITS.config + 1)); await assert.rejects(loadVerificationConfig({}, { root }));
  await rm(join(root, '.env')); await symlink('data/connection.json', join(root, '.env')); await assert.rejects(loadVerificationConfig({}, { root }));
});

test('verification recognizes a standalone Tunnel only with HTTPS and a populated token', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'secrets'));
  const tokenFile = join(root, 'secrets/tunnel_token');
  for (const [origin, token, kind] of [
    ['http://127.0.0.1:36080', '', 'local'],
    ['http://127.0.0.1:36080', 'old_token', 'local'],
    ['https://desk.example.test', ' \n', 'https'],
    ['https://desk.example.test', 'configured_token\n', 'cloudflare'],
  ]) {
    await writeFile(join(root, '.env'), `PUBLIC_ORIGIN=${origin}\n`, { mode: 0o600 });
    await writeFile(tokenFile, token, { mode: 0o600 });
    const config = await loadVerificationConfig({}, { root });
    assert.equal(config.kind, kind);
    assert.equal(config.services.includes('codex-cloud-tunnel.service'), kind === 'cloudflare');
  }
});

test('default verification issues only reads, reports manual work and never equates automated health with full acceptance', async t => {
  const c = config(await temporary(t)), calls = [], commands = [];
  const report = await verifyDeployment({}, { ...dependencies(c, calls), run: async (file, args) => { commands.push({ file, args }); return goodRun(file, args); } });
  assert(report.summary.automatedOk); assert.equal(report.summary.acceptanceComplete, false);
  assert.equal(status(report, 'login'), 'manual'); assert.equal(status(report, 'forward-artifacts'), 'skip');
  assert(calls.every(call => !call.method || call.method === 'GET'));
  assert(commands.every(({ args }) => !args.some(arg => ['start', 'restart', 'install', 'setup', 'stop', 'claim'].includes(arg))));
  assert.match(formatVerification(report), /待人工验证/); assert(!JSON.stringify(report).includes(secret));
});

test('configuration distinguishes gateway nodes from centers and refuses inconsistent gateway identities', async t => {
  const root = await temporary(t); await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, '.env'), `DEPLOY_MODE=desktop\nPUBLIC_ORIGIN=https://desk.example.test\nNODE_ID=${id}\nSHARED_ENTRY=1\n`, { mode: 0o600 });
  const gateway = { version: 1, origin: 'https://desk.example.test', backendOrigin: 'https://backend.example.test', nodeId: id, name: 'Work', secret: 'a'.repeat(64), registeredAt: 1 };
  await writeFile(join(root, 'data/gateway-node.json'), JSON.stringify(gateway), { mode: 0o600 });
  const c = await loadVerificationConfig({}, { root }); assert.equal(c.kind, 'cloudflare-gateway'); assert(c.services.includes('codex-cloud-tunnel.service'));
  await writeFile(join(root, 'data/gateway-node.json'), JSON.stringify({ ...gateway, nodeId: '0'.repeat(32) }));
  await assert.rejects(loadVerificationConfig({}, { root }));
  const centerDirectory = await temporary(t);
  await writeFile(join(centerDirectory, 'server.env'), 'SELFHOST_ORIGIN=https://center.example.test\nSELFHOST_PUBLIC_HOST=center.example.test\n', { mode: 0o640 });
  const center = await loadVerificationConfig({ role: 'center' }, { root, centerDirectory }); assert.equal(center.role, 'center'); assert.equal(center.entry, 'https://center.example.test/');
  assert(center.services.every(unit => unit.startsWith('codex-selfhost-')));
  await writeFile(join(centerDirectory, 'server.env'), 'SELFHOST_ORIGIN=https://center.example.test\nSELFHOST_PUBLIC_HOST=center.example.test\nSELFHOST_CENTER_PORT=36180\nSELFHOST_INTERNAL_PORT=36181\n', { mode: 0o640 });
  assert.equal((await loadVerificationConfig({ role: 'center' }, { root, centerDirectory })).internalPort, 36181);
});

test('wrong nodes, redirects, unhealthy files and stale UI fail checks; credentials never go to an unverified node', async t => {
  const c = config(await temporary(t));
  for (const response of [json({ ok: true, host: true, files: true, nodeId: '0'.repeat(32) }), json({ ok: true, host: true, files: false, nodeId: id }), new Response('', { status: 302, headers: { location: 'https://other.example.test/' } })]) {
    const calls = [], report = await verifyDeployment({ login: true }, dependencies(c, calls, { '/readyz': response }));
    assert.equal(status(report, 'entry'), 'fail'); assert(calls.every(call => call.method !== 'POST')); assert(!report.summary.automatedOk);
  }
  const report = await verifyDeployment({}, dependencies(c, [], { '/ui-version': json({ revision: '0'.repeat(24) }) }));
  assert.equal(status(report, 'ui'), 'fail');
});

test('explicit login creates one session, preserves target headers, always attempts logout, and redacts errors', async t => {
  const c = config(await temporary(t), { entry: 'https://desk.example.test/node/work/' }), calls = [];
  const report = await verifyDeployment({ login: true }, dependencies(c, calls));
  assert.equal(status(report, 'login'), 'pass'); assert.equal(status(report, 'logout'), 'pass');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname), ['/node/work/api/login', '/node/work/api/logout']);
  assert(calls.every(call => call.headers['x-codex-node'] === id && call.headers.origin === 'https://desk.example.test'));
  assert(!JSON.stringify(report).includes(secret)); assert(!JSON.stringify(report).includes(csrf));
  const failed = await verifyDeployment({ login: true }, { ...dependencies(c), readPassword: async () => { throw Error(secret); } });
  assert.equal(status(failed, 'login'), 'fail'); assert(!formatVerification(failed).includes(secret));
});

test('failure reports distinguish safe HTTP and network causes without copying remote errors or credentials', async t => {
  const c = config(await temporary(t));
  const httpReport = await verifyDeployment({}, dependencies(c, [], { '/readyz': json({ error: secret }, 503) }));
  const entry = httpReport.checks.find(check => check.id === 'entry');
  assert.equal(entry.reason, 'http_status'); assert.equal(entry.httpStatus, 503); assert(!JSON.stringify(httpReport).includes(secret));
  const network = await verifyDeployment({}, { ...dependencies(c), request: async () => { throw Object.assign(Error(secret), { code: 'ETIMEDOUT' }); } });
  assert.equal(network.checks.find(check => check.id === 'entry').reason, 'ETIMEDOUT'); assert(!JSON.stringify(network).includes(secret));
});

async function artifacts(root, entry, { build = '0.9.0+abcdef0', badHash = false, incomplete = false } = {}) {
  const dir = join(root, 'data/forward-client'); await mkdir(dir, { recursive: true });
  const bytes = Buffer.from('isolated mock helper'), files = [];
  for (const [arch, name] of Object.entries(FORWARD_FILES)) {
    await writeFile(join(dir, name), bytes, { mode: 0o600 });
    files.push({ arch, name, size: bytes.length, sha256: badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), build });
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, server: entry.replace(/\/$/, ''), files: incomplete ? files.slice(0, 3) : files }), { mode: 0o600 });
  return files;
}

test('helpers require all four bounded artifacts, the final entry, exact local hashes and an optional expected build', async t => {
  const root = await temporary(t), c = config(root), deps = dependencies(c);
  let report = await verifyDeployment({ forward: true }, deps); assert.equal(status(report, 'forward-artifacts'), 'fail');
  await artifacts(root, c.entry); report = await verifyDeployment({ forward: true }, deps); assert.equal(status(report, 'forward-artifacts'), 'pass');
  report = await verifyDeployment({ forward: true, 'helper-build': '0.9.0+other' }, deps); assert.equal(status(report, 'forward-artifacts'), 'fail');
  await artifacts(root, 'https://old.example.test/'); report = await verifyDeployment({ forward: true }, deps); assert.equal(status(report, 'forward-artifacts'), 'fail');
  await artifacts(root, c.entry, { badHash: true }); report = await verifyDeployment({ forward: true }, deps); assert.equal(status(report, 'forward-artifacts'), 'fail');
  await artifacts(root, c.entry, { incomplete: true }); report = await verifyDeployment({ forward: true }, deps); assert.equal(status(report, 'forward-artifacts'), 'fail');
});

test('authenticated helper publication rejects wrong paths or versions and logs out after a failed check', async t => {
  const root = await temporary(t), c = config(root), files = await artifacts(root, c.entry);
  const downloads = files.map(file => ({ ...file, href: '/api/forward/download/' + file.arch }));
  for (const invalid of [false, true]) {
    const calls = [], items = structuredClone(downloads); if (invalid) items[0].href = 'https://other.example.test/file';
    const report = await verifyDeployment({ forward: true, login: true }, dependencies(c, calls, { '/api/forward': json({ downloads: items }) }));
    assert.equal(status(report, 'forward-publication'), invalid ? 'fail' : 'pass'); assert.equal(status(report, 'logout'), 'pass');
    assert(!calls.some(call => call.url.includes('other.example.test'))); assert(!JSON.stringify(report).includes(secret));
  }
});

for (const mode of ['desktop', 'terminal']) test(`real isolated HTTP validates ${mode} login, UI, identity and logout without creating viewers or sending input`, async t => {
  const app = await fixture({ mode, nodeId: id, ...(mode === 'terminal' ? { password: '中文密码'.repeat(60) } : {}) }); t.after(() => app.close());
  const isolated = await temporary(t);
  const passwordFile = join(isolated, 'panel_password'); await writeFile(passwordFile, app.config.password + '\n', { mode: 0o600 });
  const c = config(resolve('.'), { mode, entry: app.config.origin + '/', passwordFile, username: app.config.username, forwardDirectory: join(isolated, 'helpers') });
  const before = app.managementStats.restarts;
  const report = await verifyDeployment({ login: true }, { loadConfig: async () => c, run: goodRun });
  assert(report.summary.automatedOk, JSON.stringify(report)); assert.equal(status(report, 'ui'), 'pass'); assert.equal(status(report, 'logout'), 'pass');
  assert.equal(app.managementStats.restarts, before); assert.equal(app.terminalConnections, 0); assert.deepEqual(app.inputCalls, []);
});

test('a real isolated node subpath keeps health, UI, login and logout under the same complete entry', async t => {
  const base = '/node/work/', app = await fixture({ mode: 'terminal', nodeId: id, entryBasePath: base }); t.after(() => app.close());
  const isolated = await temporary(t), calls = [];
  const c = config(resolve('.'), { entry: app.config.origin + base, passwordFile: 'fixture-only', username: app.config.username, forwardDirectory: join(isolated, 'helpers') });
  const report = await verifyDeployment({ login: true }, { loadConfig: async () => c, run: goodRun, readPassword: async () => app.config.password,
    request: (url, options) => { calls.push(new URL(url).pathname); return verificationRequest(url, options); } });
  assert(report.summary.automatedOk, JSON.stringify(report)); assert(calls.every(path => path.startsWith(base)));
  assert.equal(status(report, 'ui'), 'pass'); assert.equal(status(report, 'logout'), 'pass'); assert.deepEqual(app.inputCalls, []);
});

test('center role checks homepage, admin subpath and public nodes without requiring node services or helper packages', async t => {
  const directory = await temporary(t);
  const center = await createSelfhostCenter({ origin: 'http://127.0.0.1', dataDir: directory, password: secret, publicHost: 'desk.example.test', frpToken: secret, frpServerPort: 7000, frpTlsServerName: 'desk.example.test' });
  center.server.listen(0, '127.0.0.1'); await once(center.server, 'listening'); t.after(() => center.close());
  const entry = 'http://127.0.0.1:' + center.server.address().port + '/';
  // Host checks expect the configured origin, so route through its declared host.
  const request = (url, options) => verificationRequest(url, { ...options, headers: { ...options.headers, host: '127.0.0.1', origin: 'http://127.0.0.1' } });
  const c = config(resolve('.'), { role: 'center', mode: undefined, nodeId: undefined, kind: 'selfhost-center', entry, services: ['codex-selfhost-center.service'] });
  const report = await verifyDeployment({ login: true }, { loadConfig: async () => c, run: goodRun, request, readPassword: async () => secret });
  assert(report.summary.automatedOk, JSON.stringify(report)); assert.equal(status(report, 'admin-page'), 'pass'); assert.equal(status(report, 'logout'), 'pass');
  assert(!report.checks.some(check => check.id === 'prerequisites' || check.id === 'forward-artifacts'));
});

test('center verification requires a separately configured internal listener to prove isolation', async t => {
  const root = await temporary(t), calls = [];
  const c = config(root, { role: 'center', mode: undefined, nodeId: undefined, kind: 'selfhost-center', entry: 'https://center.example.test/', services: [], internalPort: 36181 });
  const internal = 'http://127.0.0.1:36181/internal/healthz'; let available = false;
  const request = async target => {
    const url = String(target); calls.push(url);
    if (url === internal) return json({ ok: true, isolated: available });
    if (url.endsWith('/healthz')) return json({ ok: true });
    if (url.endsWith('/api/public/nodes')) return json({ nodes: [] });
    return new Response('<a href="/admin/"></a><form id="login-form"></form>', { headers: { 'content-type': 'text/html' } });
  };
  let report = await verifyDeployment({}, { loadConfig: async () => c, run: goodRun, request });
  assert.equal(status(report, 'internal-listener'), 'fail'); assert.equal(report.summary.automatedOk, false);
  available = true; report = await verifyDeployment({}, { loadConfig: async () => c, run: goodRun, request });
  assert.equal(status(report, 'internal-listener'), 'pass'); assert.equal(report.summary.automatedOk, true);
  assert(calls.includes(internal));
});

test('entry verification requires the expected response media type before accepting page or health markers', async t => {
  const c = config(await temporary(t), { role: 'center', nodeId: undefined, services: [] });
  const request = async target => {
    switch (new URL(target).pathname) {
      case '/': return new Response(null);
      case '/admin/': return new Response('login-form', { headers: { 'content-type': 'text/html-backup' } });
      case '/healthz': return new Response('{"ok":true}', { headers: { 'content-type': 'application/jsonp' } });
      default: return new Response('{"nodes":[]}', { headers: { 'content-type': 'Application/JSON; charset=UTF-8' } });
    }
  };
  const report = await verifyDeployment({}, { loadConfig: async () => c, run: goodRun, request });
  for (const id of ['homepage', 'admin-page', 'entry']) assert.equal(status(report, id), 'fail', id);
  assert.equal(status(report, 'public-nodes'), 'pass');
});

test('verification requests never follow redirects, reject non-loopback plaintext and bound actual response bytes', async t => {
  let redirected = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/secret' }); return res.end(); }
    if (req.url === '/secret') redirected++;
    res.writeHead(200); res.end(Buffer.alloc(VERIFY_LIMITS.response + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const entry = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await verificationRequest(entry + '/redirect')).status, 302); assert.equal(redirected, 0);
  await assert.rejects(verificationRequest(entry + '/large')); assert.throws(() => verificationRequest('http://example.test/'));
});

test('private HTTPS requires explicit CA trust even when TLS verification was disabled in the parent environment', async t => {
  const directory = await temporary(t), keyFile = join(directory, 'key.pem'), certFile = join(directory, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=isolated-verification', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 10000, maxBuffer: 16384 });
  const ca = await readFile(certFile), server = https.createServer({ cert: ca, key: await readFile(keyFile) }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const entry = 'https://127.0.0.1:' + server.address().port + '/';
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(verificationRequest(entry));
    assert.equal((await verificationRequest(entry, { ca })).status, 200);
  } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
});

test('JSON CLI errors are structured and do not echo malformed configuration or credentials', async t => {
  const root = await temporary(t); await writeFile(join(root, 'server.env'), 'SELFHOST_ORIGIN=https://user:' + secret + '@example.test\n', { mode: 0o600 });
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/verify-deployment.mjs', '--role', 'center', '--config-dir', root, '--json']), error => {
    assert.equal(error.code, 1); const report = JSON.parse(error.stdout); assert.equal(report.summary.automatedOk, false); assert(!error.stdout.includes(secret)); return true;
  });
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/verify-deployment.mjs', '--password', secret, '--json']), error => {
    assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).checks[0].id, 'arguments'); assert(!error.stdout.includes(secret)); return true;
  });
});

test('authenticated verification reports stale or missing backend components without restarting or leaking responses', async t => {
  const c = config(await temporary(t));
  for (const missing of [false, true]) {
    const versions = runtimeVersions(['panel', 'manager', 'files']);
    if (missing) versions.components.manager = { available: false, error: secret };
    else versions.components.manager.revision = 'f'.repeat(64);
    const calls = [], report = await verifyDeployment({ login: true }, dependencies(c, calls, { '/api/backend-version': json(versions) }));
    assert.equal(status(report, 'backend-code'), 'fail'); assert.equal(status(report, 'logout'), 'pass');
    assert.equal(report.deployment.backend.manager, missing ? 'unavailable' : 'mismatch');
    assert.equal(report.deployment.backend.panel, 'match'); assert(!JSON.stringify(report).includes(secret));
    assert(!calls.some(call => /claim|restart|unlock/.test(call.url)));
  }
});
