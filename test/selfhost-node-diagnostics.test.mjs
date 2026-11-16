import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NODE_DIAGNOSTIC_LIMITS, readNodeDiagnostics, trackNodeOperation } from '../selfhost/node-operation.mjs';
import { NODE_SERVICE, relayDetails } from '../selfhost/node-service.mjs';
import { nodeEntryStatus } from '../selfhost/node-health.mjs';
import { nodeDoctor } from '../selfhost/node-diagnostics.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'selfhost-diagnostic-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, 'data/selfhost-node/diagnostics.json') };
}

test('operation diagnostics report explicit retries and readiness while excluding raw failures and secrets', async t => {
  const h = await setup(t), secret = 'private_proof_and_workspace_path';
  for (let index = 0; index < 2; index++) await assert.rejects(trackNodeOperation(h.root, 'join', async report => { await report('enrolling'); throw Object.assign(Error(secret), { code: 'ENOTFOUND' }); }));
  const failed = await readNodeDiagnostics(h.root);
  assert.equal(failed.stage, 'enrolling'); assert.equal(failed.reason, 'dns'); assert.equal(failed.retryCount, 1); assert.equal(failed.lastSuccessAt, null);
  await trackNodeOperation(h.root, 'join', async report => { await report('verifying'); return { entryReady: true }; });
  const ready = await readNodeDiagnostics(h.root);
  assert.equal(ready.status, 'succeeded'); assert.equal(ready.retryCount, 2); assert(ready.lastReadyAt > 0); assert.equal(ready.lastReadyAt, ready.lastSuccessAt);
  assert(!(await readFile(h.file, 'utf8')).includes(secret)); assert.equal((await stat(h.file)).mode & 0o077, 0);
  const before = await readFile(h.file, 'utf8'); await readNodeDiagnostics(h.root); assert.equal(await readFile(h.file, 'utf8'), before);
  const extra = JSON.parse(before); extra.private = secret; extra.history[0].private = secret;
  await writeFile(h.file, JSON.stringify(extra), { mode: 0o600 });
  assert(!(JSON.stringify(await readNodeDiagnostics(h.root))).includes(secret));
});

test('diagnostic history has fixed byte and event bounds across repeated operations', async t => {
  const h = await setup(t);
  for (let index = 0; index < 20; index++) await trackNodeOperation(h.root, 'join', async report => { await report('preparing'); return { entryReady: false }; });
  const result = await readNodeDiagnostics(h.root);
  assert.equal(result.history.length, NODE_DIAGNOSTIC_LIMITS.events); assert((await stat(h.file)).size <= NODE_DIAGNOSTIC_LIMITS.bytes);
  assert.equal(result.retryCount, 0); assert.equal(result.lastReadyAt, null);
});

test('invalid or unsafe diagnostics do not block operations or leak private file fields', async t => {
  const h = await setup(t); await mkdir(join(h.root, 'data/selfhost-node'), { recursive: true });
  await writeFile(h.file, '{"private":"never expose"}', { mode: 0o600 }); await chmod(h.file, 0o644);
  let performed = false;
  const result = await trackNodeOperation(h.root, 'leave', async () => { performed = true; return { left: true }; });
  assert(performed); assert.match(result.warning, /诊断状态无法保存/);
  assert.deepEqual(await readNodeDiagnostics(h.root), { available: false, reason: 'diagnostics_unavailable' });
  assert.equal(await readFile(h.file, 'utf8'), '{"private":"never expose"}');
});

test('relay counters use a fixed read-only systemd action and never export other properties', async () => {
  const result = await relayDetails(async (file, args) => {
    assert.equal(file, 'systemctl'); assert.deepEqual(args.slice(0, 3), ['--user', 'show', NODE_SERVICE]);
    return { ok: true, stdout: 'NRestarts=7\nExecMainStatus=203\nActiveEnterTimestamp=2026-11-16 08:00:00 UTC\nEnvironment=private_proof\n' };
  });
  assert.equal(result.restartCount, 7); assert.equal(result.exitStatus, 203); assert(result.activeSinceAt > 0); assert(!JSON.stringify(result).includes('private_proof'));
});

test('entry diagnostics distinguish transport, HTTP, invalid responses and wrong node identity', async () => {
  const connection = { origin: 'https://desk.example.test', path: '/node/a/', nodeId: 'a'.repeat(32) };
  assert.equal((await nodeEntryStatus(connection, { request: async () => { throw Object.assign(Error('private'), { code: 'CERT_HAS_EXPIRED' }); } })).reason, 'tls');
  assert.deepEqual(await nodeEntryStatus(connection, { request: async () => new Response('{}', { status: 503 }) }), { ok: false, reason: 'http_status', status: 503 });
  assert.equal((await nodeEntryStatus(connection, { request: async () => new Response('bad-json') })).reason, 'response_format');
  assert.equal((await nodeEntryStatus(connection, { request: async () => new Response('{"ok":true,"host":true,"files":true,"nodeId":"other"}') })).reason, 'node_identity');
});

test('doctor reports damaged private configuration as structured diagnostics without copying its content', async t => {
  const h = await setup(t), file = join(h.root, 'data/selfhost-node/connection.json');
  await mkdir(join(h.root, 'data/selfhost-node'), { recursive: true }); await writeFile(file, '{"credential":"private-proof"}', { mode: 0o600 });
  const result = await nodeDoctor({ root: h.root });
  assert.equal(result.ok, false); assert.equal(result.reason, 'configuration_invalid'); assert(!JSON.stringify(result).includes('private-proof'));
  assert.equal(await readFile(file, 'utf8'), '{"credential":"private-proof"}');
});
