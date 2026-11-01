import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createAuth, cookieToken, sessionCookie, equal } from './auth.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);
const MAX_UPLOAD = 50 * 1024 * 1024;
const VIEWER = /^[a-f0-9-]{16,64}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function jsonBody(req, limit = 128 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  }
  catch { throw new HttpError(400, 'JSON 格式无效'); }
}
function reply(res, status, data, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

export async function createPanel(config) {
  const auth = await createAuth(config);
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [file, type]]) => [route, { bytes: await readFile(new URL(file, PUBLIC)), type }])));
  const failures = new Map();
  const sockets = new Map();
  let owner = null;
  let loginBusy = 0;
  let healthCache = null;

  const hostAllowed = req => config.hosts.has(String(req.headers.host || '').toLowerCase());
  const originAllowed = req => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return false;
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.host.toLowerCase() !== String(req.headers.host).toLowerCase()) return false;
      return origin === config.origin || (!config.secureCookies && url.protocol === 'http:' && hostAllowed(req));
    } catch { return false; }
  };
  const sessionOf = req => auth.get(cookieToken(req.headers.cookie));
  const requireSession = req => {
    const session = sessionOf(req);
    if (!session) throw new HttpError(401, '登录已失效，请重新登录');
    return session;
  };
  const requireWrite = req => {
    const session = requireSession(req);
    if (!originAllowed(req) || !equal(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, '请求验证失败，请刷新页面');
    return session;
  };
  const requireOwner = req => {
    const session = requireWrite(req);
    if (!owner || owner.viewer !== req.headers['x-viewer-id'] || owner.session !== session.hash) throw new HttpError(409, '桌面已在另一页面打开，请先接管');
    return session;
  };
  function closeSockets(predicate) {
    for (const [socket, state] of sockets) if (predicate(state)) socket.destroy();
  }
  async function agent(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(`${config.agentUrl}${path}`, {
      method, signal: signal || AbortSignal.timeout(6000),
      headers: { authorization: `Bearer ${config.agentSecret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new HttpError(response.status, data.error || '桌面操作失败');
    return data;
  }
  async function desktopHealth() {
    if (healthCache && healthCache.at > Date.now() - 3000) return healthCache.promise;
    const promise = (async () => {
      try {
        const result = await agent('/health', { signal: AbortSignal.timeout(2500) });
        return { ready: result.ready === true, version: result.version || '', message: result.ready ? '桌面已就绪' : '桌面正在启动' };
      } catch { return { ready: false, version: '', message: '正在等待桌面服务，任务不会因网页断开而停止' }; }
    })();
    healthCache = { at: Date.now(), promise };
    return promise;
  }

  const upstreamAgent = config.desktopUrl.startsWith('https:') ? new https.Agent({ rejectUnauthorized: config.desktopTlsVerify, keepAlive: true }) : new http.Agent({ keepAlive: true });
  function cleanProxyRequest(proxyReq) {
    proxyReq.removeHeader('cookie');
    proxyReq.removeHeader('x-csrf-token');
    proxyReq.removeHeader('x-viewer-id');
    proxyReq.removeHeader('cf-access-jwt-assertion');
    proxyReq.removeHeader('cf-access-authenticated-user-email');
    proxyReq.setHeader('authorization', `Basic ${Buffer.from(`kasm_user:${config.desktopPassword}`).toString('base64')}`);
    // Bound only the initial upstream response/upgrade, not an idle desktop session.
    proxyReq.setTimeout(20_000, () => proxyReq.destroy());
    proxyReq.once('response', () => proxyReq.setTimeout(0));
    proxyReq.once('upgrade', () => proxyReq.setTimeout(0));
  }
  const proxy = createProxyMiddleware({
    target: config.desktopUrl, changeOrigin: true, ws: false,
    agent: upstreamAgent, secure: config.desktopTlsVerify,
    pathRewrite: path => {
      const url = new URL(path, 'http://internal');
      url.searchParams.delete('viewer');
      return url.pathname.slice('/desktop'.length) + url.search;
    },
    on: {
      proxyReq: cleanProxyRequest,
      proxyReqWs(proxyReq, _req, socket) {
        cleanProxyRequest(proxyReq);
        proxyReq.once('upgrade', (_response, upstream) => {
          upstream.setKeepAlive(true, 30_000);
          socket.once('close', () => upstream.destroy());
        });
      },
      proxyRes(proxyRes) {
        delete proxyRes.headers['set-cookie'];
        delete proxyRes.headers['www-authenticate'];
        const location = proxyRes.headers.location;
        if (location) {
          try {
            const url = new URL(location, config.desktopUrl);
            if (url.origin === config.desktopUrl) proxyRes.headers.location = `/desktop${url.pathname}${url.search}${url.hash}`;
            else delete proxyRes.headers.location;
          } catch { delete proxyRes.headers.location; }
        }
        proxyRes.headers['cache-control'] = 'no-store';
      },
      error(_error, _req, res) {
        if (typeof res.writeHead === 'function') reply(res, 502, { error: '桌面尚未就绪，请稍后重新连接' });
        else res.destroy();
      },
    },
  });

  async function route(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    if (!hostAllowed(req)) throw new HttpError(400, '访问域名未配置，请检查 PUBLIC_ORIGIN / ALLOWED_HOSTS');
    const url = new URL(req.url, 'http://internal');
    const path = url.pathname;
    if (path === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path === '/api/login' && req.method === 'POST') {
      if (!originAllowed(req)) throw new HttpError(403, '请求来源无效');
      const key = req.socket.remoteAddress || 'unknown'; // Never trust client-supplied forwarding headers.
      const failure = failures.get(key);
      if (failure && failure.until > Date.now() && failure.count >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后再试');
      if (loginBusy >= 2) throw new HttpError(429, '正在验证登录，请稍后再试');
      const body = await jsonBody(req, 4096);
      let verified;
      loginBusy++;
      try { verified = await auth.verify(body.username, body.password); }
      finally { loginBusy--; }
      if (!verified) {
        const current = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 900_000 };
        current.count++; failures.set(key, current);
        if (failures.size > 1024) failures.delete(failures.keys().next().value);
        throw new HttpError(401, '用户名或密码错误');
      }
      failures.delete(key);
      const { token, session } = await auth.create();
      return reply(res, 200, { username: config.username, csrf: session.csrf }, { 'set-cookie': sessionCookie(token, config) });
    }
    if (path === '/api/me' && req.method === 'GET') {
      const session = requireSession(req);
      return reply(res, 200, { username: config.username, csrf: session.csrf });
    }
    if (path === '/api/logout' && req.method === 'POST') {
      const session = requireWrite(req);
      await auth.revoke(cookieToken(req.headers.cookie));
      closeSockets(state => state.session === session.hash);
      if (owner?.session === session.hash) owner = null;
      return reply(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', config, true) });
    }
    if (path === '/api/state' && req.method === 'GET') {
      const session = requireSession(req);
      const desktop = await desktopHealth();
      return reply(res, 200, { desktop, mine: !!owner && owner.session === session.hash && owner.viewer === req.headers['x-viewer-id'] });
    }
    if (path === '/api/desktop/claim' && req.method === 'POST') {
      const session = requireWrite(req);
      const { viewer } = await jsonBody(req, 1024);
      if (typeof viewer !== 'string' || !VIEWER.test(viewer)) throw new HttpError(400, '页面标识无效');
      if (owner?.viewer !== viewer || owner?.session !== session.hash) closeSockets(() => true);
      owner = { viewer, session: session.hash };
      return reply(res, 200, { ok: true });
    }
    if (['/api/paste', '/api/key', '/api/terminal'].includes(path) && req.method === 'POST') {
      requireOwner(req);
      const body = await jsonBody(req);
      return reply(res, 200, await agent(path.replace('/api', ''), { method: 'POST', body }));
    }
    if (path === '/api/files' && req.method === 'GET') {
      requireSession(req);
      return reply(res, 200, await agent('/files'));
    }
    if (path.startsWith('/api/files/') && ['GET', 'PUT'].includes(req.method)) {
      if (req.method === 'PUT') requireWrite(req); else requireSession(req);
      const encoded = path.slice('/api/files/'.length);
      let name;
      try { name = decodeURIComponent(encoded); } catch { throw new HttpError(400, '文件名无效'); }
      if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 240) throw new HttpError(400, '文件名无效');
      if (req.method === 'PUT') {
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UPLOAD) throw new HttpError(413, '文件大小必须明确，且不能超过 50 MiB');
        const limiter = new Transform({ transform(chunk, _encoding, callback) { this.total = (this.total || 0) + chunk.length; callback(this.total > MAX_UPLOAD ? new Error('文件过大') : null, chunk); } });
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        const response = await fetch(`${config.agentUrl}/files/${encodeURIComponent(name)}`, {
          method: 'PUT', headers: { authorization: `Bearer ${config.agentSecret}`, 'content-length': String(length), 'content-type': 'application/octet-stream' },
          body: req.pipe(limiter), duplex: 'half', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
        });
        return reply(res, response.status, await response.json());
      }
      const response = await fetch(`${config.agentUrl}/files/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${config.agentSecret}` }, signal: AbortSignal.timeout(300_000) });
      if (!response.ok) return reply(res, response.status, await response.json());
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, ...(response.headers.has('content-length') ? { 'content-length': response.headers.get('content-length') } : {}) });
      await pipeline(response.body, res);
      return;
    }
    if (path.startsWith('/desktop/')) {
      requireSession(req);
      if (!['GET', 'HEAD'].includes(req.method) && !originAllowed(req)) throw new HttpError(403, '请求来源无效');
      if (req.headers.authorization) delete req.headers.authorization;
      proxy(req, res, error => error ? reply(res, 502, { error: '桌面连接失败' }) : reply(res, 404, { error: '资源不存在' }));
      return;
    }
    const asset = assets.get(path);
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes.length, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    }
    throw new HttpError(404, '资源不存在');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (!error.status) console.error(`[panel] ${error.name}: request failed`); // No bodies, cookies or credentials.
      reply(res, error.status || 502, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
    });
  });
  server.requestTimeout = 310_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 64;
  server.on('upgrade', (req, socket, head) => {
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!hostAllowed(req) || !originAllowed(req)) return deny(403);
    const session = sessionOf(req);
    if (!session) return deny(401);
    const url = new URL(req.url, 'http://internal');
    if (url.pathname !== '/desktop/websockify') return deny(404);
    if (!owner || owner.session !== session.hash || owner.viewer !== url.searchParams.get('viewer')) return deny(409);
    sockets.set(socket, { session: session.hash, token: cookieToken(req.headers.cookie) });
    socket.once('close', () => sockets.delete(socket));
    socket.setKeepAlive(true, 30_000);
    proxy.upgrade(req, socket, head);
  });
  const expiration = setInterval(() => {
    closeSockets(state => !auth.get(state.token));
  }, 10_000).unref();
  async function close() {
    clearInterval(expiration);
    closeSockets(() => true);
    upstreamAgent.destroy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await auth.close();
  }
  return { server, close };
}
