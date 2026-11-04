// Cross-compilation and package inspection; no claim of executing macOS here.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'codex-mac-build-'));
const binary = join(directory, 'helper'), archive = join(directory, 'helper.zip');
const env = { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0' };
try {
  assert.match((await exec('go', ['version'], { env })).stdout, /^go version go1\.26\.4 /);
  for (const arch of ['arm64', 'amd64']) {
    await exec('go', ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags', '-s -w -X main.version=mac-package-test', '-o', binary, '.'],
      { cwd: resolve('client/forward'), env: { ...env, GOOS: 'darwin', GOARCH: arch }, timeout: 180000, maxBuffer: 16384 });
    await rm(archive, { force: true });
    await exec('python3', ['scripts/forward_package.py', 'darwin-' + arch, binary, archive], { timeout: 30000, maxBuffer: 16384 });
    await exec('python3', ['-c', `import sys, zipfile
from pathlib import Path
from scripts.forward_package import validate_macho
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    assert len(archive.infolist()) == 3
    root = 'codex-cloud-forward-macos-' + sys.argv[2] + '/'
    data = archive.read(root + 'codex-cloud-forward')
    assert data == Path(sys.argv[3]).read_bytes()
    validate_macho(data, 'darwin-' + sys.argv[2])
    for name, mode in [('codex-cloud-forward', 0o755), ('Start.command', 0o755), ('README.txt', 0o644)]:
        assert archive.getinfo(root + name).external_attr >> 16 & 0o777 == mode
`, archive, arch, binary], { timeout: 30000, maxBuffer: 16384 });
    const metadata = (await exec('go', ['version', '-m', binary], { env, maxBuffer: 16384 })).stdout;
    assert.match(metadata, /go1\.26\.4/); assert.match(metadata, new RegExp('GOARCH=' + arch)); assert.match(metadata, /GOOS=darwin/);
    console.log('✓ macOS ' + arch + ': real Mach-O, pinned Go, macOS 12 target, ZIP CRC/exact bytes/permissions' + (arch === 'arm64' ? ' and ad-hoc signature presence' : ''));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
