import net from 'node:net';
import { dirname } from 'node:path';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';

// A private HTTP ingress has a filesystem trust boundary. TCP forwarding
// headers never confer that trust, even when the peer is loopback.
export async function listenPrivateHTTP(server, path) {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 100) throw Error('私有 HTTP socket 路径无效');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw Error('私有 HTTP 接口必须位于当前用户的私有目录');
  const previous = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid()) throw Error('私有 HTTP socket 路径被占用');
    await new Promise((resolve, reject) => {
      const probe = net.createConnection(path), timer = setTimeout(() => probe.destroy(Error('无法确认旧 HTTP 接口状态')), 1000);
      probe.once('connect', () => { probe.destroy(); reject(Error('已有私有 HTTP 接口在运行')); });
      probe.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      probe.once('close', () => clearTimeout(timer));
    });
    const current = await lstat(path);
    if (current.ino !== previous.ino || current.dev !== previous.dev) throw Error('私有 HTTP socket 已变化');
    await unlink(path);
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const info = await lstat(path);
  const clean = async () => {
    const current = await lstat(path).catch(() => null);
    if (current?.ino === info.ino && current.dev === info.dev) await unlink(path).catch(() => {});
  };
  try { await chmod(path, 0o600); }
  catch (error) { await new Promise(resolve => server.close(resolve)); await clean(); throw error; }
  return async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await clean(); };
}
