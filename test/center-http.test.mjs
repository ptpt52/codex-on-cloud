import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { centerClient, readCenterCA } from '../panel/center-http.mjs';
import { joinNode, leaveNode, nodeDoctor } from '../selfhost/node.mjs';

const openssl = args => execFileSync('openssl', args, { stdio: 'ignore', timeout: 10000 });
test('real HTTPS enrollment, doctor, rollback recovery and leave share scoped CA trust', async t => {
  const root = await mkdtemp(join(tmpdir(), 'center-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, 'key.pem'), caFile = join(root, 'ca.pem'), csr = join(root, 'leaf.csr'), expired = join(root, 'expired.pem');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', caFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  openssl(['req', '-new', '-key', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(join(root, 'index'), ''); await writeFile(join(root, 'serial'), '01\n');
  await writeFile(join(root, 'ca.cnf'), `[ca]\ndefault_ca=local\n[local]\ndatabase=${root}/index\nserial=${root}/serial\nnew_certs_dir=${root}\ncertificate=${caFile}\nprivate_key=${key}\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`);
  openssl(['ca', '-batch', '-notext', '-config', join(root, 'ca.cnf'), '-in', csr, '-out', expired, '-startdate', '20200101000000Z', '-enddate', '20200102000000Z']);
  let leaves = 0, failLeave = false, enrolledNodeId = '';
  const server = https.createServer({ key: await readFile(key), cert: await readFile(caFile) }, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/api/join') enrolledNodeId = JSON.parse(body).node.id;
    if (req.url === '/node/node-a/readyz') {
      assert.equal(req.headers['x-codex-node'], enrolledNodeId);
      res.end(JSON.stringify({ ok: true, host: true, files: true, nodeId: enrolledNodeId })); return;
    }
    if (req.url === '/api/leave') { leaves++; if (failLeave) { res.writeHead(503); return res.end('{"error":"retry"}'); } }
    const value = req.url === '/api/join' ? { credential: 'cocn_' + 'b'.repeat(43), entryBasePath: '/node/node-a/', turnEndpoint: null,
      frp: { serverAddr: 'localhost', tlsServerName: 'localhost', serverPort: 7000, token: 'synthetic_token_123456' } } : { ok: true };
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await chmod(caFile, 0o644);
  const origin = `https://127.0.0.1:${server.address().port}`, ca = readCenterCA(caFile), client = centerClient(origin, ca);
  assert((await client(origin + '/healthz')).ok);
  assert.throws(() => client('https://other.example.test/healthz'), /不匹配/);
  await assert.rejects(centerClient(origin)(origin + '/healthz'), /certificate/);
  const wrong = join(root, 'wrong.pem'); openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(root, 'wrong.key'), '-out', wrong, '-subj', '/CN=wrong']);
  await chmod(wrong, 0o644);
  await assert.rejects(centerClient(origin, readCenterCA(wrong))(origin + '/healthz'), /certificate/);
  // A trusted certificate with the wrong URL hostname still fails.
  const badHost = join(root, 'bad-host.pem'); openssl(['req', '-x509', '-new', '-key', key, '-days', '1', '-out', badHost, '-subj', '/CN=other.example.test', '-addext', 'subjectAltName=DNS:other.example.test']);
  await chmod(badHost, 0o644);
  server.setSecureContext({ key: await readFile(key), cert: await readFile(badHost) });
  await assert.rejects(centerClient(origin, readCenterCA(badHost))(origin + '/healthz'), /IP|altname|Hostname/);
  server.setSecureContext({ key: await readFile(key), cert: await readFile(expired) });
  await assert.rejects(client(origin + '/healthz'), /expired/);
  server.setSecureContext({ key: await readFile(key), cert: await readFile(caFile) });
  await mkdir(join(root, 'secrets')); await writeFile(join(root, '.env'), 'DEPLOY_MODE=terminal\n', { mode: 0o600 });
  const run = async (_file, args) => ({ ok: true, stdout: args.includes('is-active') ? 'active' : args.includes('--value') ? 'yes' : '' });
  const options = { root, server: origin, slug: 'node-a', mode: 'terminal', panelPort: 36080, caFile, configHome: join(root, 'config'), run, install: async () => '/opt/frpc', promptKey: async () => 'coc_' + 'a'.repeat(43) };
  await joinNode(options); assert((await nodeDoctor({ root, run })).ok);
  // Replacement uses the new center CA for release, and restores the old CA
  // before restarting the old panel when local activation fails.
  const nextCAFile = join(root, 'next-ca.pem');
  openssl(['req', '-x509', '-new', '-key', key, '-days', '1', '-out', nextCAFile, '-subj', '/CN=next-center', '-addext', 'subjectAltName=IP:127.0.0.1']);
  await chmod(nextCAFile, 0o644); let nextReleases = 0;
  const nextServer = https.createServer({ key: await readFile(key), cert: await readFile(nextCAFile) }, async (req, res) => {
    for await (const chunk of req) { void chunk; }
    if (req.url === '/api/leave') nextReleases++;
    res.end(JSON.stringify(req.url === '/api/join' ? { credential: 'cocn_' + 'd'.repeat(43), entryBasePath: '/node/node-a/', turnEndpoint: null,
      frp: { serverAddr: 'localhost', tlsServerName: 'localhost', serverPort: 7000, token: 'synthetic_token_123456' } } : { ok: true }));
  });
  nextServer.listen(0, '127.0.0.1'); await once(nextServer, 'listening');
  t.after(() => new Promise(resolve => { nextServer.close(resolve); nextServer.closeAllConnections(); }));
  const nextOrigin = `https://127.0.0.1:${nextServer.address().port}`;
  await assert.rejects(joinNode({ ...options, server: nextOrigin, caFile: undefined, replace: true }), /certificate/);
  let failed = false;
  await assert.rejects(joinNode({ ...options, server: nextOrigin, caFile: nextCAFile, replace: true, run: async (file, args) => {
    if (!failed && args.includes('restart') && args.includes('codex-cloud-panel.service')) { failed = true; return { ok: false, stderr: 'injected replacement failure' }; }
    return run(file, args);
  } }), /已回滚/);
  assert.equal(nextReleases, 1);
  assert.equal(await readFile(join(root, 'data/selfhost-node/frps-ca.pem'), 'utf8'), ca);
  assert((await nodeDoctor({ root, run })).ok);
  await leaveNode(options); assert.equal(leaves, 1);
  failLeave = true;
  await assert.rejects(joinNode({ ...options, run: async (file, args) => args.includes('restart') && args.includes('codex-cloud-panel.service') ? { ok: false, stderr: 'injected' } : run(file, args) }), /未完全确认/);
  failLeave = false;
  assert((await leaveNode({ ...options, recover: true })).recovered);
  assert.equal(leaves, 3);
});

test('CA reads reject links, pipes, oversized and writable files before consumption', async t => {
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'center-ca-bounds-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ca.pem'); await writeFile(file, Buffer.alloc(262145), { mode: 0o600 });
  assert.throws(() => readCenterCA(file), /大小/);
  await symlink(file, join(root, 'link')); assert.throws(() => readCenterCA(join(root, 'link')));
  execFileSync('mkfifo', [join(root, 'pipe')]); assert.throws(() => readCenterCA(join(root, 'pipe')), /权限或大小/);
  await writeFile(file, 'synthetic'); await chmod(file, 0o666); assert.throws(() => readCenterCA(file), /权限/);
});
