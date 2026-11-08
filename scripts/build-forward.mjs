import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, unlink, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { root as projectRoot } from '../native/config.mjs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portalRead, portalWrite } from './portal-files.mjs';
import { FORWARD_FILES, ARTIFACT_LIMITS, artifactRead, currentGeneration, prepareReleaseDirectory, removeRelease } from '../native/forward-artifacts.mjs';

const exec = promisify(execFile);
export async function buildForward({ root = projectRoot, origin: explicit } = {}, { run = exec, publish = portalWrite } = {}) {
  const directory = join(root, 'data', 'forward-client');
  let persisted = {};
  try { persisted = parseEnv(await portalRead(join(root, '.env'), 65536, true)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const toolVersion = (await run('go', ['version'], { env: { ...process.env, GOTOOLCHAIN: 'local' } })).stdout;
  if (!/^go version go1\.26\.4 /.test(toolVersion)) throw new Error('请先安装 Go 1.26.4；构建不会自动升级或下载工具链');
  const origin = new URL(explicit || persisted.PUBLIC_ORIGIN || 'http://localhost:36080');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('构建地址必须是 HTTPS 根地址；仅回环测试允许 HTTP');
  const revision = (await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root })).stdout.trim();
  const build = '0.7.2+' + revision;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('构建目录无效');
  const lock = await open(join(directory, '.build.lock'), 'wx', 0o600);
  const generation = randomBytes(16).toString('hex'), release = join(directory, 'releases', generation);
  const temporary = join(release, 'helper.tmp'), archive = join(release, 'package.tmp'), files = [];
  let created = false, published = false;
  try {
    const previous = await prepareReleaseDirectory(directory);
    await mkdir(release, { mode: 0o700 }); created = true;
    for (const [arch, name] of Object.entries(FORWARD_FILES)) {
      const [platform, cpu] = arch.split('-');
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await run('go', ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', '-ldflags', '-s -w -X main.defaultServer=' + origin.origin + ' -X main.version=' + build, '-o', temporary, '.'], {
        cwd: join(root, 'client', 'forward'), timeout: 180000, maxBuffer: 16384,
        env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOOS: platform, GOARCH: cpu },
      });
      let bytes = await artifactRead(temporary, ARTIFACT_LIMITS.file), artifact = temporary;
      if (bytes.length < 64 || bytes.length > 32 * 1024 * 1024) throw new Error('助手产物无效或超过 32 MiB');
      if (platform === 'windows') {
        if (bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Windows 助手格式无效');
        const pe = bytes.readUInt32LE(60);
        if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== (cpu === 'amd64' ? 0x8664 : 0xaa64)) throw new Error('Windows 助手 PE 架构校验失败');
      } else if (platform === 'darwin') {
        await unlink(archive).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await run('python3', [join(root, 'scripts', 'forward_package.py'), arch, temporary, archive], { timeout: 30000, maxBuffer: 16384 });
        bytes = await artifactRead(archive, ARTIFACT_LIMITS.file); artifact = archive;
      } else throw new Error('不支持的助手平台');
      files.push({ arch, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), build });
      await rename(artifact, join(release, name));
    }
    await publish(join(release, 'manifest.json'), JSON.stringify({ version: 2, generation, files }) + '\n');
    if (await currentGeneration(directory) !== previous) throw Error('助手发布入口已被其他操作修改，未覆盖');
    await publish(join(directory, 'current.json'), JSON.stringify({ version: 1, generation }) + '\n');
    published = true;
    for (const file of files) console.log(file.name + ' · ' + file.size + ' bytes · SHA256 ' + file.sha256);
    return { generation, files };
  } finally {
    try {
      await unlink(temporary).catch(() => {}); await unlink(archive).catch(() => {});
      // A directory fsync may fail after the pointer's rename committed. Keep
      // the candidate unless it is confirmed absent from the publication.
      if (created && !published) {
        let safe = false; try { safe = await currentGeneration(directory) !== generation; } catch {}
        if (safe) await removeRelease(directory, generation);
      }
    } finally { await lock.close(); await unlink(join(directory, '.build.lock')); }
  }
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { await buildForward({ origin: process.argv[2] }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
