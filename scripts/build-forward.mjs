import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rename, unlink, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { settings } from '../native/config.mjs';
import { FORWARD_FILES } from '../panel/forward-downloads.mjs';

const exec = promisify(execFile), config = settings(), directory = join(config.root, 'data', 'forward-client');
const toolVersion = (await exec('go', ['version'], { env: { ...process.env, GOTOOLCHAIN: 'local' } })).stdout;
if (!/^go version go1\.26\.4 /.test(toolVersion)) throw new Error('请先安装 Go 1.26.4；构建不会自动升级或下载工具链');
const origin = new URL(process.argv[2] || config.env.PUBLIC_ORIGIN || 'http://localhost:36080');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol) ||
  (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('构建地址必须是 HTTPS 根地址；仅回环测试允许 HTTP');
const revision = (await exec('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: config.root })).stdout.trim();
const build = '0.2.0+' + revision;
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('构建目录无效');
const lock = await open(join(directory, '.build.lock'), 'wx', 0o600);
const temporary = join(directory, 'helper.tmp'), metadata = join(directory, 'manifest.tmp'), files = [];
try {
  for (const [arch, name] of Object.entries(FORWARD_FILES)) {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await exec('go', ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags', '-s -w -X main.defaultServer=' + origin.origin + ' -X main.version=' + build, '-o', temporary, '.'], {
      cwd: join(config.root, 'client', 'forward'), timeout: 180000, maxBuffer: 16384,
      env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOOS: 'windows', GOARCH: arch.split('-')[1] },
    });
    const bytes = await readFile(temporary);
    if (bytes.length < 64 || bytes.length > 32 * 1024 * 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Windows 助手产物无效或超过 32 MiB');
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== (arch === 'windows-amd64' ? 0x8664 : 0xaa64)) throw new Error('Windows 助手 PE 架构校验失败');
    files.push({ arch, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), build });
    await rename(temporary, join(directory, name));
  }
  await writeFile(metadata, JSON.stringify({ version: 1, files }) + '\n', { mode: 0o600 });
  await rename(metadata, join(directory, 'manifest.json'));
  for (const file of files) console.log(file.name + ' · ' + file.size + ' bytes · SHA256 ' + file.sha256);
} finally {
  await lock.close(); await unlink(join(directory, '.build.lock'));
  await unlink(temporary).catch(() => {}); await unlink(metadata).catch(() => {});
}
