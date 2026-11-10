import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caddyAcmeConfig, caddyConfig, caddyUnit, centerEnvironment, centerUnit, certbotHook,
  coturnConfig, coturnUnit, frpsConfig, frpsUnit, serverDomain, serverEmail,
} from '../selfhost/server-config.mjs';

test('center domain and certificate email are strict command-line inputs', () => {
  assert.equal(serverDomain('Desk.Example.COM'), 'desk.example.com');
  assert.equal(serverEmail('ops@example.com'), 'ops@example.com');
  for (const value of ['', 'localhost', 'https://desk.example.com', 'desk..example.com', '-desk.example.com', 'desk.example.com/path']) assert.throws(() => serverDomain(value), /域名/);
  for (const value of ['', 'not-an-email', 'a@b', 'a\n@example.com']) assert.throws(() => serverEmail(value), /邮箱/);
});

test('Caddy routes node paths through auth and frps while keeping internals private', () => {
  const config = caddyConfig('desk.example.com');
  assert.match(config, /servers \{\n\t\tprotocols h1 h2/);
  assert.match(config, /handle \/internal\/\* \{\n\t\trespond 404/);
  assert.match(config, /forward_auth 127\.0\.0\.1:36180/);
  assert.match(config, /path=\{(?:http\.request\.uri\.path|http\.request\.uri)\}/);
  assert.match(config, /reverse_proxy 127\.0\.0\.1:18080/);
  assert.match(config, /header_up Host \{host\}/);
  assert.match(config, /flush_interval -1/);
  assert.match(caddyAcmeConfig('desk.example.com', '/var/lib/codex-selfhost/acme'), /handle \/\.well-known\/acme-challenge/);
});

test('frps requires TLS, exact plugin operations and loopback management', () => {
  const token = 't'.repeat(64), config = frpsConfig({ token, adminPassword: 'a'.repeat(24) });
  assert.match(config, /bindPort = 7000/); assert.match(config, /vhostHTTPPort = 18080/);
  assert.match(config, /transport\.tls\.force = true/); assert.match(config, /webServer\.addr = "127\.0\.0\.1"/);
  assert.match(config, /ops = \["Login", "NewProxy", "CloseProxy", "Ping"\]/);
  assert(!config.includes('allowPorts'));
  assert.throws(() => frpsConfig({ token: 'short', adminPassword: 'a'.repeat(24) }), /token/);
  assert.throws(() => frpsConfig({ token, adminPassword: 'short' }), /管理密码/);
});

test('systemd units isolate privileges and have explicit memory, task and file bounds', () => {
  const center = centerUnit(), frps = frpsUnit(), caddy = caddyUnit();
  assert.match(center, /User=codex-selfhost/); assert.match(center, /ProtectSystem=strict/); assert.match(center, /MemoryMax=768M/); assert.match(center, /TasksMax=256/);
  assert.match(frps, /Requires=codex-selfhost-center.service/); assert.match(frps, /MemoryMax=512M/); assert.match(frps, /LimitNOFILE=65536/);
  assert.match(caddy, /ExecReload=.*caddy reload/); assert.match(caddy, /ProtectHome=true/);
});

test('generated environment and renewal hook contain no embedded credentials', () => {
  const env = centerEnvironment({ domain: 'desk.example.com' }), hook = certbotHook('desk.example.com');
  assert.match(env, /SELFHOST_ORIGIN=https:\/\/desk\.example\.com/);
  assert.match(env, /SELFHOST_TURN_SECRET_FILE=/);
  assert(!/=.{64,}/.test(env));
  assert.match(hook, /install -o root -g codex-selfhost -m 0640/);
  assert.match(hook, /systemctl restart codex-selfhost-frps\.service/);
  assert.match(hook, /systemctl reload codex-selfhost-caddy\.service/);
  assert.match(hook, /systemctl restart codex-selfhost-coturn\.service/);
});

test('coturn uses short-lived auth secrets, the requested relay range and private-peer denial', () => {
  const config = coturnConfig({ domain: 'desk.example.com', publicIp: '192.0.2.10', secret: 's'.repeat(64) });
  assert.match(config, /min-port=49160\nmax-port=49223/);
  assert.match(config, /use-auth-secret\nstatic-auth-secret=/);
  assert.match(config, /denied-peer-ip=10\.0\.0\.0-10\.255\.255\.255/);
  assert.match(config, /denied-peer-ip=127\.0\.0\.0-127\.255\.255\.255/);
  assert.match(coturnUnit(), /User=turnserver/);
  assert.match(coturnUnit(), /SupplementaryGroups=codex-selfhost/);
});
