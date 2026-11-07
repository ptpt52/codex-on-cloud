import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopEnvironment } from '../native/desktop-controls.mjs';
import { createTerminalManager } from '../native/terminals.mjs';

const exec = promisify(execFile), source = resolve(import.meta.dirname, '..');
async function eventually(probe, message) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test('real auxiliary shells share the primary bashrc, prompt, tools and paste settings without copying live shell state or restarting tasks', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-shell-'));
  const root = join(directory, "app ' $(never) `never`"), home = join(directory, 'home'), results = join(directory, 'results');
  const selectedBin = join(directory, 'selected-bin'), userBin = join(directory, 'user-bin');
  const config = { root, runtime: directory, workspace: join(directory, "work ' $(never) `never`"), transfer: join(directory, 'transfer'), display: ':199',
    env: { ...process.env, HOME: home, HISTFILE: '/dev/null', PATH: `${selectedBin}:${process.env.PATH}`, SHELL_TEST_RESULTS: results, SHELL_TEST_USER_BIN: userBin } };
  for (const path of [join(root, 'desktop'), home, results, selectedBin, userBin, config.workspace, config.transfer]) await mkdir(path, { recursive: true, mode: 0o700 });
  for (const name of ['codex-session', 'terminal.bashrc', 'tmux.conf']) await copyFile(join(source, 'desktop', name), join(root, 'desktop', name));
  // Emulate an older private server without restarting its primary shell.
  await writeFile(join(root, 'desktop', 'tmux.conf'), (await readFile(join(root, 'desktop', 'tmux.conf'), 'utf8')).replace('history-limit 10000', 'history-limit 2000'));
  await writeFile(join(home, '.bash_profile'), 'touch "$SHELL_TEST_RESULTS/profile-loaded"\n');
  await writeFile(join(home, '.bashrc'), `
PS1='[项目 shell] \\w\\$ '
export SHELL_TEST_CUSTOM='from-user-bashrc'
export EDITOR='test-editor'
export PATH="$SHELL_TEST_USER_BIN:/usr/bin:/bin"
alias project_alias='printf alias-loaded'
project_function() { printf function-loaded; }
bind 'set enable-bracketed-paste off'
shell_test_probe() {
  printf '%s\\0' "$PS1" "$PATH" "$SHELL_TEST_CUSTOM" "$EDITOR" "$PWD" "$LANG" "$LC_ALL" "$TERM" "$DISPLAY" "$XAUTHORITY" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \\
    "$(alias project_alias)" "$(project_function)" "$(command -v selected-tool)" "$(bind -v)" > "$SHELL_TEST_RESULTS/$BASHPID"
}
printf 'loaded\\n' >> "$SHELL_TEST_RESULTS/ready-$BASHPID"
`);
  for (const bin of [selectedBin, userBin]) await writeFile(join(bin, 'selected-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  for (const name of ['codex', 'never']) await writeFile(join(selectedBin, name), '#!/bin/sh\ntouch "$SHELL_TEST_RESULTS/unwanted-command"\n', { mode: 0o700 });
  const env = desktopEnvironment(config);
  for (const key of ['TMUX', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND']) delete env[key];
  const run = async (command, args) => (await exec(command, args, { env, timeout: 3000, maxBuffer: 32 * 1024 })).stdout.trim();
  const tmux = args => run('tmux', ['-S', join(directory, 'tmux.sock'), ...args]);
  const manager = () => createTerminalManager(config, { run, launch: () => assert.fail('text terminal creation must not open a desktop window') });
  async function probe(terminal) {
    const pid = terminal.token.split(':')[1], ready = join(results, `ready-${pid}`), file = join(results, pid);
    await eventually(() => access(ready).then(() => true, () => false), `${terminal.id} did not load the user bashrc`);
    await tmux(['send-keys', '-t', terminal.token.split(':')[0], '-l', 'shell_test_probe']);
    await tmux(['send-keys', '-t', terminal.token.split(':')[0], 'Enter']);
    await eventually(() => access(file).then(() => true, () => false), `${terminal.id} did not run the shell probe`);
    const data = await readFile(file, 'utf8'); assert.ok(Buffer.byteLength(data) < 32 * 1024);
    return data.split('\0').slice(0, -1);
  }
  try {
    await run('tmux', ['-f', join(root, 'desktop', 'tmux.conf'), '-S', join(directory, 'tmux.sock'), 'new-session', '-d', '-s', 'codex', '-c', config.workspace, 'bash', join(root, 'desktop', 'codex-session')]);
    const controls = manager(), main = (await controls.list()).terminals[0], expected = await probe(main);
    assert.equal(await tmux(['display-message', '-p', '-t', main.token.split(':')[0], '#{history_limit}']), '2000');
    assert.equal(expected[0], '[项目 shell] \\w\\$ '); assert.equal(expected[1], `${env.PATH}:${userBin}:/usr/bin:/bin`);
    assert.equal(expected[2], 'from-user-bashrc'); assert.equal(expected[3], 'test-editor'); assert.equal(expected[4], config.workspace);
    assert.deepEqual(expected.slice(5, 7), ['C.UTF-8', 'C.UTF-8']); assert.equal(expected[8], config.display);
    assert.equal(expected[9], env.XAUTHORITY); assert.deepEqual(expected.slice(10, 13), [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]);
    assert.equal(expected[14], 'function-loaded'); assert.equal(expected[15], join(selectedBin, 'selected-tool')); assert.match(expected[16], /set enable-bracketed-paste on/);
    // Changes made inside the primary shell stay local to that shell.
    await tmux(['send-keys', '-t', 'codex:0.0', '-l', 'export SHELL_TEST_CUSTOM=main-only']); await tmux(['send-keys', '-t', 'codex:0.0', 'Enter']);
    for (let index = 1; index <= 3; index++) {
      const created = await controls.manage({ action: 'create', name: `辅助 ${index}`, view: 'terminal' });
      const terminal = created.terminals.find(item => item.id === created.created);
      assert.equal(await tmux(['display-message', '-p', '-t', terminal.token.split(':')[0], '#{history_limit}']), '10000');
      assert.deepEqual(await probe(terminal), expected);
      await manager().manage({ action: 'open', terminalId: terminal.id, terminalToken: terminal.token, view: 'terminal' });
      assert.equal(await readFile(join(results, `ready-${terminal.token.split(':')[1]}`), 'utf8'), 'loaded\n', 'reopening must not rerun shell initialization');
    }
    assert.equal((await controls.list()).terminals[0].token, main.token);
    assert.equal(await tmux(['display-message', '-p', '-t', main.token.split(':')[0], '#{history_limit}']), '2000');
    assert.equal(await readFile(join(results, `ready-${main.token.split(':')[1]}`), 'utf8'), 'loaded\n');
    await assert.rejects(access(join(results, 'profile-loaded')), { code: 'ENOENT' });
    await assert.rejects(access(join(results, 'unwanted-command')), { code: 'ENOENT' });
  } finally {
    await tmux(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
