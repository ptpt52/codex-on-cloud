import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, readdir, open } from 'node:fs/promises';
import { readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configureWSLNetwork, planWSLConfig, updateWSLConfig } from '../scripts/wsl-network.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-wsl 中文 $() '));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const kernel = '6.6.87.2-microsoft-standard-WSL2';

test('WSL edits preserve unrelated settings, comments, newline style and UTF BOMs', () => {
  const original = '# settings\r\n[wsl2]\r\nnetworkingMode=Mirrored\r\nmemory=4GB\r\n\r\n[experimental]\r\n  hostAddressLoopback = false ; retain comment\r\nignoredPorts=53\r\n[user]\r\nother=value\r\n';
  const expected = original.replace('false ; retain comment', 'true ; retain comment');
  for (const [bom, encoding] of [[Buffer.alloc(0), 'utf8'], [Buffer.from([0xef, 0xbb, 0xbf]), 'utf8'], [Buffer.from([0xff, 0xfe]), 'utf16le']]) {
    const before = Buffer.concat([bom, Buffer.from(original, encoding)]);
    const result = planWSLConfig(before);
    assert.equal(result.changed, true);
    assert.deepEqual(result.bytes, Buffer.concat([bom, Buffer.from(expected, encoding)]));
    assert.equal(planWSLConfig(result.bytes).changed, false);
  }
  const already = Buffer.from('[Experimental]\nHOSTADDRESSLOOPBACK = TRUE # retained\n');
  assert.deepEqual(planWSLConfig(already), { changed: false, bytes: already });
});

test('missing sections and keys are inserted into experimental only, and ambiguous or oversized configs are refused', () => {
  const existing = '[wsl2]\nnetworkingMode=mirrored\nhostAddressLoopback=false\n';
  assert.equal(planWSLConfig(Buffer.from(existing)).bytes.toString(), existing + '\n[experimental]\nhostAddressLoopback=true\n');
  assert.equal(planWSLConfig(null).bytes.toString(), '[experimental]\nhostAddressLoopback=true\n');
  assert.equal(planWSLConfig(Buffer.from('[experimental]\nother=1\n[wsl2]\nmemory=4GB')).bytes.toString(), '[experimental]\nother=1\nhostAddressLoopback=true\n[wsl2]\nmemory=4GB\n');
  for (const text of ['[experimental]\n[experimental]\n', '[experimental]\nhostAddressLoopback=false\nhostAddressLoopback=true\n', 'nul\0value', 'x'.repeat(65537)]) assert.throws(() => planWSLConfig(Buffer.from(text)));
  assert.throws(() => planWSLConfig(Buffer.from([0xff, 0xff])));
  assert.throws(() => planWSLConfig(Buffer.from('#' + 'x'.repeat(65530))), /64 KiB/);
});

test('read-only checks never create a config, backup or temporary file', async t => {
  const root = await directory(t), file = join(root, '.wslconfig');
  assert.deepEqual(await updateWSLConfig(file, { check: true }), { changed: false, needsConfiguration: true });
  assert.deepEqual(await readdir(root), []);
  const original = '[wsl2]\nnetworkingMode=mirrored\n'; await writeFile(file, original);
  assert.equal((await updateWSLConfig(file, { check: true })).needsConfiguration, true);
  assert.equal(await readFile(file, 'utf8'), original); assert.deepEqual(await readdir(root), ['.wslconfig']);
});

test('automatic writes save one original backup, retain later user edits and are idempotent', async t => {
  const root = await directory(t), file = join(root, '.wslconfig'), backup = file + '.codex-cloud.before-loopback';
  const original = '[wsl2]\r\nnetworkingMode=Mirrored\r\n# original\r\n'; await writeFile(file, original);
  const result = await updateWSLConfig(file); assert.equal(result.changed, true); assert.equal(result.backup, backup);
  assert.equal(await readFile(backup, 'utf8'), original);
  const updated = await readFile(file); assert.equal((await updateWSLConfig(file)).changed, false); assert.deepEqual(await readFile(file), updated);
  await writeFile(file, updated.toString().replace('true', 'false') + '# later user edit\r\n');
  assert.equal((await updateWSLConfig(file)).changed, true);
  assert.match(await readFile(file, 'utf8'), /# later user edit/);
  assert.equal(await readFile(backup, 'utf8'), original);
  assert.deepEqual((await readdir(root)).sort(), ['.wslconfig', '.wslconfig.codex-cloud.before-loopback']);
  const missing = join(root, 'new-config'); assert.equal((await updateWSLConfig(missing)).backup, null);
  assert.equal((await updateWSLConfig(missing)).changed, false);
});

test('special and oversized config or backup files cannot be overwritten or block the installer', async t => {
  const root = await directory(t), target = join(root, 'unrelated'); await writeFile(target, 'retain unrelated file');
  const exec = promisify(execFile);
  for (const kind of ['symlink', 'directory', 'fifo', 'oversized']) {
    for (const atBackup of [false, true]) {
      const folder = join(root, kind + '-' + atBackup); await mkdir(folder);
      const file = join(folder, '.wslconfig'), blocked = atBackup ? file + '.codex-cloud.before-loopback' : file;
      if (atBackup) await writeFile(file, '[wsl2]\nnetworkingMode=mirrored\n');
      if (kind === 'symlink') await symlink(target, blocked);
      else if (kind === 'directory') await mkdir(blocked);
      else if (kind === 'fifo') await exec('mkfifo', [blocked]);
      else await writeFile(blocked, 'x'.repeat(65537));
      await assert.rejects(updateWSLConfig(file));
      if (atBackup) assert.equal(await readFile(file, 'utf8'), '[wsl2]\nnetworkingMode=mirrored\n');
      await assert.rejects(readFile(file + '.codex-cloud.tmp'), { code: 'ENOENT' });
    }
  }
  assert.equal(await readFile(target, 'utf8'), 'retain unrelated file');
});

test('an occupied temporary file refuses concurrent work without removing another writer or changing configuration', async t => {
  const root = await directory(t), file = join(root, '.wslconfig');
  const original = '[wsl2]\nnetworkingMode=mirrored\n'; await writeFile(file, original);
  await writeFile(file + '.codex-cloud.tmp', 'another writer');
  await assert.rejects(updateWSLConfig(file), { code: 'EEXIST' });
  assert.equal(await readFile(file + '.codex-cloud.tmp', 'utf8'), 'another writer');
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(readFile(file + '.codex-cloud.before-loopback'), { code: 'ENOENT' });
});

test('an edit during the final asynchronous close is preserved for existing and newly created WSL configuration', async t => {
  for (const present of [true, false]) await t.test(String(present), async t => {
    const root=await directory(t),file=join(root,'.wslconfig'),edited='[wsl2]\nnetworkingMode=mirrored\nmemory=12GB\n# operator edit\n';
    if(present)await writeFile(file,'[wsl2]\nnetworkingMode=mirrored\nmemory=4GB\n');
    const probe=await open(join(root,'probe'),'w'),prototype=Object.getPrototypeOf(probe),write=prototype.writeFile;await probe.close();await rm(join(root,'probe'));let injected=false;
    t.mock.method(prototype,'writeFile',async function(...args){
      if(readlinkSync('/proc/self/fd/'+this.fd)===file+'.codex-cloud.tmp'){
        const close=this.close;t.mock.method(this,'close',async function(...args){const result=await close.apply(this,args);if(!injected){injected=true;writeFileSync(file,edited);}return result;});
      }
      return write.apply(this,args);
    });
    await assert.rejects(updateWSLConfig(file),{status:409});assert.equal(injected,true);assert.equal(await readFile(file,'utf8'),edited);
    await assert.rejects(readFile(file+'.codex-cloud.tmp'),{code:'ENOENT'});
  });
});

test('normal Linux and WSL NAT do not inspect or mutate Windows user configuration', async () => {
  const calls = [], logs = [];
  const run = async (command, args) => { calls.push({ command, args }); return { status: 0, stdout: 'nat\n' }; };
  assert.equal((await configureWSLNetwork({ kernel: '6.8.0-generic', run, log: line => logs.push(line) })).status, 'not-wsl');
  assert.equal(calls.length, 0);
  assert.equal((await configureWSLNetwork({ kernel, run, log: line => logs.push(line) })).status, 'nat');
  assert.deepEqual(calls, [{ command: 'wslinfo', args: ['--networking-mode'] }]);
});

test('mirrored detection uses fixed commands and literal path arguments, with no shutdown or config content in logs', async t => {
  const root = await directory(t), calls = [], logs = [], file = join(root, '.wslconfig');
  await writeFile(file, '[wsl2]\nnetworkingMode=mirrored\n# private-config-value-do-not-log\n');
  const windowsProfile = 'C:\\Users\\中文 $(`literal`)';
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === 'wslinfo') return { status: 0, stdout: 'mirrored\n' };
    if (command === 'powershell.exe') return { status: 0, stdout: windowsProfile + '\r\n' };
    assert.equal(command, 'wslpath'); assert.deepEqual(args, ['-u', windowsProfile]);
    return { status: 0, stdout: root + '\n' };
  };
  const options = { kernel, run, log: line => logs.push(line) };
  assert.equal((await configureWSLNetwork({ ...options, check: true })).needsConfiguration, true);
  assert.deepEqual(await readdir(root), ['.wslconfig']);
  const written = await configureWSLNetwork(options); assert.equal(written.restartRequired, true);
  assert.equal((await configureWSLNetwork(options)).restartRequired, false);
  assert.ok(logs.some(line => line.includes('会结束所有 WSL')));
  assert.ok(!logs.join('').includes('private-config-value-do-not-log'));
  assert.ok(calls.every(call => !call.args.includes('--shutdown') && !call.args.includes('restart')));
  const powershell = calls.find(call => call.command === 'powershell.exe');
  assert.deepEqual(powershell.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(!powershell.args[3].includes(windowsProfile));
});

test('missing interop and invalid profile outputs fail before any config mutation; unavailable detection is reported', async t => {
  const root = await directory(t), logs = [];
  const unavailable = await configureWSLNetwork({ kernel, run: async () => ({ status: 1, stdout: '' }), log: line => logs.push(line) });
  assert.equal(unavailable.status, 'unavailable'); assert.match(logs[0], /无法识别/);
  for (const bad of ['', 'C:\\Users\\name\nextra', 'relative', 'C:\\' + 'x'.repeat(1024)]) {
    await assert.rejects(configureWSLNetwork({ kernel, log: () => {}, run: async command => ({ status: 0, stdout: command === 'wslinfo' ? 'mirrored' : bad }) }), /Windows 用户目录/);
  }
  for (const bad of ['relative', '/tmp/one\n/tmp/two', '/' + 'x'.repeat(4096)]) {
    await assert.rejects(configureWSLNetwork({ kernel, log: () => {}, run: async command => ({ status: 0, stdout: command === 'wslinfo' ? 'mirrored' : command === 'wslpath' ? bad : 'C:\\Users\\valid' }) }), /转换 Windows 用户目录/);
  }
  assert.deepEqual(await readdir(root), []);
});
