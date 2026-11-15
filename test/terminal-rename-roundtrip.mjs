// Real tmux identity races, in a separate server. No X11 or production input.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTerminalManager } from '../native/terminals.mjs';

export async function terminalRenameRoundtrip() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-terminal-rename-')), exec = promisify(execFile);
  const run = async (command, args) => (await exec(command, args, { timeout: 3000, maxBuffer: 16384 })).stdout.trim();
  const tmux = args => run('tmux', ['-S', join(directory, 'tmux.sock'), ...args]);
  let beforeRename;
  const manager = createTerminalManager({ runtime: directory, mode: 'terminal', maxTerminals: 8 }, { run: async (command, args) => {
    if (beforeRename && command === 'tmux' && (args.includes('if-shell') || args.includes('set-option') && args.includes('@codex_cloud_name'))) {
      const change = beforeRename; beforeRename = undefined; await change();
    }
    return run(command, args);
  } });
  const destination = async () => {
    const terminal = (await manager.list()).terminals.find(item => item.id === 'main');
    return { terminalId: terminal.id, terminalToken: terminal.token };
  };
  try {
    await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'codex-host', '/bin/sleep', '120']);
    await tmux(['new-session', '-d', '-s', 'codex', '/bin/sleep', '120']);
    const target = await destination();
    for (const name of ["日志 ' $(never) `never`", '"; kill-server; #', '$HOME "x" \\', '#{pane_pid}', '}; kill-server; {']) {
      const result = await manager.manage({ action: 'rename', ...target, name });
      assert.equal(result.terminals[0].name, name);
      assert.equal(result.terminals[0].token, target.terminalToken);
    }
    for (const mutation of ['replace', 'respawn', 'split']) {
      const target = await destination();
      beforeRename = async () => {
        if (mutation === 'replace') {
          await tmux(['kill-session', '-t', '=codex']);
          await tmux(['new-session', '-d', '-s', 'codex', '/bin/sleep', '120']);
        } else if (mutation === 'respawn') await tmux(['respawn-pane', '-k', '-t', '=codex:0.0', '/bin/sleep', '120']);
        else await tmux(['split-window', '-d', '-t', '=codex:0.0', '/bin/sleep', '120']);
        await tmux(['set-option', '-t', '=codex', '@codex_cloud_name', 'replacement']);
      };
      await assert.rejects(manager.manage({ action: 'rename', ...target, name: 'stale name' }), error => error.status === 409 && error.outcome === 'rejected', mutation);
      assert.equal(await tmux(['show-option', '-v', '-t', '=codex', '@codex_cloud_name']), 'replacement', mutation);
    }
    console.log('✓ isolated real tmux: literal rename arguments; replaced, respawned and split terminals reject stale renames');
  } finally { await tmux(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
