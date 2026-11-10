import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloudflareAPI, cloudflareTokenFile, publicationClient } from '../scripts/cloudflare-client.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cf-token-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'secrets'), { mode: 0o700 });
  await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://home.example.test\n', { mode: 0o600 });
  return root;
}
test('Cloudflare publication reads the private conventional token file while explicit and saved paths retain precedence', async t => {
  const root = await fixture(t), path = join(root, 'secrets/cf_token');
  await writeFile(path, 'synthetic_private_cf_token\n', { mode: 0o600 }); const calls = [];
  const publication = await publicationClient({ domain: 'home.example.test', zone: 'example.test' }, { root, request: async (url, options) => {
    calls.push({ url, options }); return Response.json({ success: true, result: [] });
  } });
  await assert.rejects(publication.prepare({ domain: 'home.example.test', zone: 'example.test' }), /区域/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic_private_cf_token');
  assert.equal(cloudflareTokenFile(undefined, { root }), path);
  assert.equal(cloudflareTokenFile(undefined, { root, fallback: '/private/saved-token' }), '/private/saved-token');
  assert.equal(cloudflareTokenFile('explicit-token', { root, fallback: '/private/saved-token' }), resolve('explicit-token'));
});
test('a readable-by-others or oversized conventional CF token is rejected before any API request', async t => {
  const root = await fixture(t), path = join(root, 'secrets/cf_token'); let calls = 0;
  const options = { root, request: async () => { calls++; throw Error('must not request'); } };
  await writeFile(path, 'synthetic_private_cf_token', { mode: 0o600 }); await chmod(path, 0o644);
  await assert.rejects(publicationClient({}, options), /权限或大小/);
  await chmod(path, 0o600); await writeFile(path, 'x'.repeat(4097));
  await assert.rejects(publicationClient({}, options), /权限或大小/); assert.equal(calls, 0);
});

test('Cloudflare accepts a confirmed 204 deletion while empty reads and ordinary writes remain unconfirmed', async t => {
  const root = await fixture(t), path = join(root, 'secrets/cf_token'); await writeFile(path, 'synthetic_private_cf_token', { mode: 0o600 });
  const api = await cloudflareAPI(path, { privateFile: true, request: async (_url, options) => new Response(null, { status: options.method === 'POST' ? 200 : 204 }) });
  assert.equal(await api('/accounts/example/workers/domains/example', 'DELETE'), null);
  await assert.rejects(api('/accounts/example/workers/domains'), /响应无效/);
  await assert.rejects(api('/zones/example/dns_records', 'POST', {}), /响应无效/);
});
