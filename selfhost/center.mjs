import http from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, cookieToken, sessionCookie } from '../panel/auth.mjs';
import { SelfhostRegistry } from './registry.mjs';
import { selfhostError } from './protocol.mjs';
import { TURN_TTL_MS, turnCredentials } from './turn.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const BODY_LIMIT = 16 * 1024, PLUGIN_LIMIT = 128 * 1024;

function reply(res, status, value, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

async function jsonBody(req, limit) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw selfhostError(415, '请使用 JSON 请求');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw selfhostError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw selfhostError(400, 'JSON 格式无效'); }
}

async function assets() {
  const result = new Map(); let total = 0;
  for (const [route, [name, type]] of ASSETS) {
    const handle = await open(join(PUBLIC, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512 * 1024 || stat.mode & 0o022) throw Error('中心前端资源权限或大小无效');
      bytes = await handle.readFile();
      if (bytes.length !== stat.size || bytes.length > 512 * 1024) throw Error('中心前端资源正在修改或超过限制');
    } finally { await handle.close(); }
    total += bytes.length; if (total > 1024 * 1024) throw Error('中心前端资源超过 1 MiB');
    result.set(route, { bytes, type });
  }
  return result;
}

const loopback = address => /^(?:::ffff:)?127\.0\.0\.1$/.test(address || '') || address === '::1';
const ip = req => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

export async function createSelfhostCenter({
  origin, host = '127.0.0.1', port = 36180, dataDir, stateFile = join(dataDir, 'state.json'),
  username = 'admin', password, publicHost = new URL(origin).hostname, frpServerPort = 7000, frpTlsServerName = publicHost,
  frpToken, turnSecret, turnRealm = publicHost, turnTtlMs = TURN_TTL_MS, closeTunnel = async () => {}, sessionMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error('中心 PUBLIC_ORIGIN 必须是 HTTP(S) 根地址');
  if (!password || typeof password !== 'string' || password.length < 16 || password.length > 512) throw Error('中心管理员密码长度无效');
  if (!frpToken || typeof frpToken !== 'string' || frpToken.length < 16 || frpToken.length > 512 || /[\r\n\0]/.test(frpToken)) throw Error('frp 接入密钥长度无效');
  const authConfig = { dataDir, username, password, sessionMs, secureCookies: parsed.protocol === 'https:', nodeId: 'center', entryBasePath: '/' };
  const auth = await createAuth(authConfig), web = await assets();
  const registry = await new SelfhostRegistry({ file: stateFile, host: publicHost, onClose: closeTunnel }).open();
  const failures = new Map(), joins = new Map();
  const allowedHosts = new Set([parsed.host.toLowerCase()]);
  const internalHosts = new Set([`127.0.0.1:${Number(port)}`, `localhost:${Number(port)}`]);
  let closing = false, timer;

  const hostAllowed = req => allowedHosts.has(String(req.headers.host || '').toLowerCase()) || loopback(req.socket.remoteAddress) && internalHosts.has(String(req.headers.host || '').toLowerCase());
  const originAllowed = req => req.headers.origin === parsed.origin;
  const session = req => auth.get(cookieToken(req.headers.cookie, authConfig));
  const requireSession = req => {
    const value = session(req); if (!value) throw selfhostError(401, '请先登录中心管理页');
    return value;
  };
  const requireWrite = (req, value = requireSession(req)) => {
    if (!originAllowed(req)) throw selfhostError(403, '请求来源无效');
    if (req.headers['x-csrf-token'] !== value.csrf) throw selfhostError(403, '请求验证失败，请刷新后重试');
    return value;
  };
  const rate = (map, key, limit, windowMs, now = Date.now()) => {
    const previous = map.get(key), value = previous?.until > now ? previous : { count: 0, until: now + windowMs };
    value.count++; map.set(key, value);
    if (map.size > 1024) map.delete(map.keys().next().value);
    if (value.count > limit) throw selfhostError(429, '请求过于频繁，请稍后再试');
  };

  async function plugin(req, res) {
    if (!loopback(req.socket.remoteAddress)) throw selfhostError(403, '内部接口不可公开访问');
    const url = new URL(req.url, 'http://internal'), body = await jsonBody(req, PLUGIN_LIMIT), content = body.content || {};
    if (process.env.SELFHOST_PLUGIN_DEBUG === '1') {
      console.error('[selfhost-plugin]', JSON.stringify({ op: url.searchParams.get('op'), keys: Object.keys(content), proxy: content.proxy_name, type: content.proxy_type, domains: content.custom_domains, locations: content.locations, metaKeys: content.metas ? Object.keys(content.metas) : content.user?.metas ? Object.keys(content.user.metas) : [], runId: content.run_id || content.user?.run_id || '' }));
    }
    const allowed = await (async () => {
      if (url.searchParams.get('op') === 'Login') return registry.authorizeLogin({ metas: content.metas, runId: content.run_id, source: content.client_address });
      if (url.searchParams.get('op') === 'NewProxy') return registry.authorizeProxy({ metas: content.user?.metas, runId: content.user?.run_id, name: content.proxy_name, type: content.proxy_type, host: content.custom_domains?.[0], locations: content.locations });
      if (url.searchParams.get('op') === 'Ping') return registry.authorizePing({ metas: content.user?.metas, runId: content.user?.run_id });
      if (url.searchParams.get('op') === 'CloseProxy') { await registry.closeProxy({ metas: content.user?.metas, runId: content.user?.run_id }); return true; }
      return false;
    })();
    return reply(res, 200, allowed ? { reject: false, unchange: true } : { reject: true, reject_reason: '节点授权无效、已撤销或名称已占用' });
  }

  async function route(req, res) {
    if (!hostAllowed(req)) throw selfhostError(400, '访问域名未配置');
    const url = new URL(req.url, 'http://internal'), path = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    if (parsed.protocol === 'https:') res.setHeader('strict-transport-security', 'max-age=31536000');
    if (path === '/internal/frp-plugin') {
      if (req.method !== 'POST') throw selfhostError(405, '只允许 POST');
      return plugin(req, res);
    }
    if (path === '/internal/route-auth' && req.method === 'GET') {
      if (!loopback(req.socket.remoteAddress)) throw selfhostError(403, '内部接口不可公开访问');
      const requestPath = url.searchParams.get('path') || '', matched = requestPath.match(/^\/node\/([a-z0-9-]{1,48})\//);
      if (!matched) throw selfhostError(404, '节点路径不存在');
      const allowed = await registry.routeAllowed(matched[1]);
      res.writeHead(allowed ? 204 : 503, { 'cache-control': 'no-store', ...(allowed ? {} : { 'x-selfhost-node': 'offline' }) });
      return res.end();
    }
    if (path === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path === '/api/login' && req.method === 'POST') {
      if (!originAllowed(req)) throw selfhostError(403, '请求来源无效');
      const client = ip(req); rate(failures, client, 8, 15 * 60_000);
      const body = await jsonBody(req, 4096), valid = await auth.verify(body.username, body.password);
      if (!valid) throw selfhostError(401, '管理员用户名或密码错误');
      failures.delete(client);
      const created = await auth.create({ role: 'admin' });
      return reply(res, 200, { ok: true, csrf: created.session.csrf, username }, { 'set-cookie': sessionCookie(created.token, authConfig) });
    }
    if (path === '/api/join' && req.method === 'POST') {
      rate(joins, ip(req), 60, 60_000);
      const body = await jsonBody(req, 8192);
      const joined = await registry.join({ ...body, source: ip(req) });
      return reply(res, 200, { ...joined, origin: parsed.origin, proxyHost: publicHost, turnEndpoint: turnSecret ? parsed.origin + '/api/turn-credentials' : null, frp: { serverAddr: publicHost, serverPort: frpServerPort, tlsServerName: frpTlsServerName, token: frpToken } });
    }
    if (path === '/api/turn-credentials' && req.method === 'POST') {
      if (!turnSecret) throw selfhostError(503, 'TURN 尚未启用');
      rate(joins, ip(req), 120, 60_000);
      const body = await jsonBody(req, 4096), allowed = await registry.turnAuthorized(body);
      if (!allowed) throw selfhostError(401, '节点授权、连接状态或凭据无效');
      return reply(res, 200, turnCredentials({ secret: turnSecret, slug: body.slug, realm: turnRealm, ttlMs: turnTtlMs }));
    }
    if (path === '/api/leave' && req.method === 'POST') {
      rate(joins, ip(req), 60, 60_000);
      return reply(res, 200, await registry.leave(await jsonBody(req, 4096)));
    }

    const asset = web.get(path);
    if (asset && req.method === 'GET') {
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes.length, 'cache-control': 'no-store' });
      return res.end(asset.bytes);
    }

    const current = requireSession(req);
    if (path === '/api/me' && req.method === 'GET') return reply(res, 200, { username, csrf: current.csrf, host: parsed.host });
    if (path === '/api/logout' && req.method === 'POST') {
      requireWrite(req, current); await auth.revoke(cookieToken(req.headers.cookie, authConfig));
      return reply(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', authConfig, true) });
    }
    if (path === '/api/status' && req.method === 'GET') return reply(res, 200, { ...await registry.status(), host: parsed.host, turn: !!turnSecret });
    if (path === '/api/keys' && req.method === 'GET') return reply(res, 200, { revision: (await registry.status()).revision, keys: await registry.list() });
    if (path === '/api/keys' && req.method === 'POST') {
      requireWrite(req, current); const body = await jsonBody(req, 4096), value = await registry.createKey(body);
      return reply(res, 201, value);
    }
    const key = path.match(/^\/api\/keys\/([a-f0-9]{32})$/), node = path.match(/^\/api\/nodes\/([a-z0-9-]{1,48})\/disconnect$/);
    if (key && req.method === 'DELETE') { requireWrite(req, current); await jsonBody(req, 1024); return reply(res, 200, await registry.revoke(key[1])); }
    if (node && req.method === 'POST') { requireWrite(req, current); await jsonBody(req, 1024); return reply(res, 200, await registry.disconnect(node[1])); }
    throw selfhostError(404, '资源不存在');
  }

  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (!error.status) console.error(`[selfhost] ${error.name}: request failed`);
    reply(res, error.status || 503, { error: error.status ? error.message : '中心服务暂时不可用', outcome: 'rejected' });
  }));
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64; server.maxConnections = 256;
  timer = setInterval(() => { if (!closing) void registry.sweep().catch(() => {}); }, 5000); timer.unref();
  return {
    server, registry,
    async close() {
      if (closing) return; closing = true; clearInterval(timer);
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await auth.close();
    },
  };
}
