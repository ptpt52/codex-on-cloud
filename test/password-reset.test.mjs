import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, copyFile, open, readlink } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { resetPassword } from '../native/password-reset.mjs';
import { options } from '../scripts/reset-password.mjs';
import { createAccessControl } from '../panel/access-control.mjs';
import { createAuth } from '../panel/auth.mjs';

const exec = promisify(execFile), UNIT = 'codex-cloud-panel.service';
const oldPassword = 'test-only-old-admin-password', newPassword = 'test-only-new-admin-password', screenPassword = 'test-only-new-screen-password';
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; }
async function harness(t, { active = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex reset 中文 ')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'secrets'), { mode: 0o700 });
  const port = await freePort();
  await writeFile(join(root, '.env'), `PUBLIC_ORIGIN=https://desktop.example.com\nADMIN_USER=operator\nPANEL_PORT=${port}\n`, { mode: 0o600 });
  await writeFile(join(root, 'secrets', 'panel_password'), oldPassword + '\n', { mode: 0o600 });
  await writeFile(join(root, 'secrets', 'credentials.txt'), 'old summary', { mode: 0o600 });
  await writeFile(join(root, 'secrets', 'agent_secret'), 'test-only-agent-secret-unchanged', { mode: 0o600 });
  const dataDir = join(root, 'data', 'panel'), access = await createAccessControl({ dataDir, username: 'operator' });
  await access.saveScreen({ enabled: true, password: 'test-only-old-screen-password' });
  await access.saveTemporary({ enabled: true, username: 'visitor', password: 'test-only-visitor-password' });
  const state = { active, calls: [], logs: [], health: 0, portChecks: 0, stopFailure: false, startFailure: false };
  const context = { root, env: {}, log: text => state.logs.push(text), prompt: async target => target === 'admin' ? newPassword : screenPassword,
    run: async args => {
      state.calls.push([...args]); assert.ok(state.calls.length <= 20); assert.equal(args[1], UNIT);
      if (args[0] === 'show') return { status: 0, stdout: `LoadState=loaded\nActiveState=${state.active ? 'active' : 'inactive'}\nWorkingDirectory=${root}\n` };
      if (args[0] === 'stop') { if (state.stopFailure) return { status: 1 }; state.active = false; await state.onStop?.(); return { status: 0 }; }
      if (args[0] === 'start') { if (state.startFailure) return { status: 1 }; state.active = true; return { status: 0 }; }
      throw Error('Unexpected service action');
    }, ensureStopped: async () => { state.portChecks++; }, checkHealth: async () => { state.health++; } };
  return { root, dataDir, access, state, context, password: () => readFile(join(root, 'secrets', 'panel_password'), 'utf8'), policy: () => readFile(join(dataDir, 'access.json'), 'utf8') };
}
const mutations = h => h.state.calls.filter(args => args[0] !== 'show').map(args => args[0]);

test('password reset ignores inherited deployment variables for credentials, port checks and recovery', async t => {
  const h = await harness(t), persisted = (await readFile(join(h.root, '.env'), 'utf8')).match(/PANEL_PORT=(\d+)/)[1];
  const old = Object.fromEntries(['PUBLIC_ORIGIN', 'PORT', 'ADMIN_USER'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, { PUBLIC_ORIGIN: 'https://old.example.test', PORT: '1', ADMIN_USER: 'stale-user' });
  const { env, ...context } = h.context;
  await resetPassword({ target: 'admin' }, { ...context,
    ensureStopped: async port => assert.equal(port, Number(persisted)),
    checkHealth: async value => assert.deepEqual(value, { port: Number(persisted), origin: 'https://desktop.example.com' }),
  });
  const summary = await readFile(join(h.root, 'secrets/credentials.txt'), 'utf8');
  assert.match(summary, /https:\/\/desktop.example.com/); assert.match(summary, /用户名：operator/); assert.ok(!summary.includes('stale-user'));
});

test('reset options reject password arguments, mixed targets and unsupported generation', () => {
  assert.equal(options(['--admin']).target, 'admin'); assert.equal(options(['--screen']).target, 'screen'); assert.equal(options(['--unlock']).target, 'unlock');
  assert.equal(options([]).target, undefined); assert.equal(options(['--admin', '--generate']).generate, true);
  for (const args of [['--admin', '--screen'], ['--generate'], ['--screen', '--generate'], ['--password', 'no-secret-arguments'], ['--restart-desktop']]) assert.throws(() => options(args));
});

test('admin reset changes only private credentials, revokes old cookies on reload and restores only the panel', async t => {
  const h = await harness(t), original = await h.policy(), configuration = await readFile(join(h.root, '.env'));
  const authConfig = { dataDir: h.dataDir, username: 'operator', password: oldPassword, sessionMs: 60000 }, auth = await createAuth(authConfig), old = await auth.create(); await auth.close();
  assert.deepEqual(await resetPassword({ target: 'admin' }, h.context), { target: 'admin', panelRestarted: true });
  assert.equal(await h.password(), newPassword + '\n'); assert.equal(await h.policy(), original); assert.deepEqual(await readFile(join(h.root, '.env')), configuration);
  assert.equal(await readFile(join(h.root, 'secrets', 'agent_secret'), 'utf8'), 'test-only-agent-secret-unchanged');
  assert.ok((await readFile(join(h.root, 'secrets', 'credentials.txt'), 'utf8')).includes('用户名：operator\n密码：' + newPassword));
  for (const name of ['panel_password', 'credentials.txt']) { assert.equal((await lstat(join(h.root, 'secrets', name))).mode & 0o777, 0o600); await assert.rejects(lstat(join(h.root, 'secrets', name + '.reset.tmp')), { code: 'ENOENT' }); }
  assert.deepEqual(mutations(h), ['stop', 'start']); assert.equal(h.state.health, 1); assert.ok(!h.state.logs.join('\n').includes(newPassword));
  assert.equal((await lstat(join(h.dataDir, 'password-reset.lock'))).size, 0);
  const restored = await createAuth({ ...authConfig, password: newPassword }); assert.equal(restored.get(old.token), null); assert.equal(await restored.verify('operator', newPassword), true); await restored.close();
});

test('screen reset and unlock preserve the latest temporary account and administrator secret', async t => {
  const h = await harness(t);
  h.state.onStop = () => h.access.saveTemporary({ enabled: true, username: 'visitor', password: 'test-only-updated-visitor' });
  await resetPassword({ target: 'screen' }, h.context);
  let restored = await createAccessControl({ dataDir: h.dataDir, username: 'operator' });
  assert.equal(await restored.verifyScreen(screenPassword), true); assert.ok(await restored.verifyTemporary('visitor', 'test-only-updated-visitor')); assert.equal(await h.password(), oldPassword + '\n');
  h.state.onStop = undefined; const temporary = JSON.parse(await h.policy()).temporary;
  await resetPassword({ target: 'unlock' }, h.context); restored = await createAccessControl({ dataDir: h.dataDir, username: 'operator' });
  assert.equal(restored.screenEnabled, false); assert.deepEqual(JSON.parse(await h.policy()).temporary, temporary); assert.equal(await h.password(), oldPassword + '\n');
  assert.deepEqual(mutations(h), ['stop', 'start', 'stop', 'start']);
});

test('an inactive panel stays inactive and generated passwords never enter command output', async t => {
  const h = await harness(t, { active: false });
  h.context.prompt = () => { throw Error('Generation must not prompt'); };
  assert.equal((await resetPassword({ target: 'admin', generate: true }, h.context)).panelRestarted, false);
  const password = (await h.password()).trim(); assert.match(password, /^[A-Za-z0-9_-]{43}$/); assert.equal(h.state.active, false); assert.deepEqual(mutations(h), []); assert.equal(h.state.health, 0); assert.ok(!h.state.logs.join('\n').includes(password));
});

test('the maximum-length Unicode administrator password is accepted without changing its bytes', async t => {
  const h = await harness(t), password = '密'.repeat(512);
  await resetPassword({ target: 'admin' }, { ...h.context, prompt: async () => password });
  assert.equal(await h.password(), password + '\n'); assert.ok((await readFile(join(h.root, 'secrets', 'credentials.txt'), 'utf8')).includes(password));
});

test('administrator recovery works when the original password and summary files are missing', async t => {
  const h = await harness(t, { active: false });
  await rm(join(h.root, 'secrets', 'panel_password')); await rm(join(h.root, 'secrets', 'credentials.txt'));
  await resetPassword({ target: 'admin' }, h.context); assert.equal(await h.password(), newPassword + '\n'); assert.deepEqual(mutations(h), []);
});

for (const stage of ['before rename', 'after rename']) test(`storage failure ${stage} restores the panel and accurately reports uncertainty`, async t => {
  const h = await harness(t), probe = await open(join(h.root, 'secrets', 'panel_password')), prototype = Object.getPrototypeOf(probe), sync = prototype.sync; await probe.close();
  t.mock.method(prototype, 'sync', async function () {
    const path = await readlink('/proc/self/fd/' + this.fd);
    if (stage === 'before rename' ? path.endsWith('/panel_password.reset.tmp') : path.endsWith('/secrets')) throw Error('test-only storage failure');
    return sync.call(this);
  });
  await assert.rejects(resetPassword({ target: 'admin' }, h.context), /可能已更新/);
  assert.equal(await h.password(), (stage === 'before rename' ? oldPassword : newPassword) + '\n');
  assert.equal(h.state.active, true); assert.deepEqual(mutations(h), ['stop', 'start']);
  await assert.rejects(lstat(join(h.root, 'secrets', 'panel_password.reset.tmp')), { code: 'ENOENT' });
  assert.ok(!h.state.logs.join('\n').includes(newPassword));
});

test('the default post-restart health check uses authenticated-host loopback routing without credentials', async t => {
  const h = await harness(t); let requests = 0;
  const server = http.createServer((req, res) => { requests++; assert.equal(req.url, '/healthz'); assert.equal(req.headers.host, 'desktop.example.com'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); res.end('{"ok":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await writeFile(join(h.root, '.env'), `PUBLIC_ORIGIN=https://desktop.example.com\nADMIN_USER=operator\nPANEL_PORT=${server.address().port}\n`);
  const { checkHealth: _mock, ...context } = h.context; await resetPassword({ target: 'unlock' }, context);
  assert.equal(requests, 1); assert.equal(h.state.active, true);
});

test('invalid passwords, cancellation and another deployment fail before stopping services or changing credentials', async t => {
  const h = await harness(t);
  for (const password of ['short', ' leading-space-invalid-admin', 'line-break-admin-password\n']) {
    await assert.rejects(resetPassword({ target: 'admin' }, { ...h.context, prompt: async () => password }), /密码需/);
  }
  await assert.rejects(resetPassword({ target: 'admin' }, { ...h.context, prompt: async () => { throw Error('cancelled prompt'); } }), /cancelled prompt/);
  const other = await mkdtemp(join(tmpdir(), 'codex-other-project-')); t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(resetPassword({ target: 'unlock' }, { ...h.context, run: async () => ({ status: 0, stdout: `LoadState=loaded\nActiveState=active\nWorkingDirectory=${other}\n` }) }), /其他项目/);
  for (const context of [{ uid: 0 }, { platform: 'darwin' }]) await assert.rejects(resetPassword({ target: 'unlock' }, { ...h.context, ...context }), /普通部署用户/);
  assert.deepEqual(mutations(h), []); assert.equal(await h.password(), oldPassword + '\n');
});

test('symlink and FIFO reset targets are rejected without touching other files or stopping the panel', async t => {
  const h = await harness(t), victim = join(h.root, 'victim'); await writeFile(victim, 'keep');
  const path = join(h.root, 'secrets', 'panel_password'); await rm(path); await symlink(victim, path);
  await assert.rejects(resetPassword({ target: 'admin' }, h.context), /重置目标/); assert.equal(await readFile(victim, 'utf8'), 'keep');
  await rm(path); execFileSync('mkfifo', [path]); await assert.rejects(resetPassword({ target: 'admin' }, h.context), /重置目标/);
  assert.deepEqual(mutations(h), []); assert.equal((await lstat(join(h.dataDir, 'password-reset.lock'))).size, 0);
});

test('a failed stop or occupied manual panel never changes credentials, and the prior panel is restored', async t => {
  const h = await harness(t); h.state.stopFailure = true;
  await assert.rejects(resetPassword({ target: 'admin' }, h.context), /无法停止/); assert.equal(await h.password(), oldPassword + '\n'); assert.equal(h.state.active, true);
  h.state.stopFailure = false; h.context.ensureStopped = () => { throw Error('manual listener still open'); };
  await assert.rejects(resetPassword({ target: 'admin' }, h.context), /manual listener/); assert.equal(await h.password(), oldPassword + '\n'); assert.equal(h.state.active, true);
});

test('restoration failure reports the possible committed change without leaking the password', async t => {
  const h = await harness(t); h.state.startFailure = true;
  await assert.rejects(resetPassword({ target: 'admin' }, h.context), error => { assert.match(error.message, /可能已更新/); assert.ok(!error.message.includes(newPassword)); return true; });
  assert.equal(await h.password(), newPassword + '\n'); assert.equal((await lstat(join(h.dataDir, 'password-reset.lock'))).size, 0);
});

test('concurrent resets are refused and a dead process lock is recovered without signaling any process', async t => {
  const h = await harness(t); let release, entered;
  const held = new Promise(resolve => { release = resolve; }), stopped = new Promise(resolve => { entered = resolve; });
  h.state.onStop = async () => { entered(); await held; };
  const first = resetPassword({ target: 'admin' }, h.context); await stopped;
  try { await assert.rejects(resetPassword({ target: 'unlock' }, h.context), /已有密码重置/); } finally { release(); }
  await first; h.state.onStop = undefined;
  await writeFile(join(h.dataDir, 'password-reset.lock'), JSON.stringify({ pid: 2147483647, started: '1' }), { mode: 0o600 });
  await resetPassword({ target: 'unlock' }, h.context); assert.equal(JSON.parse(await h.policy()).screen.enabled, false);
});

test('unsafe maintenance locks fail without interrupting the panel', async t => {
  const h = await harness(t), lock = join(h.dataDir, 'password-reset.lock');
  await symlink(join(h.root, 'secrets/panel_password'), lock);
  await assert.rejects(resetPassword({ target: 'unlock' }, h.context), /无法取得本机文件锁/);
  assert.deepEqual(mutations(h), []); assert.equal(await h.password(), oldPassword + '\n');
});

test('empty and partial crash locks recover without changing the panel lifetime', async t => {
  const h = await harness(t, { active: false });
  for (const content of ['', '{"pid":']) {
    await writeFile(join(h.dataDir, 'password-reset.lock'), content, { mode: 0o600 });
    await resetPassword({ target: 'unlock' }, h.context);
    assert.equal((await lstat(join(h.dataDir, 'password-reset.lock'))).size, 0);
  }
  assert.deepEqual(mutations(h), []);
});

async function cli(t) {
  const h = await harness(t, { active: false });
  for (const [folder, file] of [['scripts', 'reset-password.mjs'], ['native', 'password-reset.mjs'], ['native', 'file-lock.mjs'], ['native', 'file_lock.py'], ['panel', 'access-control.mjs']]) {
    await mkdir(join(h.root, folder), { recursive: true }); await copyFile(resolve(folder, file), join(h.root, folder, file));
  }
  const bin = join(h.root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'systemctl'), '#!/usr/bin/env python3\nimport os,sys,json\nwith open(os.environ["RESET_TEST_LOG"],"a") as log: log.write(json.dumps(sys.argv[1:])+"\\n")\nassert sys.argv[1:3]==["--user","show"], "inactive panel must not be started"\nprint("LoadState=loaded\\nActiveState=inactive\\nWorkingDirectory="+os.environ["RESET_TEST_ROOT"])\n', { mode: 0o700 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, RESET_TEST_ROOT: h.root, RESET_TEST_LOG: join(h.root, 'service-calls'), ADMIN_USER: 'operator', PUBLIC_ORIGIN: 'https://desktop.example.com', PANEL_PORT: String(await freePort()) }; delete env.PORT;
  return { ...h, env, script: join(h.root, 'scripts', 'reset-password.mjs') };
}
test('the real noninteractive CLI generates a private administrator password and does not echo it', async t => {
  const h = await cli(t), result = await exec(process.execPath, [h.script, '--admin', '--generate'], { env: h.env, timeout: 10000, maxBuffer: 8192 });
  const password = (await h.password()).trim(); assert.match(password, /^[A-Za-z0-9_-]{43}$/); assert.ok(!(result.stdout + result.stderr).includes(password)); assert.match(result.stdout, /保持停止状态/);
  const before = await h.password(); await assert.rejects(exec(process.execPath, [h.script, '--admin'], { env: h.env, timeout: 10000, maxBuffer: 8192 }), error => { assert.match(error.stderr, /交互式终端/); return true; }); assert.equal(await h.password(), before);
  await assert.rejects(exec(process.execPath, [h.script, '--admin', newPassword], { env: h.env, timeout: 10000, maxBuffer: 8192 }), error => { assert.ok(!error.stderr.includes(newPassword)); return true; });
  const temporary = JSON.parse(await h.policy()).temporary;
  await exec(process.execPath, [h.script, '--unlock'], { env: h.env, timeout: 10000, maxBuffer: 8192 });
  const policy = JSON.parse(await h.policy()); assert.equal(policy.screen.enabled, false); assert.deepEqual(policy.temporary, temporary);
});

for (const mode of ['screen', 'menu', 'cancel']) test(`the real terminal prompt ${mode === 'cancel' ? 'cancels without mutation' : mode === 'menu' ? 'selects screen reset from the menu' : 'hides both screen password entries'}`, async t => {
  const h = await cli(t), before = await h.policy();
  const source = `import os,sys,pty,select,time,errno,signal
pid,fd=pty.fork()
if pid==0: os.execve(sys.argv[1],[sys.argv[1],sys.argv[2]]+([] if sys.argv[3]=="menu" else ["--screen"]),os.environ)
output=b""; stage=0 if sys.argv[3]=="menu" else 1; end=time.monotonic()+12; status=None; reaped=False
try:
 while time.monotonic()<end:
  ready,_,_=select.select([fd],[],[],0.1)
  if ready:
   try: chunk=os.read(fd,4096)
   except OSError as error:
    if error.errno!=errno.EIO: raise
    break
   if not chunk: break
   output+=chunk
   assert len(output)<16384
   if stage==0 and "请选择 1 / 2 / 3：".encode() in output:
    os.write(fd,b"2\\n"); stage=1
   elif stage==1 and "输入新密码：".encode() in output:
    os.write(fd,b"\\x03" if sys.argv[3]=="cancel" else sys.argv[4].encode()+b"\\n"); stage=2
   elif stage==2 and "再次输入新密码：".encode() in output:
    os.write(fd,sys.argv[4].encode()+b"\\n"); stage=3
  done,current=os.waitpid(pid,os.WNOHANG)
  if done: status=current; reaped=True; break
 else: raise AssertionError("TTY prompt deadline")
 if status is None: _,status=os.waitpid(pid,0); reaped=True
 code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128+os.WTERMSIG(status)
 assert code==(130 if sys.argv[3]=="cancel" else 0),output.decode(errors="replace")
 assert sys.argv[4].encode() not in output, "password was echoed"
finally:
 if not reaped:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
 os.close(fd)
`;
  await exec('python3', ['-c', source, process.execPath, h.script, mode, screenPassword], { env: h.env, timeout: 15000, maxBuffer: 16384 });
  if (mode === 'cancel') assert.equal(await h.policy(), before);
  else { const access = await createAccessControl({ dataDir: h.dataDir, username: 'operator' }); assert.equal(await access.verifyScreen(screenPassword), true); }
  assert.equal(await h.password(), oldPassword + '\n');
});
