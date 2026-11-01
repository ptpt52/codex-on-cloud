import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment, settings } from '../native/config.mjs';

function secret(env, name) {
  const file = env[`${name}_FILE`];
  if (!file) throw new Error(`缺少 ${name}_FILE，请先执行 npm run setup`);
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} 必须是 16–512 个字符的单行密钥`);
  }
  return value;
}

export function readConfig(env = environment()) {
  const native = settings(env);
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:36080');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTP(S) 根地址');
  }
  const agentUrl = `http://127.0.0.1:${native.agentPort}`;
  const hosts = new Set([origin.host.toLowerCase()]);
  for (const host of (env.ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.:[\]-]+$/.test(host)) throw new Error('ALLOWED_HOSTS 只接受域名或 IP，可带端口，不接受通配符');
    hosts.add(host);
  }
  const port = Number(env.PORT ?? native.panelPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
  return {
    host: '127.0.0.1', port, origin: origin.origin,
    secureCookies: origin.protocol === 'https:', hosts,
    dataDir: join(native.root, 'data', 'panel'),
    username: env.ADMIN_USER || 'admin',
    password: secret({ ADMIN_PASSWORD_FILE: join(native.root, 'secrets', 'panel_password') }, 'ADMIN_PASSWORD'),
    agentSecret: secret({ AGENT_SECRET_FILE: join(native.root, 'secrets', 'agent_secret') }, 'AGENT_SECRET'),
    vncSocket: native.socket, agentUrl, transferDir: native.transfer,
    tunnelDiagnosticsUrl: `http://127.0.0.1:${native.tunnelMetricsPort}/diag/tunnel`,
    sessionMs: 7 * 24 * 60 * 60 * 1000,
  };
}
