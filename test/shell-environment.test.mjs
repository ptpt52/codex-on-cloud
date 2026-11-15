import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, access, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setupShellEnvironment, shellEnvironmentHook, SHELL_CONFIG_LIMIT } from '../scripts/setup-shell.mjs';

const exec = promisify(execFile), terminalRc = resolve('desktop/terminal.bashrc');
async function home(t) {
  const path = await mkdtemp(join(tmpdir(), "codex-env ' $()-"));
  // Ubuntu's global bashrc otherwise prints a first-login sudo banner.
  await writeFile(join(path, '.sudo_as_admin_successful'), '');
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('explicit shell setup preserves user files, selects Bash login precedence and is idempotent', async t => {
  const path = await home(t), bashrc = '# custom prompt\nPS1="user> "\n', profile = '# custom login\n. "$HOME/.bashrc"\n';
  await writeFile(join(path, '.bashrc'), bashrc, { mode: 0o640 });
  await chmod(join(path, '.bashrc'), 0o640);
  await writeFile(join(path, '.bash_profile'), profile, { mode: 0o600 });
  await writeFile(join(path, '.profile'), '# lower priority\n');
  assert.deepEqual(await setupShellEnvironment({ home: path }), { created: true, hooked: ['.bashrc', '.bash_profile'], loginFile: '.bash_profile' });
  assert.equal(await readFile(join(path, '.bashrc'), 'utf8'), shellEnvironmentHook + '\n' + bashrc);
  assert.equal(await readFile(join(path, '.profile'), 'utf8'), '# lower priority\n');
  assert.equal((await lstat(join(path, '.bashrc'))).mode & 0o777, 0o640);
  for (const [name, expected] of [['.bashrc', bashrc], ['.bash_profile', profile]]) {
    const backup = join(path, '.config/shell/backups', name);
    assert.equal(await readFile(backup, 'utf8'), expected); assert.equal((await lstat(backup)).mode & 0o777, 0o600);
  }
  const shared = join(path, '.config/shell/dev-env.sh');
  assert.equal((await lstat(shared)).mode & 0o777, 0o600);
  await writeFile(shared, 'export CUSTOM_DEVELOPMENT_SETTING=preserved\n');
  assert.deepEqual(await setupShellEnvironment({ home: path }), { created: false, hooked: [], loginFile: '.bash_profile' });
  assert.equal(await readFile(shared, 'utf8'), 'export CUSTOM_DEVELOPMENT_SETTING=preserved\n');
  assert.equal(await readFile(join(path, '.config/shell/backups/.bashrc'), 'utf8'), bashrc);
});

test('unsafe, oversized or conflicting shell files fail before changing startup files', async t => {
  for (const kind of ['symlink', 'oversized', 'conflicting']) await t.test(kind, async t => {
    const path = await home(t), profile = '# unchanged\n'; await writeFile(join(path, '.profile'), profile);
    if (kind === 'symlink') await symlink(join(path, '.profile'), join(path, '.bashrc'));
    if (kind === 'oversized') await writeFile(join(path, '.bashrc'), ' '.repeat(SHELL_CONFIG_LIMIT));
    if (kind === 'conflicting') await writeFile(join(path, '.bashrc'), '# user code\n' + shellEnvironmentHook);
    await assert.rejects(setupShellEnvironment({ home: path }));
    assert.equal(await readFile(join(path, '.profile'), 'utf8'), profile);
    await assert.rejects(access(join(path, '.config/shell/dev-env.sh')), { code: 'ENOENT' });
  });
});

test('login, system and cloud Bash select the same development tools and reload changes without inherited guards', async t => {
  const path = await home(t), userBin = join(path, 'tools'), oldBin = join(path, 'old-service-tools');
  const cloudRc = join(path, 'desktop/terminal.bashrc');
  await mkdir(join(path, 'desktop')); await copyFile(terminalRc, cloudRc);
  await mkdir(userBin); await mkdir(oldBin);
  for (const name of ['node', 'npm', 'python3', 'go', 'git', 'codex']) {
    for (const bin of [userBin, oldBin]) await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s\\n" selected-version\n', { mode: 0o700 });
  }
  await writeFile(join(path, '.bash_profile'), '. "$HOME/.bashrc"\n');
  await writeFile(join(path, '.bashrc'), `
# Emulate a tool manager, initialized once by bashrc after the shared environment.
export PATH="$HOME/tools:$PATH"
CLOUD_TOOL_INITIALIZATIONS=$(( \${CLOUD_TOOL_INITIALIZATIONS:-0} + 1 ))
alias custom_alias='printf alias-loaded'
custom_function() { printf function-loaded; }
`);
  await setupShellEnvironment({ home: path });
  const shared = join(path, '.config/shell/dev-env.sh');
  await writeFile(shared, 'export PATH=/usr/bin:/bin\nexport LANG=C.UTF-8\nunset LC_ALL\nexport DEV_PROXY=initial\n');
  const env = { ...process.env, HOME: path, PATH: oldBin + ':/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', HISTFILE: '/dev/null' };
  for (const key of ['BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'CLOUD_TOOL_INITIALIZATIONS']) delete env[key];
  const probe = `printf '%s\\0' "$PATH" "$LANG" "\${LC_ALL-unset}" "$DEV_PROXY" "$CLOUD_TOOL_INITIALIZATIONS" "$(custom_function)" "$(alias custom_alias)"; for tool in node npm python3 go git codex; do command -v "$tool"; done`;
  const run = async args => (await exec('/bin/bash', args, { env, timeout: 5000, maxBuffer: 8192 })).stdout;
  const system = await run(['--noprofile', '-ic', probe]);
  assert.equal(await run(['--login', '-ic', probe]), system);
  assert.equal(await run(['--noprofile', '--rcfile', cloudRc, '-ic', probe]), system);
  assert.ok(system.includes('initial\0')); assert.ok(system.includes('unset\0')); assert.ok(system.includes('1\0'));
  assert.equal(system.split('\0')[0], userBin + ':/usr/bin:/bin');
  for (const tool of ['node', 'npm', 'python3', 'go', 'git', 'codex']) assert.ok(system.includes(join(userBin, tool)));
  await writeFile(shared, 'export PATH=/usr/bin:/bin\nexport LANG=C.UTF-8\nunset LC_ALL\nexport DEV_PROXY=updated\n');
  const changed = await run(['--noprofile', '--rcfile', cloudRc, '-ic', probe]);
  assert.ok(changed.includes('updated\0')); assert.equal(changed, await run(['--noprofile', '-ic', probe]));
  // Re-sourcing environment declarations does not grow PATH.
  assert.equal(await run(['--noprofile', '-ic', '. "$HOME/.config/shell/dev-env.sh"; . "$HOME/.config/shell/dev-env.sh"; printf %s "$PATH"']), '/usr/bin:/bin');
});

test('shared file size is bounded at startup and explicit user LC_ALL is respected', async t => {
  const path = await home(t); await setupShellEnvironment({ home: path });
  const shared = join(path, '.config/shell/dev-env.sh');
  const env = { ...process.env, HOME: path, HISTFILE: '/dev/null' };
  delete env.BASH_ENV; delete env.ENV;
  await writeFile(shared, 'export SHELL_OVERSIZED=must-not-load\n' + '#'.repeat(SHELL_CONFIG_LIMIT));
  const skipped = await exec('/bin/bash', ['--noprofile', '--rcfile', terminalRc, '-ic', 'printf %s "${SHELL_OVERSIZED-unset}"'], { env });
  assert.equal(skipped.stdout, 'unset'); assert.match(skipped.stderr, /exceeds 64 KiB/);
  await writeFile(shared, 'export LANG=C.UTF-8\nexport LC_ALL=C\n');
  assert.equal((await exec('/bin/bash', ['--noprofile', '--rcfile', terminalRc, '-ic', 'printf %s "$LC_ALL"'], { env })).stdout, 'C');
});

test('cloud initialization preserves desktop and tmux identity while allowing user development settings', async t => {
  const path = await home(t);
  const protectedKeys = ['HOME','DISPLAY','XAUTHORITY','TMUX','TMUX_PANE','TMUX_SOCKET','WORKSPACE_DIR','TRANSFER_DIR','FONTCONFIG_FILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','XDG_SESSION_TYPE','DBUS_SESSION_BUS_ADDRESS'];
  await writeFile(join(path, '.bashrc'), protectedKeys.map(key => `export ${key}=physical-desktop`).join('\n') + '\nexport WAYLAND_DISPLAY=physical\nexport LANG=C\nexport EDITOR=user-editor\n');
  const env = { ...process.env, HISTFILE: '/dev/null', LC_ALL: 'C.UTF-8' };
  for (const key of protectedKeys) env[key] = 'private-' + key;
  env.HOME = path; delete env.WAYLAND_DISPLAY; delete env.BASH_ENV; delete env.ENV;
  const probe = protectedKeys.map(key => `"$${key}"`).join(' ');
  const result = await exec('/bin/bash', ['--noprofile', '--rcfile', terminalRc, '-ic', `printf '%s\\0' ${probe} "\${WAYLAND_DISPLAY-unset}" "$LANG" "\${LC_ALL-unset}" "$EDITOR"`], { env });
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), [...protectedKeys.map(key => env[key]), 'unset', 'C', 'unset', 'user-editor']);
});

test('project helper fallback stays behind user tools and is not duplicated', async t => {
  const path = await home(t), cloudRc = join(path, 'desktop/terminal.bashrc'), fallback = join(path, 'data/host-tools/usr/bin');
  await mkdir(join(path, 'desktop')); await copyFile(terminalRc, cloudRc);
  await mkdir(fallback, { recursive: true });
  await writeFile(join(path, '.bashrc'), 'set -u\nexport PATH=/usr/bin:/bin\n');
  const env = { ...process.env, HOME: path, HISTFILE: '/dev/null' }; delete env.BASH_ENV; delete env.ENV;
  const run = command => exec('/bin/bash', ['--noprofile', '--rcfile', cloudRc, '-ic', command], { env });
  assert.equal((await run('printf %s "$PATH"')).stdout, '/usr/bin:/bin:' + fallback);
  await writeFile(join(path, '.bashrc'), 'export PATH="/usr/bin:/bin:$HOME/data/host-tools/usr/bin"\n');
  assert.equal((await run('printf %s "$PATH"')).stdout, '/usr/bin:/bin:' + fallback);
});
