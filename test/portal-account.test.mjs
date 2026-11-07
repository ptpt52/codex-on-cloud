import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePortalAccount } from '../scripts/portal-account.mjs';

test('Workers account initialization preserves an existing global subdomain and creates only after explicit intent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-portal-account-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const apiTokenFile = join(dir, 'token'); await writeFile(apiTokenFile, 'test-only-token-'.repeat(3), { mode: 0o600 });
  const options = { accountId: 'a'.repeat(32), apiTokenFile }; const calls = [];
  const existing = await preparePortalAccount({ ...options, subdomain: 'different-name', request: async (url, init) => { calls.push(init.method); assert.equal(init.redirect, 'error'); return Response.json({ success: true, result: { subdomain: 'already-owned' } }); } });
  assert.deepEqual(existing, { created: false, subdomain: 'already-owned' }); assert.deepEqual(calls, ['GET']);
  const missing = () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
  await assert.rejects(preparePortalAccount({ ...options, request: async () => missing() }), /显式指定/);
  calls.length = 0;
  const created = await preparePortalAccount({ ...options, subdomain: 'new-account', request: async (url, init) => { calls.push(init.method); if (init.method === 'GET') return missing(); assert.deepEqual(JSON.parse(init.body), { subdomain: 'new-account' }); return Response.json({ success: true, result: { subdomain: 'new-account' } }); } });
  assert.deepEqual(created, { created: true, subdomain: 'new-account' }); assert.deepEqual(calls, ['GET', 'PUT']);
});

test('permission errors, oversized replies and uncertain writes do not trigger automatic initialization retries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-portal-account-errors-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const apiTokenFile = join(dir, 'token'); await writeFile(apiTokenFile, 'test-only-token-'.repeat(3), { mode: 0o600 });
  const options = { accountId: 'a'.repeat(32), apiTokenFile, subdomain: 'new-account' }; const methods = [];
  await assert.rejects(preparePortalAccount({ ...options, request: async (url, init) => { methods.push(init.method); return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }); } }), /HTTP 403/); assert.deepEqual(methods, ['GET']);
  await assert.rejects(preparePortalAccount({ ...options, request: async () => Response.json({ result: 'x'.repeat(65536) }) }), /读取.*失败/);
  methods.length = 0;
  await assert.rejects(preparePortalAccount({ ...options, request: async (url, init) => { methods.push(init.method); if (init.method === 'GET') return Response.json({ errors: [{ code: 10007 }] }, { status: 404 }); throw Error('lost response'); } }), /结果未知/); assert.deepEqual(methods, ['GET', 'PUT']);
});
