import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createForwardDownloads, FORWARD_FILES } from '../panel/forward-downloads.mjs';

const exec = promisify(execFile);
const entry = { arch: 'windows-amd64', name: FORWARD_FILES['windows-amd64'], size: 1, sha256: 'a'.repeat(64), build: 'isolated-test' };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'codex-download-review-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

for (const kind of ['manifest', 'binary']) test(`helper ${kind} FIFOs fail promptly without blocking filesystem workers`, async t => {
  const path = await directory(t);
  if (kind === 'binary') await writeFile(join(path, 'manifest.json'), JSON.stringify({ version: 1, files: [entry] }));
  execFileSync('mkfifo', [join(path, kind === 'manifest' ? 'manifest.json' : entry.name)]);
  // A child bounds even the pre-fix blocking open, so a failed regression never
  // leaves the test runner's filesystem thread pool wedged.
  const source = `import assert from 'node:assert/strict'; import {createForwardDownloads} from ${JSON.stringify(new URL('../panel/forward-downloads.mjs', import.meta.url).href)};
    const downloads=createForwardDownloads(process.argv[1]);
    if(process.argv[2]==='manifest') assert.deepEqual(await downloads.list(),[]);
    else await assert.rejects(downloads.serve('windows-amd64',{}),/Invalid helper binary/);`;
  await exec(process.execPath, ['--input-type=module', '-e', source, path, kind], { timeout: 1500, maxBuffer: 2048 });
});

test('helper manifest reads remain bounded when the file grows after its initial stat', async t => {
  const path = await directory(t), file = join(path, 'manifest.json');
  await writeFile(file, JSON.stringify({ version: 1, files: [entry], padding: 'x'.repeat(8192) }));
  const probe = await open(file), prototype = Object.getPrototypeOf(probe), stat = prototype.stat; await probe.close();
  t.mock.method(prototype, 'stat', async function (...args) { const info = await stat.apply(this, args); info.size = 1; return info; });
  assert.deepEqual(await createForwardDownloads(path).list(), []);
});
