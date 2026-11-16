import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const NODE_SERVICE = 'codex-cloud-selfhost-node.service';

export async function command(file, args) {
  try {
    const value = await exec(file, args, { timeout: 30000, maxBuffer: 64 * 1024, env: { ...process.env, NO_COLOR: '1' } });
    return { ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() };
  } catch (error) {
    return { ok: false, code: error.code, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || '').trim() };
  }
}

function systemdQuote(value) {
  if (/[\r\n\0]/.test(value)) throw Error('systemd 路径无效');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export function serviceUnit({ frpc, config }) {
  return `[Unit]
Description=Codex on Cloud self-host node relay
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${systemdQuote(frpc)} -c ${systemdQuote(config)}
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
UMask=0077
LimitNOFILE=4096

[Install]
WantedBy=default.target
`;
}

export function servicePath(configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')) {
  return join(configHome, 'systemd', 'user', NODE_SERVICE);
}

export async function relayState(run) {
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
  const enabled = await run('systemctl', ['--user', 'is-enabled', NODE_SERVICE]);
  return { active: active.ok && active.stdout === 'active', enabled: enabled.ok && ['enabled', 'enabled-runtime'].includes(enabled.stdout) };
}

export async function stopRelay(run) {
  const result = await run('systemctl', ['--user', 'disable', '--now', NODE_SERVICE]);
  if (result.ok) return result;
  // A failure before unit creation has nothing to stop. Confirm both systemd
  // load and active state instead of treating an arbitrary stop error as success.
  const loaded = await run('systemctl', ['--user', 'show', NODE_SERVICE, '--property=LoadState', '--value']);
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
  return loaded.ok && loaded.stdout === 'not-found' && ['inactive', 'unknown'].includes(active.stdout) ? { ok: true } : result;
}

export async function restoreRelay(before, run) {
  if (!before) return [];
  const failures = [];
  if (before.enabled) {
    const enabled = await run('systemctl', ['--user', 'enable', NODE_SERVICE]);
    if (!enabled.ok) failures.push('恢复中继自启动：' + (enabled.stderr || enabled.stdout || enabled.code || 'unknown'));
  }
  if (before.active) {
    const restarted = await run('systemctl', ['--user', 'restart', NODE_SERVICE]);
    const active = restarted.ok ? await run('systemctl', ['--user', 'is-active', NODE_SERVICE]) : restarted;
    if (!active.ok || active.stdout !== 'active') failures.push('恢复中继服务：' + (active.stderr || active.stdout || active.code || 'unknown'));
  }
  return failures;
}

export async function relayDetails(run = command) {
  const result = await run('systemctl', ['--user', 'show', NODE_SERVICE, '--property=ActiveState,SubState,NRestarts,ExecMainStatus,ActiveEnterTimestamp', '--no-pager']);
  const empty = { restartCount: null, exitStatus: null, activeSinceAt: null };
  if (!result.ok || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) return empty;
  const properties = new Map(result.stdout.split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  const integer = (name, maximum) => { const value = properties.get(name); return /^\d{1,16}$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) <= maximum ? Number(value) : null; };
  const at = Date.parse(properties.get('ActiveEnterTimestamp') || '');
  return { restartCount: integer('NRestarts', Number.MAX_SAFE_INTEGER), exitStatus: integer('ExecMainStatus', 255), activeSinceAt: Number.isSafeInteger(at) && at > 0 ? at : null };
}
