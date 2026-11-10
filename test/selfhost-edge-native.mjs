// Actual pinned Caddy, HTTP-01 webroot and upstream cookie filtering.
// Certificate hook commands use a local harness; no systemd or public ACME request.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { caddyAcmeConfig, caddyConfig, certbotHook } from '../selfhost/server-config.mjs';

const directory = await mkdtemp(join(tmpdir(), 'codex-edge-native-'));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
let child, output = '', upstream;
const stop = async () => { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } };
const httpGet = (port, path) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', bytes => body += bytes); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject));
try {
  const httpPort = await freePort(), httpsPort = await freePort(), tlsDir = join(directory, 'tls'), webroot = join(directory, 'acme');
  await mkdir(tlsDir); await mkdir(join(webroot, '.well-known/acme-challenge'), { recursive: true });
  await writeFile(join(webroot, '.well-known/acme-challenge/probe'), 'bounded-challenge');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(tlsDir, 'privkey.pem'), '-out', join(tlsDir, 'fullchain.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  upstream = http.createServer((req, res) => { if (req.url.startsWith('/internal/route-auth')) { res.writeHead(204); res.end(); } else res.end(req.headers.cookie || 'empty'); });
  const upstreamPort = await listen(upstream), file = join(directory, 'Caddyfile'), binary = process.env.CADDY_PATH || 'caddy';
  const run = async config => {
    await writeFile(file, config.replaceAll('https://desk.example.test', 'https://127.0.0.1:' + httpsPort).replaceAll('http://desk.example.test', 'http://127.0.0.1:' + httpPort));
    execFileSync(binary, ['validate', '--config', file, '--adapter', 'caddyfile'], { stdio: 'pipe', timeout: 10000 });
    child = spawn(binary, ['run', '--config', file, '--adapter', 'caddyfile'], { cwd: directory, env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-32768); });
    for (let i = 0; i < 100; i++) { try { if ((await httpGet(httpPort, '/.well-known/acme-challenge/probe')).status === 200) return; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
    throw Error('Caddy failed to start: ' + output.slice(-2000));
  };
  await run(caddyAcmeConfig('desk.example.test', webroot));
  assert.equal((await httpGet(httpPort, '/.well-known/acme-challenge/probe')).body, 'bounded-challenge'); await stop();
  await run(caddyConfig('desk.example.test', { tlsDirectory: tlsDir, webroot, centerPort: upstreamPort, frpHttpPort: upstreamPort, adminCidrs: ['198.51.100.0/24'] }));
  assert.equal((await httpGet(httpPort, '/.well-known/acme-challenge/probe')).body, 'bounded-challenge');
  const ca = await readFile(join(tlsDir, 'fullchain.pem'));
  for (const cookie of ['coc_session_center=old; coc_session_center_admin=new; coc_session_node=keep', 'coc_session_node=keep; coc_session_center_admin=new; coc_session_center=old']) {
    const body = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: httpsPort, path: '/node/test/', ca, headers: { cookie } }, res => { let body = ''; res.on('data', bytes => body += bytes); res.on('end', () => resolve(body)); }).on('error', reject));
    assert(body.includes('coc_session_node=keep')); assert(!body.includes('old') && !body.includes('new'));
  }
  for (const [path, expected] of [['/admin/', 403], ['/admin/api/keys', 403], ['/api/join', 200], ['/node/test/', 200]]) {
    const status = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', localAddress: '127.0.0.2', port: httpsPort, path, ca }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    assert.equal(status, expected, path);
  }
  await stop();
  // Exercise both generated shell phases without touching users or services.
  const bin = join(directory, 'bin'), calls = join(directory, 'calls'), issued = join(directory, 'issued'); await mkdir(bin); await mkdir(issued);
  for (const name of ['fullchain.pem', 'privkey.pem']) await writeFile(join(issued, name), await readFile(join(tlsDir, name)));
  await writeFile(join(bin, 'install'), '#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]; out=[]\nwhile a:\n x=a.pop(0)\n if x in ["-o","-g"]: a.pop(0)\n else: out.append(x)\nos.execv("/usr/bin/install", ["install"]+out)\n');
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_CALLS"\n');
  for (const name of ['install', 'systemctl']) await chmod(join(bin, name), 0o755);
  for (const restart of [false, true]) {
    const hook = certbotHook('desk.example.test', { configDirectory: directory, restart }).replaceAll('/etc/letsencrypt/live/desk.example.test', issued);
    execFileSync('/bin/sh', ['-c', hook], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, HOOK_CALLS: calls }, stdio: 'pipe', timeout: 10000 });
  }
  assert.equal((await readFile(calls, 'utf8')).trim(), 'restart codex-selfhost-frps.service\nrestart codex-selfhost-caddy.service\nrestart codex-selfhost-coturn.service');
  console.log('✓ actual Caddy bootstrap and renewal HTTP-01 routes, TLS and node cookie filtering; certificate hook command harness');
} finally { await stop(); if (upstream) await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); }
