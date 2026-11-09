import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { readPreferences } from './preferences.mjs';
import { deploymentMode } from './deployment-mode.mjs';
import { terminalLimit } from '../panel/public/terminal-slots.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
const maintenanceKeys = [
  'DEPLOY_MODE', 'WORKSPACE_DIR', 'RUNTIME_DIR', 'DESKTOP_SIZE', 'DISPLAY_NUMBER',
  'PANEL_PORT', 'PORT', 'AGENT_PORT', 'FILE_AGENT_PORT', 'TUNNEL_METRICS_PORT', 'MAX_TERMINALS',
  'PUBLIC_ORIGIN', 'ALLOWED_HOSTS', 'ADMIN_USER', 'ADMIN_PASSWORD_FILE', 'AGENT_SECRET_FILE',
  'WEBRTC_ENABLED', 'WEBRTC_LAN_ADDRESS', 'WEBRTC_IPV6', 'WEBRTC_IPV6_ADDRESS', 'WEBRTC_STUN_URL',
  'TCP_FORWARD_PORTS', 'TUNNEL_DNS_SERVERS', 'TUNNEL_EDGE_IP_VERSION', 'TUNNEL_PROTOCOL',
];
export function environment(overrides = process.env) {
  let file = {};
  try { file = parseEnv(readFileSync(join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...file, ...overrides };
}
// Long-lived services use their captured environment. Interactive maintenance
// must instead read the persisted deployment, even when launched from an older
// Codex terminal whose deployment variables have since changed.
export function maintenanceEnvironment(overrides = process.env, rootDirectory = root) {
  let persisted;
  try { persisted = parseEnv(readFileSync(join(rootDirectory, '.env'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { ...overrides }; throw error; }
  const inherited = { ...overrides };
  for (const key of maintenanceKeys) delete inherited[key];
  return { ...inherited, ...persisted };
}
export function maintenanceSettings(overrides = process.env, rootDirectory = root) {
  return settings(maintenanceEnvironment(overrides, rootDirectory));
}
export function settings(env = environment()) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 无效`);
    return value;
  };
  const workspace = resolve(root, env.WORKSPACE_DIR || './workspaces');
  const runtime = resolve(env.RUNTIME_DIR || join(env.XDG_RUNTIME_DIR || join(root, 'data', 'runtime'), 'codex-on-cloud'));
  const socket = join(runtime, 'vnc.sock');
  if ([socket, join(runtime, 'manager.sock'), join(runtime, 'tunnel.sock')].some(path => Buffer.byteLength(path) > 100)) throw new Error('RUNTIME_DIR 太长，请使用较短的绝对路径');
  const defaultSize = env.DESKTOP_SIZE || '1600x3200';
  if (!/^\d{3,4}x\d{3,4}$/.test(defaultSize) || defaultSize.split('x').some(value => Number(value) < 320 || Number(value) > 4096)) throw new Error('DESKTOP_SIZE 必须在 320x320 到 4096x4096 之间');
  const [width, height] = defaultSize.split('x').map(Number);
  const preferencesFile = join(root, 'data', 'desktop-settings.json');
  const defaultPreferences = { width, height, fontSize: 15 };
  const preferences = readPreferences(preferencesFile, defaultPreferences);
  const size = `${preferences.width}x${preferences.height}`;
  return {
    mode: deploymentMode(env.DEPLOY_MODE),
    maxTerminals: terminalLimit(env.MAX_TERMINALS),
    root, runtime, socket, tunnelSocket: join(runtime, 'tunnel.sock'), workspace, transfer: join(workspace, 'transfer'),
    display: `:${number('DISPLAY_NUMBER', 93, 10, 199)}`,
    panelPort: number('PANEL_PORT', 36080, 1024, 65535),
    agentPort: number('AGENT_PORT', 36902, 1024, 65535),
    fileAgentPort: number('FILE_AGENT_PORT', env.AGENT_PORT || 36902, 1024, 65535),
    tunnelMetricsPort: number('TUNNEL_METRICS_PORT', 36903, 1024, 65535),
    managerSocket: join(runtime, 'manager.sock'), desktopActionsSocket: join(runtime, 'actions.sock'), preferencesFile, preferences, defaultPreferences,
    size, env,
  };
}
