import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireFileLock } from '../native/file-lock.mjs';

// One persistent <=256-byte lock, no queue. Shared by complete deployments
// and standalone publication commands; never remove its inode on release.
export async function acquireDeploymentLease(root) {
  const path = join(root, 'data'); await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('部署状态目录无效');
  try { return await acquireFileLock(join(path, 'deploy.lock'), { interactive: true }); }
  catch (error) { if (error.status === 409) error.message = '已有部署或公网发布正在执行，请稍后重试'; throw error; }
}
