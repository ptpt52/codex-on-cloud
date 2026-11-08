import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopEnvironment } from './desktop-controls.mjs';
import { terminalEnvironment } from './deployment-mode.mjs';

// Readiness belongs to the task host, independently of the file service.
export function hostHealth(config) {
  const env = config.mode === 'terminal' ? terminalEnvironment(config) : desktopEnvironment(config);
  const exec = promisify(execFile);
  let version;
  return async () => {
    version ??= exec('codex', ['--version'], { env, timeout: 1000, maxBuffer: 2048 }).then(value => value.stdout.trim(), () => '');
    const command = config.mode === 'terminal' ? ['tmux', ['-S', env.TMUX_SOCKET, 'has-session', '-t', '=codex-host']] : ['xdotool', ['getdisplaygeometry']];
    const ready = await exec(command[0], command[1], { env, timeout: 1000, maxBuffer: 2048 }).then(() => true, () => false);
    return { ready, version: await version };
  };
}
