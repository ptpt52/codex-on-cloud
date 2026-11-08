import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireFileLock } from '../native/file-lock.mjs';

async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'build-lease-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function eventually(probe) { for (let n = 0; n < 200; n++) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('isolated command cleanup deadline'); }

test('managed commands have deadlines and output bounds and never queue competing writers', async t => {
  const dir = await directory(t), path = join(dir, '.build.lock'), lease = await acquireFileLock(path, { commands: true }); t.after(() => lease.release());
  await assert.rejects(acquireFileLock(path), { status: 409 });
  assert.equal((await lease.run('python3', ['-c', 'print("bounded command")'], { timeout: 1000 })).stdout.trim(), 'bounded command');
  await assert.rejects(lease.run('python3', ['-c', 'import time;time.sleep(30)'], { timeout: 50 }), { exitCode: 124 });
  await assert.rejects(lease.run('python3', ['-c', 'print("x" * 20000)']), { exitCode: 125 });
  lease.check(); assert.equal((await lease.run('python3', ['-c', 'print("after rejection")'])).stdout.trim(), 'after rejection');
});

test('SIGKILL of the build parent kills and reaps the compiler group before another builder acquires the lease', async t => {
  const dir = await directory(t), path = join(dir, '.build.lock'), record = join(dir, 'owned-processes.json');
  await writeFile(path, '');
  const code = `import os,subprocess,time,json;child=subprocess.Popen(['python3','-c','import time;time.sleep(60)']);open(${JSON.stringify(record)},'w').write(json.dumps([os.getpid(),child.pid]));time.sleep(60)`;
  const source = `import {acquireFileLock} from ${JSON.stringify(new URL('../native/file-lock.mjs', import.meta.url).href)};const lease=await acquireFileLock(process.argv[1],{legacy:true,commands:true});await lease.run('python3',['-c',process.argv[2]],{timeout:180000});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source, path, code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => parent.kill('SIGKILL'));
  let pids;
  await eventually(async () => { try { pids = JSON.parse(await readFile(record, 'utf8')); return pids.length === 2; } catch { return false; } });
  await assert.rejects(acquireFileLock(path), { status: 409 });
  const closed = once(parent, 'close'); parent.kill('SIGKILL'); await closed;
  let next;
  await eventually(async () => { try { next = await acquireFileLock(path, { commands: true }); return true; } catch (error) { if (error.status !== 409) throw error; return false; } });
  try {
    for (const pid of pids) await assert.rejects(readFile('/proc/' + pid + '/stat'), { code: 'ENOENT' });
    assert.equal((await next.run('python3', ['-c', 'print("recovered")'])).stdout.trim(), 'recovered');
  } finally { await next.release(); }
});
