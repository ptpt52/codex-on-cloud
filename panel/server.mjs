import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createAuth, cookieToken, sessionCookie, equal } from './auth.mjs';
import { createTunnelDiagnostics } from './diagnostics.mjs';
import { managerRequest } from './manager-client.mjs';
import { createRTCBridge, rtcOffer, rtcAddress, rtcIPv6Address } from './rtc.mjs';
import { validateInput } from '../native/input.mjs';
import { clipboardSource } from '../native/clipboard.mjs';
import { terminalTarget } from '../native/terminals.mjs';
import { attachTerminal } from './terminal-bridge.mjs';
import { attachRTCTerminal } from './rtc-terminal.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const NOVNC = resolve(fileURLToPath(new URL('../node_modules/@novnc/novnc/', import.meta.url)));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/control.js', ['control.js', 'text/javascript; charset=utf-8']],
  ['/shortcuts.js', ['shortcuts.js', 'text/javascript; charset=utf-8']],
  ['/shortcut-menu.js', ['shortcut-menu.js', 'text/javascript; charset=utf-8']],
  ['/health.js', ['health.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/desktop/index.html', ['viewer.html', 'text/html; charset=utf-8']],
  ['/desktop/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/desktop/rtc.js', ['rtc.js', 'text/javascript; charset=utf-8']],
  ['/desktop/rtc-stats.js', ['rtc-stats.js', 'text/javascript; charset=utf-8']],
  ['/desktop/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
  ['/terminal/index.html', ['terminal.html', 'text/html; charset=utf-8']],
  ['/terminal/terminal.js', ['terminal.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-health.js', ['terminal-health.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-rtc.js', ['terminal-rtc.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-history.js', ['terminal-history.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal.css', ['terminal.css', 'text/css; charset=utf-8']],
  ['/terminal/xterm.js', ['../../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['/terminal/fit.js', ['../../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8']],
  ['/terminal/xterm.css', ['../../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
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
  const tunnelDiagnostics = createTunnelDiagnostics(config.tunnelDiagnosticsUrl);
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [file, type]]) => [route, { bytes: await readFile(new URL(file, PUBLIC)), type }])));
  const failures = new Map();
  const sockets = new Map();
  let owner = null;
  let loginBusy = 0;
  let healthCache = null;
  let maintenancePending = false;
  let closing = false;
  let rtcBusy = false;
  let rtcClosing = Promise.resolve();

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
  async function ownedBody(req, limit) {
    requireOwner(req);
    const expected = owner;
    const body = await jsonBody(req, limit);
    requireOwner(req);
    if (owner !== expected) throw new HttpError(409, '页面控制权已变化，请重新操作');
    return body;
  }
  async function controlStatus() {
    try { const status = await managerRequest(config, '/status', undefined, 1500); return { ...status, maintenance: maintenancePending || status.maintenance }; }
    catch { return { available: false, maintenance: maintenancePending, inputBusy: false }; }
  }
  async function terminalAvailable(target) {
    const catalog = await managerRequest(config, '/terminals');
    return catalog.terminals.some(item => item.id === target.terminalId && item.token === target.terminalToken && item.supported);
  }
  const terminalOptions = (target, valid) => ({ ...target, socketPath: config.terminalSocket, env: config.terminalEnv, valid,
    verify: () => terminalAvailable(target),
    readClipboard: async () => { const result = await managerRequest(config, '/clipboard', { source: 'clipboard' }); if (!valid()) throw new Error('控制权已变化'); return result.text; },
    launch: config.terminalLaunch ? () => config.terminalLaunch(target) : undefined });
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
        return { ready: result.ready === true, version: result.version || '', transferDir: config.transferDir || '', message: result.ready ? '桌面已就绪' : '桌面正在启动' };
      } catch { return { ready: false, version: '', message: '正在等待桌面服务，任务不会因网页断开而停止' }; }
    })();
    healthCache = { at: Date.now(), promise };
    return promise;
  }

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });

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
      const body = await jsonBody(req, 4096);
      // No await between checking the current limits and reserving a verification slot.
      const failure = failures.get(key);
      if (failure && failure.until > Date.now() && failure.count >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后再试');
      if (loginBusy >= 2) throw new HttpError(429, '正在验证登录，请稍后再试');
      let verified;
      loginBusy++;
      try { verified = await auth.verify(body.username, body.password); }
      finally { loginBusy--; }
      if (!verified) {
        const latest = failures.get(key);
        const current = latest && latest.until > Date.now() ? latest : { count: 0, until: Date.now() + 900_000 };
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
      return reply(res, 200, { username: config.username, csrf: session.csrf, webrtc: config.webrtc === true,
        rtcStunUrl: config.webrtc && config.webrtcIPv6 ? config.webrtcStunUrl || '' : '' });
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
      const [desktop, controls] = await Promise.all([desktopHealth(), controlStatus()]);
      return reply(res, 200, { desktop, controls, mine: !!owner && owner.session === session.hash && owner.viewer === req.headers['x-viewer-id'] });
    }
    if (path === '/api/diagnostics' && req.method === 'GET') {
      requireSession(req);
      return reply(res, 200, { tunnel: await tunnelDiagnostics() });
    }
    if (path === '/api/desktop/settings' && req.method === 'GET') {
      requireSession(req);
      return reply(res, 200, await managerRequest(config, '/settings'));
    }
    if (path === '/api/terminals' && req.method === 'GET') {
      requireSession(req);
      return reply(res, 200, await managerRequest(config, '/terminals'));
    }
    if (path === '/api/terminals' && req.method === 'POST') {
      const body = await ownedBody(req, 1024);
      if (maintenancePending) throw new HttpError(409, '桌面操作正在进行，本次终端操作未发送');
      return reply(res, 200, await managerRequest(config, '/terminals', body));
    }
    if (['/api/desktop/viewport', '/api/desktop/resolution'].includes(path) && req.method === 'POST') {
      const body = await ownedBody(req, 1024);
      if (maintenancePending) throw new HttpError(409, '桌面操作正在进行');
      const live = path.endsWith('/resolution');
      return reply(res, 200, await managerRequest(config, live ? '/resolution' : '/viewport', body, live ? 9000 : 6000));
    }
    if (['/api/desktop/settings', '/api/desktop/apply', '/api/desktop/terminal-display'].includes(path) && req.method === 'POST') {
      const body = await ownedBody(req, 1024);
      const target = path.endsWith('/apply') ? '/apply' : path.endsWith('/terminal-display') ? '/terminal' : '/settings';
      const pausesInput = target === '/apply' || (target === '/terminal' && body.action === 'font');
      if (pausesInput && maintenancePending) throw new HttpError(409, '已有桌面操作进行中');
      if (pausesInput) { maintenancePending = true; closeSockets(() => true); }
      try {
        const result = await managerRequest(config, target, body);
        if (pausesInput) closeSockets(() => true);
        return reply(res, 200, result);
      } finally { if (pausesInput) maintenancePending = false; }
    }
    if (path === '/api/desktop/claim' && req.method === 'POST') {
      const session = requireWrite(req);
      const { viewer } = await jsonBody(req, 1024);
      requireWrite(req); // Revoked/expired sessions cannot claim through a delayed body.
      if (typeof viewer !== 'string' || !VIEWER.test(viewer)) throw new HttpError(400, '页面标识无效');
      if (owner?.viewer !== viewer || owner?.session !== session.hash) closeSockets(() => true);
      owner = { viewer, session: session.hash };
      return reply(res, 200, { ok: true });
    }
    if (['/api/desktop/rtc', '/api/terminal/rtc'].includes(path) && req.method === 'POST') {
      const terminalMode = path === '/api/terminal/rtc';
      const expected = owner;
      const body = await ownedBody(req, 48 * 1024);
      if (!config.webrtc) throw new HttpError(404, '未启用桌面直连');
      let offer;
      try { offer = rtcOffer(body, { ipv6: config.webrtcIPv6 === true }); } catch (error) { throw new HttpError(400, error.message); }
      let target;
      if (terminalMode) {
        try { target = terminalTarget(body); if (!target.terminalId) throw new Error(); }
        catch { throw new HttpError(400, '终端目标无效'); }
      }
      if (rtcBusy) throw new HttpError(429, '连接协商正在进行');
      rtcBusy = true;
      let bridge;
      try {
        const controls = await controlStatus();
        await rtcClosing;
        requireOwner(req);
        if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '页面控制权已变化');
        if (!controls.available || controls.maintenance || maintenancePending) throw new HttpError(503, '桌面暂不可连接');
        if (terminalMode && !await terminalAvailable(target)) throw new HttpError(409, '终端目标已变化');
        requireOwner(req);
        if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '页面控制权已变化');
        // A candidate may negotiate while the current stream stays usable.
        closeSockets(state => state.rtcPending === true);
        await rtcClosing;
        requireOwner(req);
        if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '页面控制权已变化');
        const token = cookieToken(req.headers.cookie);
        const state = { session: expected.session, token, socket: null, rtcPending: true };
        let terminalSession;
        if (terminalMode) state.inputIdle = () => terminalSession?.idle === true;
        const valid = () => !closing && !maintenancePending && owner === expected && !!auth.get(token) && sockets.get(bridge) === state;
        const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress;
        const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
        bridge = createRTCBridge({ address, ipv6Address, vncSocket: config.vncSocket, valid,
          ...(terminalMode ? { connectTerminal: (channel, authorized, fail) => {
            terminalSession = attachRTCTerminal(channel, terminalOptions(target, authorized), fail); return terminalSession;
          } } : {}),
          performControl: async (action, body, live) => {
            if (!valid()) throw new HttpError(409, '页面控制权已变化，本次操作未发送');
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '控制参数无效');
            if (action === 'ping') return { ready: true };
            if (action === 'activate') {
              if (!state.rtcPending) return { active: true };
              const current = await controlStatus();
              if (terminalMode && !await terminalAvailable(target)) throw new HttpError(409, '终端目标已变化');
              if (!valid() || !live()) throw new HttpError(409, '页面控制权或连接已变化');
              if (!current.available || current.maintenance || current.inputBusy || current.clipboardBusy || current.viewportBusy) throw new HttpError(409, '当前操作未结束，暂不切换连接');
              for (const value of sockets.values()) if (value !== state && value.inputIdle && !value.inputIdle()) throw new HttpError(409, '终端输入尚未完成，暂不切换连接');
              closeSockets(value => value.socket !== bridge);
              state.rtcPending = false;
              bridge.activate();
              return { active: true };
            }
            if (terminalMode) throw new HttpError(400, '文字输入需通过终端通道执行');
            if (state.rtcPending) throw new HttpError(409, '直连尚未启用，本次操作未发送');
            if (action === 'clipboard') {
              const source = clipboardSource(body.source);
              const result = await managerRequest(config, '/clipboard', { source });
              if (!valid()) throw new HttpError(409, '页面控制权已变化，请重新读取');
              return result;
            }
            if (!['paste', 'key'].includes(action)) throw new HttpError(400, '不支持的直连动作');
            let input;
            try { input = validateInput({ ...body, action }); } catch (error) { throw new HttpError(400, error.message); }
            try { return await managerRequest(config, '/input', input); }
            catch (error) { error.outcome ||= 'unknown'; throw error; }
          },
          closed: () => sockets.delete(bridge) });
        // Use the same revocation, maintenance, expiry and takeover path as WS.
        const destroy = bridge.destroy;
        bridge.destroy = () => { const result = destroy(); rtcClosing = result || rtcClosing; return result; };
        state.socket = bridge;
        sockets.set(bridge, state);
        res.once('close', () => { if (!res.writableFinished) void bridge.destroy(); });
        const answer = await bridge.answer(offer);
        requireOwner(req);
        if (!valid()) throw new HttpError(409, '页面控制权已变化');
        return reply(res, 200, answer);
      } catch (error) {
        await bridge?.destroy();
        if (!sessionOf(req)) throw new HttpError(401, '登录已失效');
        if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '连接协商已取消');
        throw error;
      }
      finally { rtcBusy = false; }
    }
    if (['/api/paste', '/api/key', '/api/terminal'].includes(path) && req.method === 'POST') {
      const body = await ownedBody(req);
      if (maintenancePending) throw new HttpError(409, '桌面操作正在进行，本次输入未发送');
      try { return reply(res, 200, await managerRequest(config, '/input', { ...body, action: path.slice('/api/'.length) })); }
      catch (error) { error.outcome ||= 'unknown'; throw error; }
    }
    if (path === '/api/clipboard/read' && req.method === 'POST') {
      const expected = owner;
      const body = await ownedBody(req, 1024);
      requireOwner(req);
      if (owner !== expected) throw new HttpError(409, '页面控制权已变化，请重新读取');
      if (maintenancePending) throw new HttpError(409, '桌面操作正在进行，请稍后手动读取');
      const result = await managerRequest(config, '/clipboard', body);
      requireOwner(req);
      if (owner !== expected) throw new HttpError(409, '页面控制权已变化，请重新读取');
      return reply(res, 200, result);
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
    if (path.startsWith('/desktop/') || path.startsWith('/terminal/')) {
      requireSession(req);
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '只允许读取桌面资源');
      if (path.startsWith('/desktop/novnc/')) {
        let relative;
        try { relative = decodeURIComponent(path.slice('/desktop/novnc/'.length)); } catch { throw new HttpError(400, '资源路径无效'); }
        if (!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(relative)) throw new HttpError(404, '资源不存在');
        const file = resolve(NOVNC, relative);
        if (!file.startsWith(NOVNC + sep) || relative.split('/').includes('..')) throw new HttpError(404, '资源不存在');
        let bytes;
        try { bytes = await readFile(file); } catch { throw new HttpError(404, '资源不存在'); }
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
    }
    const asset = assets.get(path);
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'${path.startsWith('/terminal/') ? " 'unsafe-inline'" : ''}; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`);
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes.length, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    }
    throw new HttpError(404, '资源不存在');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (!error.status) console.error(`[panel] ${error.name}: request failed`); // No bodies, cookies or credentials.
      reply(res, error.status || 502, { error: error.status ? error.message : '服务暂时不可用，请稍后重试', outcome: error.outcome || (error.status ? 'rejected' : 'unknown') });
    });
  });
  server.requestTimeout = 310_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 64;
  async function upgrade(req, socket, head) {
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!hostAllowed(req) || !originAllowed(req)) return deny(403);
    const session = sessionOf(req);
    if (!session) return deny(401);
    const url = new URL(req.url, 'http://internal');
    const terminalMode = url.pathname === '/terminal/connect';
    if (url.pathname !== '/desktop/websockify' && !terminalMode) return deny(404);
    if (!owner || owner.session !== session.hash || owner.viewer !== url.searchParams.get('viewer')) return deny(409);
    const expected = owner;
    const controls = await controlStatus();
    if (closing || socket.destroyed) { socket.destroy(); return; }
    if (!sessionOf(req)) return deny(401);
    if (owner !== expected) return deny(409);
    if (!controls.available || controls.maintenance) return deny(503);
    if (terminalMode) {
      let target;
      try { target = terminalTarget({ terminalId: url.searchParams.get('terminalId'), terminalToken: url.searchParams.get('terminalToken') }); }
      catch { return deny(400); }
      const currentTarget = () => terminalAvailable(target);
      if (!await currentTarget()) return deny(409);
      if (owner !== expected || !sessionOf(req) || closing || maintenancePending || socket.destroyed) return deny(409);
      closeSockets(state => state.socket !== socket);
      const state = { session: session.hash, token: cookieToken(req.headers.cookie), socket };
      let terminalSession; state.inputIdle = () => terminalSession?.idle === true;
      sockets.set(socket, state); socket.once('close', () => sockets.delete(socket));
      const valid = () => owner === expected && sockets.get(socket) === state && !!auth.get(state.token) && !closing && !maintenancePending;
      terminalWss.handleUpgrade(req, socket, head, ws => {
        const timer = setTimeout(() => ws.terminate(), 2500).unref();
        ws.once('close', () => clearTimeout(timer));
        ws.once('message', (bytes, binary) => {
          clearTimeout(timer);
          let first;
          try { if (binary || bytes.length > 1024) throw new Error(); first = JSON.parse(bytes.toString('utf8')); } catch { return ws.terminate(); }
          if (!valid() || first?.type !== 'auth' || typeof first.csrf !== 'string' || !equal(first.csrf, session.csrf)) return ws.terminate();
          terminalSession = attachTerminal(ws, terminalOptions(target, valid));
        });
      });
      return;
    }
    // One stream per owner. Reconnecting the same viewer also closes its previous stream.
    closeSockets(state => state.socket !== socket);
    sockets.set(socket, { session: session.hash, token: cookieToken(req.headers.cookie), socket });
    socket.once('close', () => sockets.delete(socket));
    socket.setKeepAlive(true, 30_000);
    wss.handleUpgrade(req, socket, head, ws => {
      // Only VNC bytes cross this bridge; no HTTP headers or credentials reach the desktop.
      const upstream = net.createConnection(config.vncSocket);
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
      const timer = setTimeout(() => upstream.destroy(), 5000).unref();
      upstream.once('connect', () => clearTimeout(timer));
      upstream.once('close', () => { clearTimeout(timer); ws.terminate(); });
      stream.once('close', () => upstream.destroy());
      stream.on('error', () => upstream.destroy());
      upstream.on('error', () => ws.terminate());
      upstream.pipe(stream).pipe(upstream);
    });
  }
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head).catch(() => socket.destroy()); });
  const expiration = setInterval(() => {
    closeSockets(state => !auth.get(state.token));
  }, 10_000).unref();
  async function close() {
    closing = true;
    clearInterval(expiration);
    closeSockets(() => true);
    await rtcClosing;
    for (const client of wss.clients) client.terminate();
    wss.close();
    for (const client of terminalWss.clients) client.terminate();
    terminalWss.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await auth.close();
  }
  return { server, close };
}
