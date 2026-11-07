import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
const exec = promisify(execFile), script = fileURLToPath(new URL('../scripts/cf-latency.sh', import.meta.url));
const csv = 'IP,Sent,Received,Failure,Delay,Speed,Colo\n104.16.0.1,6,6,0,100.00,999,HKG\n104.16.0.2,6,3,0.5,9.50,0,N/A\n104.16.0.3,6,6,0,20.00,1,N/A\n104.16.0.4,6,6,0,0.00,0,N/A\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cf-latency-')), tools = join(root, 'bin'), output = join(root, 'results');
  await mkdir(tools); await mkdir(output, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input.txt'), source = join(root, 'source.csv'), bin = join(tools, 'cfst'), args = join(root, 'args');
  await writeFile(input, '104.16.0.1\n104.16.0.2\n104.16.0.3\n104.16.0.4\n'); await writeFile(source, csv);
  await writeFile(bin, `#!/bin/sh
if [ "$1" = -h ]; then printf 'CloudflareSpeedTest v2.3.5\\n'; exit; fi
printf '%s\\n' "$@" > "$TEST_ARGS"
if [ "$TEST_FAIL" = 1 ]; then exit 23; fi
while [ "$#" -gt 0 ]; do
 case "$1" in -o) dest=$2; shift;; -f) cp "$2" "$TEST_CANDIDATES"; shift;; esac
 shift
done
cp "$TEST_CSV" "$dest"
`, { mode: 0o700 });
  const env = { ...process.env, PATH: tools + ':' + process.env.PATH, CFST_BIN: bin, TEST_ARGS: args, TEST_CSV: source, TEST_CANDIDATES: join(root, 'candidates') };
  const run = async (options = [], overrides = {}) => {
    try { const result = await exec('/bin/sh', [script, ...options, '-f', input, '-o', output], { env: { ...env, ...overrides }, timeout: 10000 }); return { ...result, code: 0 }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  return { root, tools, output, input, source, args, bin, env, run };
}

test('router probe disables downloads and ranks purely on numeric latency, retaining zero and partial successes', async t => {
  const f = await fixture(t), result = await f.run(); assert.equal(result.code, 0, result.stderr);
  const rows = (await readFile(join(f.output, 'ipv4.csv'), 'utf8')).trim().split('\n');
  assert.equal(rows[0], 'rank,ip,avg_ms,success,attempts,failed_pct');
  assert.deepEqual(rows.slice(1), ['1,104.16.0.4,0.00,6,6,0.00','2,104.16.0.2,9.50,3,6,50.00','3,104.16.0.3,20.00,6,6,0.00','4,104.16.0.1,100.00,6,6,0.00']);
  assert.equal(await readFile(join(f.output, 'ipv4.txt'), 'utf8'), '104.16.0.4\n104.16.0.2\n104.16.0.3\n104.16.0.1\n');
  const args = (await readFile(f.args, 'utf8')).trim().split('\n');
  for (const [flag, value] of [['-tp','443'],['-n','8'],['-t','6'],['-p','0'],['-tlr','1']]) assert.equal(args[args.indexOf(flag)+1], value);
  assert.ok(args.includes('-dd')); assert.ok(!args.includes('-httping'));
  assert.deepEqual(await readdir(f.output), ['ipv4-candidates.txt','ipv4.csv','ipv4.txt']);
});

test('IPv6 input is bounded, de-duplicated and selected independently of IPv4', async t => {
  const f = await fixture(t);
  await writeFile(f.input, '# addresses\n104.16.0.1\n2606:4700::1\n2606:4700::1\n2606:4700::2\n');
  await writeFile(f.source, 'IP,Sent,Received,Failure,Delay,Speed,Colo\n2606:4700::1,6,6,0,22.50,0,N/A\n2606:4700::2,6,6,0,2.50,0,N/A\n');
  const result = await f.run(['6']); assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(f.env.TEST_CANDIDATES,'utf8'), '2606:4700::1\n2606:4700::2\n');
  assert.equal(await readFile(join(f.output,'ipv6.txt'),'utf8'),'2606:4700::2\n2606:4700::1\n');
});

test('probe failure, corrupt CSV and all-failed runs retain the last successful result and release the lock', async t => {
  const f = await fixture(t); assert.equal((await f.run()).code,0);
  const before = await readFile(join(f.output,'ipv4.csv'),'utf8');
  assert.notEqual((await f.run([], { TEST_FAIL:'1' })).code,0);
  for (const data of ['', 'IP,Sent,Received,Failure,Delay\n104.16.0.1,0,0,1,0\n', 'IP,Sent,Received,Failure,Delay\n104.16.0.1,6,7,0,9\n', 'IP,Sent,Received,Failure,Delay\n104.16.0.1,6,0,1,0\n']) {
    await writeFile(f.source,data); assert.notEqual((await f.run()).code,0);
    assert.equal(await readFile(join(f.output,'ipv4.csv'),'utf8'),before);
    assert.deepEqual((await readdir(f.output)).filter(name=>name.startsWith('.')),[]);
  }
});

test('oversized inputs, CIDR expansion, invalid limits and concurrent jobs are rejected before probing', async t => {
  const f = await fixture(t);
  for (const options of [['-n','65'],['-n','0'],['-n','1;false'],['-c','4097'],['-t','21']]) assert.notEqual((await f.run(options)).code,0);
  for (const data of ['2606:4700::/32\n', '104.16.0.1\n'.repeat(4097), '104.16.0.1\n'.repeat(15000)]) {
    await writeFile(f.input,data); assert.notEqual((await f.run()).code,0);
  }
  await writeFile(f.input,'104.16.0.1\n'); await mkdir(join(f.output,'.lock'));
  assert.match((await f.run()).stderr,/已有任务/);
  assert.ok((await readdir(f.output)).includes('.lock'));
  await assert.rejects(readFile(f.args),{code:'ENOENT'});
});

test('fixed release download selects the router architecture and rejects corrupt packages before execution', async t => {
  const f = await fixture(t), urlFile = join(f.root,'download-url');
  await writeFile(join(f.tools,'uname'),'#!/bin/sh\nprintf "%s\\n" "$TEST_MACHINE"\n',{mode:0o700});
  await writeFile(join(f.tools,'od'),'#!/bin/sh\nprintf "%s\\n" "$TEST_ELF"\n',{mode:0o700});
  await writeFile(join(f.tools,'curl'),`#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in --output) dest=$2; shift;; https:*) printf '%s\\n' "$1" > "$TEST_URL";; esac; shift; done
printf corrupt > "$dest"
`,{mode:0o700});
  for (const [machine,elf,arch] of [['x86_64','','amd64'],['aarch64','','arm64'],['armv7l','','armv7'],['mips','1 2','mips'],['mips64','1 1','mipsle'],['mips64','2 2','mips64'],['mips64','2 1','mips64le']]) {
    const result=await f.run([], {CFST_BIN:'', TEST_MACHINE:machine, TEST_ELF:elf, TEST_URL:urlFile});
    assert.notEqual(result.code,0); assert.match(result.stderr,/SHA256/);
    assert.equal((await readFile(urlFile,'utf8')).trim(),`https://github.com/XIU2/CloudflareSpeedTest/releases/download/v2.3.5/cfst_linux_${arch}.tar.gz`);
  }
  await assert.rejects(readFile(f.args),{code:'ENOENT'});
});

test('old BusyBox timeout syntax receives a fixed deadline and the same delay-only probe arguments', async t => {
  const f=await fixture(t), timeoutArgs=join(f.root,'timeout-args');
  await writeFile(join(f.tools,'timeout'),`#!/bin/sh
if [ "$1" = --help ]; then printf 'timeout [-t SECS] PROG ARGS\\n'; exit 1; fi
printf '%s\\n' "$@" > "$TEST_TIMEOUT_ARGS"
[ "$1" = -s ] && shift 2
[ "$1" = -t ] && shift
[ "$1" = 900 ] || exit 41
shift
exec "$@"
`,{mode:0o700});
  const result=await f.run([], {TEST_TIMEOUT_ARGS:timeoutArgs}); assert.equal(result.code,0,result.stderr);
  assert.deepEqual((await readFile(timeoutArgs,'utf8')).split('\n').slice(0,4),['-s','KILL','-t','900']);
});

test('automatic sampling bounds both families and restores execution permission on extracted packages', async t => {
  const f=await fixture(t);
  // Synthetic archive I/O only. The separate corrupt-package test uses the
  // real SHA256 implementation; this fixture exercises extraction and sampling.
  await writeFile(join(f.tools,'uname'),'#!/bin/sh\nprintf x86_64\n',{mode:0o700});
  await writeFile(join(f.tools,'curl'),'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf fixture > "$1"; fi; shift; done\n',{mode:0o700});
  await writeFile(join(f.tools,'sha256sum'),'#!/bin/sh\nprintf "c4c8fc76b4e1bf2bdb5ced8b765956d82dda7bc4eb59df5c04053f0f7db98d90  fixture\\n"\n',{mode:0o700});
  await writeFile(join(f.tools,'tar'),`#!/bin/sh
while [ "$#" -gt 0 ]; do if [ "$1" = -C ]; then shift; directory=$1; fi; shift; done
directory="$directory/cfst_linux_amd64"
mkdir -p "$directory"
cp "$TEST_INSTALLED_BIN" "$directory/cfst"
chmod 600 "$directory/cfst"
printf '104.16.0.0/13\\n' > "$directory/ip.txt"
printf '2606:4700::/32\\n2606:4700:3030::/48\\n' > "$directory/ipv6.txt"
`,{mode:0o700});
  try { await exec('/bin/busybox',['awk','BEGIN{print 1}']); await writeFile(join(f.tools,'awk'),'#!/bin/sh\nexec /bin/busybox awk "$@"\n',{mode:0o700}); } catch {}
  for(const family of [4,6]) {
    await exec('/bin/sh',[script,String(family),'-c','4096','-o',f.output],{env:{...f.env,CFST_BIN:'',TEST_INSTALLED_BIN:f.bin},timeout:10000});
    const candidates=(await readFile(join(f.output,`ipv${family}-candidates.txt`),'utf8')).trim().split('\n');
    assert.ok(candidates.length>3000&&candidates.length<=4096);
    assert.ok(candidates.every(ip=>isIP(ip)===family));
    assert.deepEqual((await readdir(f.output)).filter(name=>name.startsWith('.')),[]);
  }
});
