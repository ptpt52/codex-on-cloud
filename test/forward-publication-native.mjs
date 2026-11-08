// Actual compiler, packager, lease supervisor and download streams. No service
// restart, production artifacts, user configuration or platform execution.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { buildForward } from '../scripts/build-forward.mjs';
import { createForwardDownloads } from '../panel/forward-downloads.mjs';

const exec = promisify(execFile), source = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'codex-forward-publication-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GOTOOLCHAIN: 'local' };
try {
  await mkdir(join(root, 'client')); await mkdir(join(root, 'scripts'));
  await cp(join(source, 'client/forward'), join(root, 'client/forward'), { recursive: true });
  await cp(join(source, 'scripts/forward_package.py'), join(root, 'scripts/forward_package.py'));
  await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://synthetic-build.example.test\n', { mode: 0o600 });
  const options = { cwd: root, env, timeout: 30000, maxBuffer: 16384 };
  await exec('git', ['init', '--quiet', '--template='], options);
  await exec('git', ['add', 'client', 'scripts'], options);
  await exec('git', ['-c', 'user.name=Build fixture', '-c', 'user.email=build@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'synthetic compiler fixture'], options);
  const result = await buildForward({ root }), directory = join(root, 'data/forward-client');
  const downloads = createForwardDownloads(directory), listed = await downloads.list();
  assert.equal(listed.length, 4);
  for (const item of listed) {
    assert.ok(item.href.endsWith('?generation=' + result.generation));
    const chunks = [], response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status, headers) => { assert.equal(status, 200); assert.equal(headers['content-length'], item.size); };
    await downloads.serve(item.arch, response, result.generation);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, item.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    const [platform, arch] = item.arch.split('-'), artifact = join(directory, 'releases', result.generation, item.name);
    let binary = artifact;
    if (platform === 'darwin') {
      binary = join(root, 'inspected-macho');
      await exec('python3', ['-c', `import sys, zipfile
from pathlib import Path
from scripts.forward_package import validate_macho
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    assert len(archive.infolist()) == 3
    root = 'codex-cloud-forward-macos-' + sys.argv[2] + '/'
    data = archive.read(root + 'codex-cloud-forward')
    validate_macho(data, 'darwin-' + sys.argv[2])
    for name, mode in [('codex-cloud-forward', 0o755), ('Start.command', 0o755), ('README.txt', 0o644)]:
        assert archive.getinfo(root + name).external_attr >> 16 & 0o777 == mode
    Path(sys.argv[3]).write_bytes(data)
`, artifact, arch, binary], options);
    } else assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    const metadata = (await exec('go', ['version', '-m', binary], options)).stdout;
    assert.match(metadata, /go1\.26\.4/); assert.ok(metadata.includes('GOOS=' + platform)); assert.ok(metadata.includes('GOARCH=' + arch));
    const binaryBytes = platform === 'darwin' ? await readFile(binary) : bytes;
    assert.ok(binaryBytes.includes(Buffer.from('https://synthetic-build.example.test'))); assert.ok(binaryBytes.includes(Buffer.from(item.build)));
    assert.deepEqual(await readFile(artifact), bytes);
    console.log('✓ ' + item.arch + ': actual pinned compiler, supervised lease, package structure and published download digest');
  }
} finally { await rm(root, { recursive: true, force: true }); }
