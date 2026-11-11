import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeLocalHttps, validateServerCertificate } from '../selfhost/certificates.mjs';

let directory, certificate, replacement, expired, privateKey, ca, wrongKey;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-certificates-'));
  const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10000 });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Isolated test CA']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=desk.example.test']);
  await writeFile(join(directory, 'server.ext'), 'subjectAltName=DNS:desk.example.test\n');
  for (const [file, serial] of [['server.crt', '1'], ['replacement.crt', '2']]) openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', serial, '-days', '1', '-extfile', 'server.ext', '-out', file]);
  openssl(['x509', '-req', '-in', 'server.csr', '-signkey', 'server.key', '-days', '-1', '-extfile', 'server.ext', '-out', 'expired.crt']);
  [certificate, replacement, expired, privateKey, ca, wrongKey] = await Promise.all(['server.crt', 'replacement.crt', 'expired.crt', 'server.key', 'ca.crt', 'ca.key'].map(name => readFile(join(directory, name))));
});
test.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('certificate preflight rejects expired, future, wrong-host and mismatched-key imports', () => {
  const domain = 'desk.example.test', leaf = new X509Certificate(certificate);
  assert.equal(validateServerCertificate(certificate, { domain, privateKey }).fingerprint256, leaf.fingerprint256);
  assert.throws(() => validateServerCertificate(expired, { domain, privateKey }), /已过期/);
  assert.throws(() => validateServerCertificate(certificate, { domain, now: Date.parse(leaf.validFrom) - 1 }), /尚未生效/);
  assert.throws(() => validateServerCertificate(certificate, { domain: 'other.example.test' }), /域名/);
  assert.throws(() => validateServerCertificate(certificate, { domain, privateKey: wrongKey }), /私钥不匹配/);
  assert.throws(() => validateServerCertificate(Buffer.concat([certificate, expired]), { domain }), /已过期/);
});

async function serve(t, cert, handler = (_req, res) => res.end('{"ok":true}')) {
  const server = https.createServer({ cert, key: privateKey }, handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

test('real HTTPS health accepts an explicitly pinned private certificate without modifying global trust', async t => {
  const port = await serve(t, certificate);
  assert.equal(await probeLocalHttps('desk.example.test', { certificate, port }), true);
  const chain = Buffer.concat([certificate, ca]);
  assert.equal(await probeLocalHttps('desk.example.test', { certificate: chain, port }), true);
  // A different valid leaf under the same CA is still the wrong installed cert.
  const other = await serve(t, replacement);
  await assert.rejects(probeLocalHttps('desk.example.test', { certificate: chain, port: other }), /已安装的证书/);
});

test('HTTPS health rejects expiry before connecting and bounds both response bytes and total request time', async t => {
  assert.throws(() => probeLocalHttps('desk.example.test', { certificate: expired }), /已过期/);
  const oversized = await serve(t, certificate, (_req, res) => res.end('x'.repeat(16385)));
  await assert.rejects(probeLocalHttps('desk.example.test', { certificate, port: oversized }), /16 KiB/);
  const stalled = await serve(t, certificate, (_req, res) => { res.writeHead(200); res.write('{'); });
  await assert.rejects(probeLocalHttps('desk.example.test', { certificate, port: stalled, timeout: 100 }), /abort|超时/i);
  const bad = await serve(t, certificate, (_req, res) => res.end('{"ok":false}'));
  assert.equal(await probeLocalHttps('desk.example.test', { certificate, port: bad }), false);
});
