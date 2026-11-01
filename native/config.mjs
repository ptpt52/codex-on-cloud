import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function environment(overrides = process.env) {
  let file = {};
  try { file = parseEnv(readFileSync(join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...file, ...overrides };
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
  if (Buffer.byteLength(socket) > 100) throw new Error('RUNTIME_DIR 太长，请使用较短的绝对路径');
  const size = env.DESKTOP_SIZE || '1280x800';
  if (!/^\d{3,4}x\d{3,4}$/.test(size) || size.split('x').some(value => Number(value) < 320 || Number(value) > 4096)) throw new Error('DESKTOP_SIZE 必须在 320x320 到 4096x4096 之间');
  return {
    root, runtime, socket, workspace, transfer: join(workspace, 'transfer'),
    display: `:${number('DISPLAY_NUMBER', 93, 10, 199)}`,
    panelPort: number('PANEL_PORT', 36080, 1024, 65535),
    agentPort: number('AGENT_PORT', 36902, 1024, 65535),
    size, env,
  };
}
