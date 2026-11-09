import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lstatSync } from 'node:fs';
import { basename } from 'node:path';

const active = new Set(), helper = fileURLToPath(new URL('./file_lock.py', import.meta.url));
const failure = busy => Object.assign(Error(busy ? '已有配置写入，请稍后再试' : '无法取得本机文件锁，请检查 Python 3 和私有目录'), { status: busy ? 409 : 503, outcome: 'rejected' });
// Eight leases per Node process, no waiter queue. One <=256-byte persistent
// lock inode per fixed path; never unlink it while another process can use it.
export async function acquireFileLock(path, { legacy = false, commands = false, interactive = false } = {}) {
  if (commands && interactive) throw failure(false);
  if (active.has(path) || active.size >= 8) throw failure(true);
  active.add(path);
  let child;
  const stdio = interactive ? ['pipe', 'pipe', 'pipe', 0, 1, 2] : ['pipe', 'pipe', 'pipe'];
  try { child = spawn('python3', ['-I', helper, path, ...(legacy ? ['legacy'] : []), ...(commands ? ['commands'] : []), ...(interactive ? ['interactive'] : [])], { stdio }); }
  catch { active.delete(path); throw failure(false); }
  let ended = false, identity, releasing, pending, sequence = 0, output = '', bytes = 0;
  child.stdin.on('error', () => {});
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const deadline = setTimeout(() => { child.kill('SIGKILL'); readyReject(failure(false)); }, 2000);
  const failed = () => {
    // Once it can own installers, EOF requests cleanup. Killing the supervisor
    // itself would release its lease before those installers have exited.
    if (interactive && identity) child.stdin.end(); else child.kill('SIGKILL');
    readyReject(failure(false)); pending?.reject(failure(false)); pending = undefined;
  };
  child.once('error', failed);
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) failed(); });
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > (identity ? 131072 : 1024)) return failed();
    let at;
    while ((at = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, at); output = output.slice(at + 1);
      try {
        const value = JSON.parse(line);
        if (!identity) {
          if (value.ready !== true || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) throw Error();
          identity = { dev: BigInt(value.dev), ino: BigInt(value.ino) }; clearTimeout(deadline); readyResolve();
        } else if (pending?.kind === 'terminal') {
          if (value.id !== pending.id || Object.keys(value).sort().join(',') !== 'code,id' || !Number.isInteger(value.code) || value.code < 0 || value.code > 255) throw Error();
          const entry = pending; pending = undefined; entry.resolve({ status: value.code });
        } else {
          if (!pending || value.id !== pending.id || !Number.isInteger(value.code) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string') throw Error();
          const entry = pending; pending = undefined;
          if (value.code === 0) entry.resolve({ stdout: value.stdout, stderr: value.stderr });
          else entry.reject(Object.assign(Error(`构建工具执行失败（退出码 ${value.code}），旧版下载保留`), { exitCode: value.code }));
        }
      } catch { failed(); }
    }
  });
  const closed = new Promise(resolve => child.once('close', code => {
    ended = true; clearTimeout(deadline); active.delete(path); readyReject(failure(code === 73));
    pending?.reject(failure(false)); pending = undefined; resolve();
  }));
  const release = () => releasing ||= (async () => {
    child.stdin.end();
    const timer = interactive ? undefined : setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    await closed; clearTimeout(timer);
  })();
  const check = () => {
    if (ended || releasing || child.exitCode !== null || child.signalCode !== null) throw failure(false);
    const info = lstatSync(path, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.dev !== identity.dev || info.ino !== identity.ino) throw failure(false);
  };
  try {
    await ready;
    return { check, release, run(command, args, options = {}) {
      check();
      if (!commands || pending || sequence >= 32 || !['go', 'git', 'python3'].includes(command)) return Promise.reject(failure(false));
      const id = ++sequence, request = JSON.stringify({ id, command, args, cwd: options.cwd || process.cwd(), env: options.env || process.env, timeout: options.timeout || 15000 }) + '\n';
      if (Buffer.byteLength(request) > 131072) return Promise.reject(failure(false));
      return new Promise((resolve, reject) => { pending = { kind: 'build', id, resolve, reject }; child.stdin.write(request, error => { if (error) failed(); }); });
    }, runTerminal(command, args, options = {}) {
      check();
      const name = basename(command);
      const allowed = ['sudo', 'npm', 'systemctl', 'apt-get', 'loginctl'].includes(name) || /^node(?:js)?(?:\d+(?:\.\d+)*)?$/.test(name);
      if (!interactive || pending || sequence >= 32 || !allowed || !Array.isArray(args) || args.length > 64 ||
          args.some(value => typeof value !== 'string' || value.length > 8192 || value.includes('\0')) ||
          typeof options.cwd !== 'string' || options.cwd.includes('\0') ||
          !Number.isInteger(options.timeout ?? 1800000) || (options.timeout ?? 1800000) < 1 || (options.timeout ?? 1800000) > 1800000) return Promise.reject(failure(false));
      const id = ++sequence;
      const request = JSON.stringify({ id, command, args, cwd: options.cwd, timeout: options.timeout ?? 1800000 }) + '\n';
      if (Buffer.byteLength(request) > 131072) return Promise.reject(failure(false));
      return new Promise((resolve, reject) => { pending = { kind: 'terminal', id, resolve, reject }; child.stdin.write(request, error => { if (error) failed(); }); });
    } };
  } catch (error) { await release(); throw error; }
}
