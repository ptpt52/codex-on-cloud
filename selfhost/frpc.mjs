import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const FRP_VERSION = '0.72.0';
const ARCHIVES = {
  amd64: { archive: 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804', binary: '522352244a4872beaa0ad6fa136c8cc8d2e993e72bcf49f9c8a1d9683770d80e' },
  arm64: { archive: '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf', binary: 'b92f35651f25c45a414542d72150474688b6320af03192febcb418e0b4cf2644' },
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function regular(path, mode) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > 64 * 1024 * 1024 || mode !== undefined && (info.mode & 0o777) !== mode) throw Error('本地 frpc 文件权限或类型无效');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function installFrpc({ root, arch = process.arch, platform = process.platform, request = fetch } = {}) {
  if (platform !== 'linux') throw Error('自建节点当前只支持 Ubuntu/Linux');
  const frpArch = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!frpArch) throw Error('不支持当前 CPU 架构；需要 x86_64 或 arm64');
  const pinned = ARCHIVES[frpArch], directory = join(root, 'data', 'selfhost-node', 'bin'), binary = join(directory, 'frpc');
  if (await regular(binary, 0o700)) {
    if (sha256(await readFile(binary)) !== pinned.binary) throw Error('本地 frpc 与固定版本校验不一致，拒绝覆盖或执行');
    return binary;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const response = await request(`https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${frpArch}.tar.gz`, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('frpc 下载失败（HTTP ' + response.status + '）');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 64 * 1024 * 1024) throw Error('frpc 下载超过 64 MiB');
  if (sha256(bytes) !== pinned.archive) throw Error('frpc 下载校验失败，未安装');
  const archive = join(directory, `.frp-${FRP_VERSION}-${process.pid}.tar.gz`), unpack = join(directory, `.unpack-${process.pid}`), next = join(directory, `.frpc-${process.pid}`);
  let handle;
  try {
    handle = await open(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await mkdir(unpack, { recursive: false, mode: 0o700 });
    await exec('tar', ['-xzf', archive, '-C', unpack, '--strip-components=1', `frp_${FRP_VERSION}_linux_${frpArch}/frpc`, `frp_${FRP_VERSION}_linux_${frpArch}/LICENSE`], { timeout: 30000, maxBuffer: 64 * 1024 });
    const extracted = join(unpack, 'frpc');
    if (sha256(await readFile(extracted)) !== pinned.binary) throw Error('解包后的 frpc 校验失败，未安装');
    await rename(extracted, next); await chmod(next, 0o700);
    if (await regular(binary)) throw Error('安装期间出现其他 frpc 文件，未覆盖');
    await rename(next, binary);
    await writeFile(join(directory, 'VERSION'), `${FRP_VERSION} linux_${frpArch} ${pinned.binary}\n`, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return binary;
  } finally {
    await handle?.close(); await unlink(archive).catch(() => {}); await unlink(next).catch(() => {});
    await rm(unpack, { recursive: true, force: true }).catch(() => {});
  }
}
