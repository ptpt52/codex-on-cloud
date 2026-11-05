import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuth, SESSION_FILE_LIMIT } from '../panel/auth.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-auth-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, config: { dataDir: directory, password: 'test_password_very_long_123', username: 'admin', sessionMs: 60000 } };
}
test('session startup bounds reads and rejects symbolic links, directories and FIFOs', { timeout: 5000 }, async t => {
  const { directory, config } = await setup(t), file = join(directory, 'sessions.json');
  await writeFile(file, JSON.stringify({ revision: 'old', sessions: [], padding: 'x'.repeat(SESSION_FILE_LIMIT) }));
  await assert.rejects(createAuth(config), /登录状态文件无法读取/); await rm(file);
  const victim = join(directory, 'victim'); await writeFile(victim, 'keep'); await symlink(victim, file);
  await assert.rejects(createAuth(config), /登录状态文件无法读取/); assert.equal(await readFile(victim, 'utf8'), 'keep'); await rm(file);
  await symlink(directory, file); await assert.rejects(createAuth(config), /登录状态文件无法读取/); await rm(file);
  execFileSync('mkfifo', [file]); await assert.rejects(createAuth(config), /登录状态文件无法读取/);
});
test('a temporary session symlink cannot overwrite its target', async t => {
  const { directory, config } = await setup(t), victim = join(directory, 'victim');
  await writeFile(victim, 'keep'); await symlink(victim, join(directory, 'sessions.json.tmp'));
  await assert.rejects(createAuth(config), /Invalid session temporary file/);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
});
test('concurrent session creation and revocation persist only the final eight bounded records', async t => {
  const { directory, config } = await setup(t); await writeFile(join(directory, 'sessions.json.tmp'), 'interrupted');
  const auth = await createAuth(config), created = await Promise.all(Array.from({ length: 16 }, () => auth.create()));
  await Promise.all(created.slice(-3).map(item => auth.revoke(item.token))); await auth.close();
  const bytes = await readFile(join(directory, 'sessions.json')), stored = JSON.parse(bytes);
  assert.ok(bytes.length <= SESSION_FILE_LIMIT); assert.equal(stored.sessions.length, 5);
  assert.equal((await lstat(join(directory, 'sessions.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const item of created) assert.equal(bytes.includes(Buffer.from(item.token)), false);
  const restored = await createAuth(config); await restored.close();
  assert.equal(created.filter(item => restored.get(item.token)).length, 5);
  await assert.rejects(lstat(join(directory, 'sessions.json.tmp')), { code: 'ENOENT' });
});
test('malformed stored session records are dropped without preserving unknown fields', async t => {
  const { directory, config } = await setup(t), auth = await createAuth(config), created = await auth.create(); await auth.close();
  const file = join(directory, 'sessions.json'), stored = JSON.parse(await readFile(file, 'utf8'));
  stored.sessions.push(null, { ...stored.sessions[0], hash: 'b'.repeat(64), csrf: 'invalid' }, { ...stored.sessions[0], hash: 'c'.repeat(64), expires: null });
  stored.sessions[0].unexpected = 'discard'; await writeFile(file, JSON.stringify(stored));
  const restored = await createAuth(config); assert.ok(restored.get(created.token)); await restored.close();
  const after = JSON.parse(await readFile(file, 'utf8')); assert.equal(after.sessions.length, 1); assert.equal(after.sessions[0].unexpected, undefined);
});
