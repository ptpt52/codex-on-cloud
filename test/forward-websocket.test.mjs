import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), child = fileURLToPath(new URL('./support/forward-websocket-child.mjs', import.meta.url));
// An unhandled ws error must fail a real child process, without a test-runner
// uncaughtException handler hiding whether the panel itself would survive.
for (const phase of ['tcp-pair', 'serial-pair', 'tcp-resume']) for (const fault of ['unmasked', 'oversized']) {
  test(`${phase}: ${fault} helper frames close only that connection and preserve the panel and another TCP stream`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-forward-ws-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await exec(process.execPath, [child, directory, phase, fault], { timeout: 15000, maxBuffer: 8192 });
    assert.equal(result.stdout.trim(), 'isolated helper error; panel and existing TCP stream preserved');
    assert.equal(result.stderr, '');
  });
}
