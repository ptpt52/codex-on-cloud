import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { acquireDeploymentLease } from '../scripts/deployment-lease.mjs';

const exec = promisify(execFile), leaseModule = new URL('../scripts/deployment-lease.mjs', import.meta.url).href;

async function eventually(probe) {
  for (let count = 0; count < 300; count++) {
    try { if (await probe()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('deployment supervisor cleanup deadline');
}

test('deployment SIGKILL reaps the active installer group before releasing its lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-supervisor-'));
  const record = join(root, 'owned.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL('../scripts/deployment-lease.mjs', import.meta.url).href;
  const command = [
    "const fs=require('fs'),cp=require('child_process');",
    "const child=cp.spawn('python3',['-c','import time;time.sleep(60)'],{detached:true,stdio:'ignore'});",
    `fs.writeFileSync(${JSON.stringify(record)},JSON.stringify([process.pid,child.pid]));`,
    'setInterval(()=>{},1000);',
  ].join('');
  const source = `import {acquireDeploymentLease} from ${JSON.stringify(module)};const lease=await acquireDeploymentLease(process.argv[1]);const result=await lease.runTerminal(process.execPath,['-e',process.argv[2]],{cwd:process.argv[1],timeout:180000});process.exitCode=result.status;`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source, root, command], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => parent.kill('SIGKILL'));
  let pids;
  await eventually(async () => {
    try { pids = JSON.parse(await readFile(record, 'utf8')); return pids.length === 2; } catch { return false; }
  });
  await assert.rejects(acquireDeploymentLease(root), { status: 409 });
  const closed = once(parent, 'close'); parent.kill('SIGKILL'); await closed;
  let lease;
  await eventually(async () => {
    try { lease = await acquireDeploymentLease(root); return true; } catch (error) { if (error.status !== 409) throw error; return false; }
  });
  try {
    for (const pid of pids) await assert.rejects(readFile('/proc/' + pid + '/stat'), { code: 'ENOENT' });
    await writeFile(join(root, 'recovered'), 'ok');
    assert.equal(await readFile(join(root, 'recovered'), 'utf8'), 'ok');
  } finally { await lease.release(); }
});

test('deployment commands inherit the caller input, output and error streams without mixing them with lease records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-streams-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = "const fs=require('fs'),bytes=Buffer.alloc(64),size=fs.readSync(0,bytes,0,bytes.length,null),text=bytes.subarray(0,size).toString();fs.writeSync(1,'stdout:'+text);fs.writeSync(2,'stderr:'+text);";
  const source = `import {acquireDeploymentLease} from ${JSON.stringify(leaseModule)};const lease=await acquireDeploymentLease(process.argv[1]);try{const result=await lease.runTerminal(process.execPath,['-e',process.argv[2]],{cwd:process.argv[1],timeout:3000});process.exitCode=result.status;}finally{await lease.release();}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, command], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length <= 8192); });
  child.stderr.on('data', bytes => { stderr += bytes; assert.ok(stderr.length <= 8192); });
  const closed = once(child, 'close'); child.stdin.end('fixture input\n');
  const [code] = await closed;
  assert.equal(code, 0); assert.equal(stdout, 'stdout:fixture input\n'); assert.equal(stderr, 'stderr:fixture input\n');
});

test('a deployment timeout reaps its leader and detached descendants before acknowledging or releasing the lease', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-timeout-')), record = join(root, 'owned.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = await acquireDeploymentLease(root); let pids = [];
  try {
    const command = "const fs=require('fs'),cp=require('child_process');const child=cp.spawn('python3',['-c','import time;time.sleep(60)'],{detached:true,stdio:'ignore'});" +
      `fs.writeFileSync(${JSON.stringify(record)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    const result = await lease.runTerminal(process.execPath, ['-e', command], { cwd: root, timeout: 800 });
    pids = JSON.parse(await readFile(record, 'utf8')); assert.equal(result.status, 124);
    for (const pid of pids) await assert.rejects(readFile('/proc/' + pid + '/stat'), { code: 'ENOENT' });
    pids = [];
  } finally {
    // A regression must not leave its injected installer behind. A final
    // supervised command also lets the old helper reap any killed zombies.
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await lease.runTerminal(process.execPath, ['-e', ''], { cwd: root, timeout: 1000 }).catch(() => {});
    await lease.release();
  }
  const next = await acquireDeploymentLease(root); await next.release();
});

for (const mode of ['answer', 'interrupt', 'timeout']) test(`a real terminal preserves controlling-TTY input and restores foreground ownership after ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-tty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./support/deployment-tty.py', import.meta.url));
  const { stdout, stderr } = await exec('python3', ['-I', helper, mode, root, process.execPath, leaseModule], { timeout: 15000, maxBuffer: 16384 });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.status, mode === 'answer' ? 0 : mode === 'interrupt' ? 130 : 124);
  assert.equal(result.foregroundRestored, true); assert.equal(result.echoRestored, true);
  assert.equal(result.answerReceived, mode === 'answer'); assert.equal(result.answerEchoed, false);
});

test('release keeps the deployment lease through cleanup that takes longer than the old helper kill deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-slow-cleanup-')), native = join(root, 'native');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(native); await mkdir(join(root, 'data'));
  for (const name of ['file-lock.mjs', 'file_lock.py', 'deploy_commands.py']) await copyFile(new URL('../native/' + name, import.meta.url), join(native, name));
  // Fault injection affects only the copied helper. The actual lock, process,
  // release, competing acquisition and child reaping are real kernel behavior.
  await appendFile(join(native, 'deploy_commands.py'), '\n_original_reap = reap\ndef reap(process):\n    if process is not None and process.returncode is None:\n        time.sleep(2.2)\n    return _original_reap(process)\n');
  const { acquireFileLock } = await import(pathToFileURL(join(native, 'file-lock.mjs')));
  const lease = await acquireFileLock(join(root, 'data', 'deploy.lock'), { interactive: true });
  const record = join(root, 'pid'); let pid, pending, releasing;
  try {
    pending = lease.runTerminal(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(record)},String(process.pid));setInterval(()=>{},1000);`], { cwd: root, timeout: 5000 }).catch(error => error);
    await eventually(async () => { pid = Number(await readFile(record, 'utf8')); return pid > 1; });
    releasing = lease.release(); await new Promise(resolve => setTimeout(resolve, 1750));
    await assert.rejects(acquireDeploymentLease(root), { status: 409 });
    await releasing; await pending;
    await assert.rejects(readFile('/proc/' + pid + '/stat'), { code: 'ENOENT' });
    pid = undefined;
    const next = await acquireDeploymentLease(root); await next.release();
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await (releasing || lease.release()); await pending;
  }
});

test('a bounded deployment request may span pipe reads without becoming an extra queued command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-deploy-fragments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = await acquireDeploymentLease(root);
  try {
    const result = await lease.runTerminal(process.execPath, ['-e', 'process.exit(process.argv.length === 9 ? 0 : 1)', ...Array(8).fill('x'.repeat(8000))], { cwd: root, timeout: 2000 });
    assert.equal(result.status, 0);
  } finally { await lease.release(); }
});
