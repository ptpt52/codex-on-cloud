import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('private resolver mount leaves host DNS unchanged and preserves literal command arguments', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mount namespaces required');
  const prefix = ['--user', '--map-root-user', '--mount', '--propagation', 'private', '--'];
  const probe = spawnSync('unshare', [...prefix, 'true'], { timeout: 3000 });
  if (probe.status !== 0) return t.skip('Unprivileged user/mount namespaces unavailable');
  const before = await readFile('/etc/resolv.conf', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'codex-resolver-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolver = join(directory, 'resolv.conf');
  const expected = 'nameserver 192.0.2.53\noptions timeout:1 attempts:1\n';
  await writeFile(resolver, expected, { mode: 0o600 });
  const marker = join(directory, 'must-not-exist');
  const literal = 'spaces; $(touch ' + marker + ')';
  const wrapper = fileURLToPath(new URL('../native/with-resolver.sh', import.meta.url));
  const script = "process.stdout.write(JSON.stringify({dns:require('node:fs').readFileSync('/etc/resolv.conf','utf8'),argument:process.argv[1]}))";
  const result = spawnSync('unshare', [...prefix, 'bash', wrapper, resolver, process.execPath, '-e', script, literal], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { dns: expected, argument: literal });
  assert.equal(await readFile('/etc/resolv.conf', 'utf8'), before);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
