import { join } from 'node:path';

export function deploymentMode(value = 'desktop') {
  if (!['desktop', 'terminal'].includes(value)) throw Error('DEPLOY_MODE / --mode 必须为 desktop 或 terminal');
  return value;
}
export function modeServices(mode) {
  return mode === 'terminal' ? ['codex-cloud-terminal.service', 'codex-cloud-manager.service', 'codex-cloud-panel.service']
    : ['codex-cloud-desktop.service', 'codex-cloud-actions.service', 'codex-cloud-manager.service', 'codex-cloud-panel.service'];
}
export function terminalEnvironment(config) {
  const env = { ...config.env, DEPLOY_MODE: 'terminal', WORKSPACE_DIR: config.workspace, TRANSFER_DIR: config.transfer,
    TMUX_SOCKET: join(config.runtime, 'tmux.sock'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'TMUX', 'TMUX_PANE', 'DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE']) delete env[key];
  return env;
}
