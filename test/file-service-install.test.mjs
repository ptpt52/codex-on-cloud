import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

async function installer(t, { port = '36902', migration = false, flock = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-files-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), service = join(root, '.config/systemd/user');
  for (const path of [bin, service, join(root, 'secrets')]) await mkdir(path, { recursive: true });
  for (const path of ['native', 'scripts', 'panel']) await cp(resolve(path), join(root, path), { recursive: true, filter: name => !name.includes('__pycache__') });
  await writeFile(join(root, 'secrets/panel_password'), 'synthetic-test-password');
  for (const name of ['tmux', 'python3', ...(flock ? ['flock'] : [])]) await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\nif [ "$2" = is-active ]; then [ "$4" = codex-cloud-terminal.service ]; else exit 0; fi\n', { mode: 0o700 });
  const preserved = '# Managed migration for codex-on-cloud file helper\n[Service]\nExecStart=/preserved/migration\n';
  if (migration) await writeFile(join(service, 'codex-cloud-files.service'), preserved);
  const run = () => promisify(execFile)(process.execPath, [join(root, 'scripts/native.mjs'), 'install'], {
    env: { ...process.env, HOME: root, PATH: bin, DEPLOY_MODE: 'terminal', AGENT_PORT: '36902', FILE_AGENT_PORT: port, RUNTIME_DIR: join(root, 'run'), WORKSPACE_DIR: join(root, 'workspaces'), TUNNEL_DNS_SERVERS: '' },
    timeout: 10000, maxBuffer: 8192,
  });
  return { root, service, preserved, run };
}

test('installer refuses a legacy host port collision before creating any service or stopping a task', async t => {
  const h = await installer(t);
  await assert.rejects(h.run(), /FILE_AGENT_PORT/);
  await assert.rejects(readFile(join(h.service, 'codex-cloud-terminal.service')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(h.root, 'calls'), 'utf8'), /stop|restart|enable/);
});

test('installer supports a separate port and preserves an existing migration service without enabling it', async t => {
  const h = await installer(t, { port: '36904', migration: true });
  await h.run();
  assert.equal(await readFile(join(h.service, 'codex-cloud-files.service'), 'utf8'), h.preserved);
  const calls = await readFile(join(h.root, 'calls'), 'utf8');
  assert.doesNotMatch(calls, /stop|restart/);
  assert.doesNotMatch(calls.split('\n').find(line => line.includes(' enable ')), /codex-cloud-files/);
  assert.match(await readFile(join(h.service, 'codex-cloud-panel.service'), 'utf8'), /Wants=codex-cloud-files.service/);
});

test('missing terminal kernel-lock support is diagnosed before service configuration changes',async t=>{
 const h=await installer(t,{port:'36904',flock:false});await assert.rejects(h.run(),error=>error.code===1&&/util-linux/.test(error.stdout));
 await assert.rejects(readFile(join(h.service,'codex-cloud-terminal.service')),{code:'ENOENT'});
 assert.doesNotMatch(await readFile(join(h.root,'calls'),'utf8'),/stop|restart|enable/);
});
