import { open } from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';

let active = false;
const failure = busy => Object.assign(Error(busy ? '已有终端宿主持有配置写入锁，不会接管' : '无法取得终端宿主锁，请检查 util-linux 的 flock 和运行目录'), { status: busy ? 409 : 503 });
// One descriptor per host, owned by Node itself. flock(1) takes the lock on an
// inherited duplicate of that same open-file description, then exits. No Python
// service or long-lived lock helper becomes a dependency of the task lifetime.
export async function acquireTerminalLease(path) {
  if (active) throw failure(true); active = true;
  let file;
  try {
    file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.uid !== BigInt(process.getuid()) || info.nlink !== 1n || info.size > 256n) throw failure(false);
    const code = await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      child.once('error', () => reject(failure(false))); child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    if (code !== 0) throw failure(code === 73);
    let released = false;
    const check = () => {
      if (released) throw failure(false);
      const current = lstatSync(path, { bigint: true });
      if (!current.isFile() || current.nlink !== 1n || current.ino !== info.ino || current.dev !== info.dev) throw failure(false);
    };
    check(); await file.chmod(0o600); await file.truncate(0); check();
    return { check, async release() { if (released) return; released = true; try { await file.close(); } finally { active = false; } } };
  } catch (error) { try { await file?.close(); } finally { active = false; } throw error; }
}
