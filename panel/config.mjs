import { readFileSync } from 'node:fs';

function secret(env, name) {
  const file = env[`${name}_FILE`];
  if (!file) throw new Error(`缺少 ${name}_FILE，请先执行 npm run setup`);
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} 必须是 16–512 个字符的单行密钥`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:36080');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTP(S) 根地址');
  }
  const desktopUrl = new URL(env.DESKTOP_URL || 'https://desktop:6901');
  const agentUrl = new URL(env.AGENT_URL || 'http://desktop:6902');
  for (const url of [desktopUrl, agentUrl]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('桌面和内部接口地址必须是 HTTP(S) 根地址');
    }
  }
  const hosts = new Set([origin.host.toLowerCase()]);
  for (const host of (env.ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.:[\]-]+$/.test(host)) throw new Error('ALLOWED_HOSTS 只接受域名或 IP，可带端口，不接受通配符');
    hosts.add(host);
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
  return {
    host: env.HOST || '0.0.0.0', port, origin: origin.origin,
    secureCookies: origin.protocol === 'https:', hosts,
    dataDir: env.DATA_DIR || './data/panel',
    username: env.ADMIN_USER || 'admin', password: secret(env, 'ADMIN_PASSWORD'),
    desktopPassword: secret(env, 'DESKTOP_PASSWORD'), agentSecret: secret(env, 'AGENT_SECRET'),
    desktopUrl: desktopUrl.origin, agentUrl: agentUrl.origin,
    // Only the private Kasm endpoint uses a self-signed certificate.
    desktopTlsVerify: env.DESKTOP_TLS_VERIFY !== 'false',
    sessionMs: 7 * 24 * 60 * 60 * 1000,
  };
}
