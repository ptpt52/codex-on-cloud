import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile), version = '24.22.2';
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const runtime = value => '#!/bin/sh\nif [ "$1" = --version ]; then printf "%s\\n" "v' + value + '"; else printf "%s\\n" "$@" >> "$BOOT_NODE_LOG"; fi\n';
async function setup(t, { binaryVersion = version } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'codex bootstrap ')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'center'), bin = join(base, 'bin'), source = join(base, 'source'), archive = join(base, 'archive.tar.gz');
  await mkdir(join(source, 'node-v' + version + '-linux-x64/bin'), { recursive: true }); await mkdir(bin);
  await writeFile(join(source, 'node-v' + version + '-linux-x64/bin/node'), runtime(binaryVersion), { mode: 0o755 });
  await exec('tar', ['-czf', archive, '-C', source, 'node-v' + version + '-linux-x64']);
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  const script = join(base, 'selfhost-server.sh'), text = (await readFile(resolve('scripts/selfhost-server.sh'), 'utf8'))
    .replaceAll('/opt/codex-selfhost', root).replace(/NODE_SHA256=[a-f0-9]{64}/g, 'NODE_SHA256=' + checksum);
  await writeFile(script, text, { mode: 0o700 });
  await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
  await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "x86_64\\n"\n', { mode: 0o755 });
  await writeFile(join(bin, 'curl'), `#!/usr/bin/env python3
import os,sys,json,shutil,resource,time
with open(os.environ['BOOT_CURL_LOG'],'a') as log: log.write(json.dumps({'args':sys.argv[1:],'limit':resource.getrlimit(resource.RLIMIT_FSIZE)[0]})+'\\n')
gate=os.environ.get('BOOT_HOLD')
if gate:
 open(gate+'.entered','w').close()
 deadline=time.monotonic()+10
 while not os.path.exists(gate+'.release'):
  if time.monotonic()>deadline: raise RuntimeError('test gate deadline')
  time.sleep(.01)
target=sys.argv[sys.argv.index('-o')+1]
if os.environ.get('BOOT_CORRUPT'): open(target,'wb').write(b'not the pinned archive')
else: shutil.copyfile(os.environ['BOOT_ARCHIVE'],target)
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, BOOT_ARCHIVE: archive, BOOT_CURL_LOG: join(base, 'curl.log'), BOOT_NODE_LOG: join(base, 'node.log') };
  const run = (command, extra = {}) => exec('/bin/sh', [script, command], { env: { ...env, ...extra }, timeout: 15000, maxBuffer: 16384 });
  return { base, root, env, run };
}

test('bootstrap publishes only a checked runtime and bounds downloads even on older curl', async t => {
  const h = await setup(t); await h.run('install');
  const cache = join(h.root, 'bootstrap/node/bin/node'), before = await stat(cache);
  const calls = (await readFile(h.env.BOOT_CURL_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(calls[0].limit, 128 * 1024 * 1024);
  for (const flag of ['--connect-timeout', '--max-time', '--max-filesize', '--retry']) assert(calls[0].args.includes(flag));
  assert(!(await exists(join(h.root, 'bootstrap/node.prepare'))));
  await h.run('status'); assert.equal((await stat(cache)).ino, before.ino);
  assert.equal((await readFile(h.env.BOOT_CURL_LOG, 'utf8')).trim().split('\n').length, 1);
  assert((await readFile(h.env.BOOT_NODE_LOG, 'utf8')).includes('status'));
});

for (const failure of ['checksum', 'version']) test(`bootstrap ${failure} failure never publishes a partial runtime`, async t => {
  const h = await setup(t, { binaryVersion: failure === 'version' ? '0.0.0' : version });
  await assert.rejects(h.run('install', failure === 'checksum' ? { BOOT_CORRUPT: '1' } : {}), error => failure === 'checksum' ? /FAILED/.test(error.stdout) : /暂存运行时校验失败/.test(error.stderr));
  assert(!(await exists(join(h.root, 'bootstrap/node/bin/node'))));
  assert(!(await exists(join(h.root, 'bootstrap/node.prepare'))));
});

test('concurrent bootstraps refuse a second download while the first owns the kernel lock', async t => {
  const h = await setup(t), gate = join(h.base, 'gate'), first = h.run('install', { BOOT_HOLD: gate });
  try {
    const deadline = Date.now() + 5000;
    while (!(await exists(gate + '.entered'))) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    await assert.rejects(h.run('install'), error => /正在执行/.test(error.stderr));
  } finally { await writeFile(gate + '.release', ''); await first; }
  assert.equal((await readFile(h.env.BOOT_CURL_LOG, 'utf8')).trim().split('\n').length, 1);
});

test('maintenance never downloads a missing runtime and can reuse the installed pinned executable', async t => {
  const h = await setup(t);
  for (const command of ['status', 'rollback', 'recover']) await assert.rejects(h.run(command), error => /不会下载/.test(error.stderr));
  assert(!(await exists(h.env.BOOT_CURL_LOG)));
  await mkdir(join(h.root, 'bin')); await writeFile(join(h.root, 'bin/node'), runtime(version), { mode: 0o755 });
  await h.run('recover'); assert(!(await exists(h.env.BOOT_CURL_LOG)));
  assert((await readFile(h.env.BOOT_NODE_LOG, 'utf8')).includes('recover'));
});

test('an existing mismatched runtime is preserved instead of silently upgraded', async t => {
  const h = await setup(t), directory = join(h.root, 'bootstrap/node/bin'); await mkdir(directory, { recursive: true });
  const node = join(directory, 'node'), original = runtime('0.0.0'); await writeFile(node, original, { mode: 0o755 });
  await assert.rejects(h.run('install'), error => /未自动替换/.test(error.stderr));
  assert.equal(await readFile(node, 'utf8'), original); assert(!(await exists(h.env.BOOT_CURL_LOG)));
});
