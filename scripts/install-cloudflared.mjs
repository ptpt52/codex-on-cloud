import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, chmod, rename, unlink, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from '../native/config.mjs';

const version = '2026.10.0';
const assets = {
  x64: ['amd64', 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'],
  arm64: ['arm64', 'e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08'],
};
if (process.platform !== 'linux' || !assets[process.arch]) throw new Error('只支持 Linux x86_64 / ARM64');
if (process.getuid() === 0) throw new Error('请用普通用户运行，不需要 sudo');
const [arch, digest] = assets[process.arch];
const directory = join(root, 'data', 'host-tools', 'usr', 'bin');
const destination = join(directory, 'cloudflared');
await mkdir(directory, { recursive: true, mode: 0o700 });
let existing;
try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing && createHash('sha256').update(existing).digest('hex') === digest) console.log(`cloudflared ${version} 已安装并通过校验。`);
else {
  if (existing) throw new Error('已有其他 cloudflared 文件，不会自动覆盖；请先检查 data/host-tools/usr/bin/cloudflared');
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}`, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const hash = createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) return callback(new Error('安装包超过 100 MiB'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(response.body, verify, createWriteStream(temporary, { flags: 'wx', mode: 0o700 }));
    if (hash.digest('hex') !== digest) throw new Error('cloudflared SHA-256 校验失败');
    await chmod(temporary, 0o700);
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  const result = spawnSync(destination, ['--version'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('cloudflared 无法在本机运行');
  console.log('已安装到项目私有目录。Tunnel 尚未启动。');
}
