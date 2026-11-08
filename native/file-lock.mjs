import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lstatSync } from 'node:fs';

const active = new Set(), helper = fileURLToPath(new URL('./file_lock.py', import.meta.url));
const failure = busy => Object.assign(Error(busy ? '已有配置写入，请稍后再试' : '无法取得本机文件锁，请检查 Python 3 和私有目录'), { status: busy ? 409 : 503, outcome: 'rejected' });
// Eight leases per Node process, no waiter queue. One <=256-byte persistent
// lock inode per fixed path; never unlink it while another process can use it.
export async function acquireFileLock(path, { legacy = false } = {}) {
  if (active.has(path) || active.size >= 8) throw failure(true);
  active.add(path);
  const child = spawn('python3', ['-I', helper, path, ...(legacy ? ['legacy'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ended = false, identity;
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', code => { ended = true; active.delete(path); resolve(code); }));
  const release = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    await closed; clearTimeout(timer);
  };
  try {
    await new Promise((resolve, reject) => {
      let bytes = 0, output = '';
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(failure(false)); }, 2000);
      const finish = (error) => { clearTimeout(deadline); error ? reject(error) : resolve(); };
      child.once('error', () => finish(failure(false)));
      child.once('close', code => finish(failure(code === 73)));
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) { child.kill('SIGKILL'); finish(failure(false)); } });
      child.stdout.on('data', chunk => {
        bytes += chunk.length; output += chunk.toString();
        if (bytes > 1024) { child.kill('SIGKILL'); finish(failure(false)); }
        else if (output.endsWith('\n')) {
          try {
            const value = JSON.parse(output);
            if (value.ready !== true || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) throw Error();
            identity = { dev: BigInt(value.dev), ino: BigInt(value.ino) }; finish();
          } catch { child.kill('SIGKILL'); finish(failure(false)); }
        }
      });
    });
    return { check() {
      if (ended || child.exitCode !== null || child.signalCode !== null) throw failure(false);
      const info = lstatSync(path, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.dev !== identity.dev || info.ino !== identity.ino) throw failure(false);
    }, release };
  } catch (error) { await release(); throw error; }
}
