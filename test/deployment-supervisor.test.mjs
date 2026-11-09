import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDeploymentLease } from '../scripts/deployment-lease.mjs';

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
    "const child=cp.spawn('python3',['-c','import time;time.sleep(60)']);",
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
