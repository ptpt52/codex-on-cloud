import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildForward } from '../scripts/build-forward.mjs';

test('forward builds use persisted configuration instead of the task environment and keep explicit origins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forward-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://current.example.test\n', { mode: 0o600 });
  const before = process.env.PUBLIC_ORIGIN; t.after(() => { if (before === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = before; });
  process.env.PUBLIC_ORIGIN = 'https://stale.example.test';
  for (const origin of [undefined, 'https://explicit.example.test']) {
    let compiled = false;
    await assert.rejects(buildForward({ root, origin }, { run: async (file, args) => {
      if (file === 'git') return { stdout: '123456abcdef\n' };
      if (args[0] === 'version') return { stdout: 'go version go1.26.4 linux/amd64\n' };
      compiled = true; assert.ok(args.includes('-s -w -X main.defaultServer=' + (origin || 'https://current.example.test') + ' -X main.version=0.7.2+123456abcdef'));
      throw Error('synthetic compiler stop');
    } }), /synthetic compiler stop/);
    assert.equal(compiled, true);
  }
});
