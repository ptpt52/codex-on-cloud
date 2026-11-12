import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createAuth, cookieToken as readCookieToken, sessionCookie, sessionCookieName, equal } from './auth.mjs';
import { canonicalLoginUsername, createLoginIdentity, nodeLoginScope } from './login-identity.mjs';
import { createTunnelDiagnostics } from './diagnostics.mjs';
import { createServiceDiagnostics } from './service-diagnostics.mjs';
import { managerRequest } from './manager-client.mjs';
import { createRTCBridge, rtcOffer, rtcAddress, rtcIPv6Address } from './rtc.mjs';
import { rtcHints, withHintCandidates } from './rtc-hints.mjs';
import { validateInput } from '../native/input.mjs';
import { clipboardSource } from '../native/clipboard.mjs';
import { terminalTarget } from '../native/terminals.mjs';
import { attachTerminal } from './terminal-bridge.mjs';
import { attachRTCTerminal } from './rtc-terminal.mjs';
import { createForwarding } from './forward.mjs';
import { createForwardAgents } from './forward-agents.mjs';
import { createForwardDownloads } from './forward-downloads.mjs';
import { readUploadHeaders, uploadHeaders, UPLOAD_PROTOCOL } from './public/file-upload.js';
import { createStreamSession, STREAM_ID } from './stream-session.mjs';
import { vncUpstream, terminalUpstream } from './stream-upstream.mjs';
import { streamRTC } from './stream-rtc.mjs';
import { createAccessControl } from './access-control.mjs';
import { createFileTransfers } from './file-transfers.mjs';
import { createServiceRTC } from './service-rtc.mjs';
import { attachServiceFiles } from './service-files.mjs';
import { createUIAssets } from './ui-assets.mjs';
import { listenPrivateHTTP } from '../native/private-http.mjs';
import { loginClient } from './login-client.mjs';
import { stripEntryPath } from './entry-path.mjs';
import { requestTurnCredentials } from './turn-client.mjs';

const NOVNC = resolve(fileURLToPath(new URL('../node_modules/@novnc/novnc/', import.meta.url)));
const MAX_UPLOAD = 50 * 1024 * 1024;
const VIEWER = /^[a-f0-9-]{16,64}$/;
const HSTS = 'max-age=31536000';

function visitorScheme(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ['http', 'https'].includes(parsed.scheme) ? parsed.scheme : '';
  } catch { return ''; }
}

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
  const entryBasePath = config.entryBasePath || '/';
  const login = createLoginIdentity(config.username, nodeLoginScope({ entryBasePath, nodeId: config.nodeId, sharedEntry: config.sharedEntry || !!config.gatewayNode }), { nodeName: config.gatewayNode?.name || '' });
  const assets = await createUIAssets({ root: config.uiRoot, validate: config.uiValidate !== false, nodeId: config.nodeId || '', gateway: !!config.gatewayNode, gatewayOrigin: config.gatewayNode?.origin || '', entryBasePath, login });
  const cookieToken = header => readCookieToken(header, config);
  const scopedNode = (req, url) => !config.sharedEntry || (req.headers['x-codex-node'] || url.searchParams.get('node')) === config.nodeId;
  const access = await createAccessControl(config);
  const auth = await createAuth(config, { validSession: session => session.role !== 'temporary' || access.temporaryValid(session) });
  const tunnelDiagnostics = createTunnelDiagnostics(config.tunnelDiagnosticsUrl);
  const serviceDiagnostics = config.serviceDiagnostics || createServiceDiagnostics(undefined, config.mode);
  const failures = new Map();
  const unlockFailures = new Map();
  const tunnelRequests = new WeakSet();
  const clientKey = req => loginClient(req, tunnelRequests.has(req));
  function gatewayIdentity(req) {
    const header = req.headers['x-codex-gateway-secret'];
    if (header === undefined && !Object.keys(req.headers).some(key => key.startsWith('x-codex-gateway-'))) return;
    const gateway = config.gatewayNode;
    if (!gateway || !tunnelRequests.has(req) || String(req.headers.host).toLowerCase() !== new URL(gateway.backendOrigin).host ||
      req.headers['x-codex-gateway-origin'] !== config.origin || req.headers['x-codex-gateway-node'] !== config.nodeId || !equal(header, gateway.secret)) throw new HttpError(403, '网关接入验证失败');
    // Only the authenticated gateway on the private ingress can restore the
    // public Host. The browser Origin and CSRF token remain untouched.
    req.headers.host = new URL(config.origin).host;
    const client = req.headers['x-codex-gateway-client'];
    if (typeof client === 'string' && net.isIP(client)) req.headers['cf-connecting-ip'] = client; else delete req.headers['cf-connecting-ip'];
    for (const name of Object.keys(req.headers)) if (name.startsWith('x-codex-gateway-')) delete req.headers[name];
  }
  let stopTunnel, tunnelStarting = false;
  const sockets = new Map();
  const streamStates = new Map(); // At most one stream per mode for an opted-in owner, otherwise one total.
  let owner = null;
  let loginBusy = 0;
  let healthCache = null;
  let fileHealthCache = null;
  let maintenancePending = false;
  let closing = false;
  let rtcBusy = false;
  let rtcClosing = Promise.resolve();
  let turnCache = null, turnPending = null;
  const forwarding = createForwarding(config);
  const forwardAgents = createForwardAgents(config, forwarding);
  const forwardDownloads = createForwardDownloads(config.forwardDownloadDir, { server: () => config.origin + (config.entryBasePath && config.entryBasePath !== '/' ? config.entryBasePath : '') });
  const fileTransfers = createFileTransfers();
  const helperTransfers = createFileTransfers({ limit: 2, busyStatus: 429, busyMessage: '助手下载繁忙，请稍后重试' });
  const turnConfig = async () => {
    const node = config.selfhostNode;
    if (!config.webrtc || !node?.turnEndpoint) return null;
    if (turnCache && turnCache.expiresAt > Date.now() + 60_000) return turnCache;
    if (turnPending) return turnPending;
    turnPending = requestTurnCredentials({ endpoint: node.turnEndpoint, node, ca: config.selfhostCaBundle }).then(value => turnCache = value).catch(() => null).finally(() => { turnPending = null; });
    return turnPending;
  };
  const rtcConfig = async () => {
    const turn = await turnConfig();
    return { serviceProtocol: 1, webrtc: config.webrtc === true, rtcStunUrl: config.webrtc ? config.webrtcStunUrl || '' : '', rtcIceServers: config.webrtc && turn ? turn.iceServers : [], rtcIceExpiresAt: turn?.expiresAt };
  };
  const services = createServiceRTC({ config, authorized: token => auth.get(token), port: () => server.address().port, turn: turnConfig, helperDownloads: true,
    connectFiles: (channel, valid, headers, signal, fail) => attachServiceFiles(channel, { valid, headers, signal, fail, entryBasePath, port: () => server.address().port }) });
  const hostAllowed = req => config.hosts.has(String(req.headers.host || '').toLowerCase());
  const originAllowed = req => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return false;
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.host.toLowerCase() !== String(req.headers.host).toLowerCase()) return false;
      return origin === config.origin || (url.protocol === (config.secureCookies ? 'https:' : 'http:') && hostAllowed(req));
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
  const isOwner = (req, session, viewer = req.headers['x-viewer-id']) => session.role !== 'temporary' && !!owner && owner.viewer === viewer && owner.session === session.hash && (!access.screenEnabled || owner.lockRevision === access.screenRevision);
  // Before the first claim, preserve authenticated administrator read access
  // only when no screen lock is configured. A taken-over page is restricted.
  const desktopAccess = (req, session, viewer) => session.role !== 'temporary' && (isOwner(req, session, viewer) || !access.screenEnabled && !owner);
  const accessState = (req, session) => ({ role: session.role || 'admin', full: isOwner(req, session), screenLockEnabled: access.screenEnabled,
    requiresUnlock: session.role !== 'temporary' && access.screenEnabled && !isOwner(req, session), canClaim: session.role !== 'temporary',
    canManageHelpers: desktopAccess(req, session), canViewHelperKeys: session.role === 'temporary' && forwardAgents.hasSharedKeys() });
  function denied(req, session) {
    const error = new HttpError(session.role === 'temporary' ? 403 : access.screenEnabled ? 423 : 409,
      session.role === 'temporary' ? '临时账号仅可使用文件中转、查看连接状态及已开放的助手 key' : access.screenEnabled ? '请先输入屏幕锁密码解锁' : '桌面已在另一页面打开，请先接管');
    error.code = session.role === 'temporary' ? 'restricted_account' : access.screenEnabled ? 'screen_locked' : 'control_required';
    error.access = accessState(req, session); return error;
  }
  function requireDesktopRead(req) {
    const session = requireSession(req);
    if (!desktopAccess(req, session)) throw denied(req, session);
    return session;
  }
  const requireOwner = req => {
    const session = requireWrite(req);
    if (!isOwner(req, session)) throw denied(req, session);
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
    for (const state of [...streamStates.values()]) if (predicate(state)) state.stream.close();
    for (const [socket, state] of sockets) if (predicate(state)) socket.destroy();
  }
  function lockDesktop() { owner = null; closeSockets(() => true); }
  function streamFor(id, mode, target, expected, token, standby = false) {
    if (config.streamProtocol !== 1 || !STREAM_ID.test(id || '')) throw new HttpError(400, '会话协议无效');
    const existing = streamStates.get(id);
    if (existing) {
      if (existing.expected !== expected || existing.mode !== mode || existing.standby !== standby || JSON.stringify(existing.target) !== JSON.stringify(target)) throw new HttpError(409, '会话目标已变化');
      return existing.stream;
    }
    closeSockets(state => state.streamId !== id && !(standby && state.standby && state.mode !== mode));
    const state = { id, streamId: id, mode, standby, target, expected, token, session: expected.session, socket: null };
    const valid = () => streamStates.get(id) === state && owner === expected && !!auth.get(token) && !closing && !maintenancePending;
    const request = { headers: { cookie: sessionCookieName(config) + '=' + token, 'x-viewer-id': expected.viewer } };
    state.stream = createStreamSession({ id, valid,
      canActivate: async planned => {
        const controls = await controlStatus();
        return valid() && controls.available && !controls.maintenance && (!planned || (!controls.inputBusy && !controls.clipboardBusy && !controls.viewportBusy && state.stream.idle));
      },
      performPanel: async (action, live) => {
        if (!valid() || !live()) throw new HttpError(409, '控制权已变化');
        const result = action === 'state' ? await panelSnapshot(request, live) : await managerRequest(config, '/terminals', undefined, 3000);
        if (!valid() || !live()) throw new HttpError(409, '控制权已变化');
        return result;
      },
      ...(mode !== 'terminal' ? {} : { createTerminal: async (body, live) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'terminalId'].includes(key))) throw new HttpError(400, '创建终端参数无效');
        if (!valid() || !live()) throw new HttpError(409, '页面控制权或连接已变化，创建未执行');
        return managerRequest(config, '/terminals', { ...body, action: 'create', view: 'terminal' });
      }, switchTarget: async (body, live) => {
        let next;
        try { next = terminalTarget(body); if (!next.terminalId) throw Error(); } catch { throw new HttpError(400, '终端目标无效'); }
        const catalog = await managerRequest(config, '/terminals', undefined, 3000);
        if (!valid() || !live()) throw new HttpError(409, '控制权已变化');
        if (!catalog.terminals.some(item => item.id === next.terminalId && item.token === next.terminalToken && item.supported)) throw new HttpError(409, '终端身份已变化，请刷新列表');
        return { target: next, commit() { if (!valid() || !live()) throw new HttpError(409, '控制权已变化'); state.target = next; } };
      } }),
      connect: callbacks => mode === 'terminal' ? terminalUpstream(terminalOptions(state.target, valid), callbacks) : vncUpstream(config.vncSocket, callbacks),
      closed: () => { if (streamStates.get(id) === state) streamStates.delete(id); },
    });
    streamStates.set(id, state);
    return state.stream;
  }
  async function agent(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(`${path === '/files' ? config.fileAgentUrl || config.agentUrl : config.agentUrl}${path}`, {
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
        let result;
        try { result = await managerRequest(config, '/health', undefined, 1500); }
        catch (error) {
          // Transitional support for an already-running older manager only.
          if (error.status !== 404) throw error;
          result = await agent('/health', { signal: AbortSignal.timeout(1500) });
        }
        return { ready: result.ready === true, version: result.version || '', transferDir: config.transferDir || '', message: result.ready ? '桌面已就绪' : '桌面正在启动' };
      } catch { return { ready: false, version: '', message: '正在等待桌面服务，任务不会因网页断开而停止' }; }
    })();
    healthCache = { at: Date.now(), promise };
    return promise;
  }
  async function fileHealth() {
    if (fileHealthCache && fileHealthCache.at > Date.now() - 3000) return fileHealthCache.promise;
    const promise = (async () => {
      try {
        const response = await fetch(`${config.fileAgentUrl || config.agentUrl}/health`, { signal: AbortSignal.timeout(1500), headers: { authorization: `Bearer ${config.agentSecret}` } });
        const result = await response.json();
        return response.ok && result.ready === true && result.uploadProtocol === 1 && result.quotaProtocol === 1;
      } catch { return false; }
    })();
    fileHealthCache = { at: Date.now(), promise }; return promise;
  }
  async function panelSnapshot(req, live = () => true) {
    const session = requireSession(req);
    const [desktop, controls] = await Promise.all([desktopHealth(), controlStatus()]);
    requireSession(req); if (!live()) throw new HttpError(409, '控制权已变化');
    const permission = accessState(req, session);
    const visibleControls = desktopAccess(req, session) ? controls : { available: controls.available, maintenance: controls.maintenance, inputBusy: false, clipboardBusy: false, viewportBusy: false };
    return { desktop, controls: visibleControls, access: permission, claimable: permission.canClaim && !owner, mine: permission.full, rtc: await rtcConfig() };
  }

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });

  async function route(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    if (config.secureCookies) res.setHeader('strict-transport-security', HSTS);
    if (config.nodeId) res.setHeader('x-codex-node-id', config.nodeId);
    gatewayIdentity(req);
    if (!hostAllowed(req)) throw new HttpError(400, '访问域名未配置，请检查 PUBLIC_ORIGIN / ALLOWED_HOSTS');
    if (config.secureCookies && tunnelRequests.has(req) && visitorScheme(req.headers['cf-visitor']) === 'http') {
      const target = new URL(req.url, config.origin);
      target.protocol = 'https:';
      target.host = req.headers.host;
      res.writeHead(308, { location: target.toString(), 'cache-control': 'no-store' });
      return res.end();
    }
    const url = new URL(req.url, 'http://internal');
    if (entryBasePath !== '/') {
      if (url.pathname === entryBasePath.slice(0, -1)) {
        res.writeHead(308, { location: entryBasePath + url.search, 'cache-control': 'no-store' });
        return res.end();
      }
      const internalPath = stripEntryPath(url.pathname, entryBasePath);
      if (internalPath === null) throw new HttpError(404, '资源不存在');
      url.pathname = internalPath;
    }
    const path = url.pathname;
    if (path.startsWith('/api/') && !scopedNode(req, url)) return reply(res, 409, { error: '入口已切换到其他节点，请保存草稿后刷新页面。', code: 'node_changed', outcome: 'rejected' });
    if (path === '/ui-version' && req.method === 'GET') return reply(res, 200, { revision: assets.revision });
    if (path === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path === '/readyz' && req.method === 'GET') {
      const [host, files] = await Promise.all([desktopHealth(), fileHealth()]);
      return reply(res, host.ready && files ? 200 : 503, { ok: host.ready && files, host: host.ready, files, ...(config.nodeId ? { nodeId: config.nodeId } : {}) });
    }
    if (path === '/api/login' && req.method === 'POST') {
      if (!originAllowed(req)) throw new HttpError(403, '请求来源无效');
      const key = clientKey(req);
      const body = await jsonBody(req, 4096);
      // No await between checking the current limits and reserving a verification slot.
      const failure = failures.get(key);
      if (failure && failure.until > Date.now() && failure.count >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后再试');
      if (loginBusy >= 2) throw new HttpError(429, '正在验证登录，请稍后再试');
      let identity;
      loginBusy++;
      try {
        const username = canonicalLoginUsername(body.username, login);
        identity = await auth.verify(username, body.password) ? { role: 'admin' } : await access.verifyTemporary(username, body.password);
      }
      finally { loginBusy--; }
      if (!identity) {
        const latest = failures.get(key);
        const current = latest && latest.until > Date.now() ? latest : { count: 0, until: Date.now() + 900_000 };
        current.count++; failures.set(key, current);
        if (failures.size > 1024) failures.delete(failures.keys().next().value);
        throw new HttpError(401, '用户名或密码错误');
      }
      failures.delete(key);
      const previous = sessionOf(req);
      if (previous && owner?.session === previous.hash) lockDesktop();
      const { token, session } = await auth.create(identity);
      if (!auth.get(token)) throw new HttpError(401, '登录授权已改变，请重新登录');
      return reply(res, 200, { mode: config.mode || 'desktop', username: session.username || config.username, access: accessState(req, session), csrf: session.csrf, fastConnect: config.fastConnect === true, streamProtocol: config.streamProtocol === 1 ? 1 : 0, modeStandby: config.streamProtocol === 1 && config.mode !== 'terminal' ? 1 : 0, ...await rtcConfig() }, { 'set-cookie': sessionCookie(token, config) });
    }
    if (path === '/api/me' && req.method === 'GET') {
      const session = requireSession(req);
      return reply(res, 200, { mode: config.mode || 'desktop', username: session.username || config.username, access: accessState(req, session), csrf: session.csrf, fastConnect: config.fastConnect === true, streamProtocol: config.streamProtocol === 1 ? 1 : 0, modeStandby: config.streamProtocol === 1 && config.mode !== 'terminal' ? 1 : 0, ...await rtcConfig() });
    }
    if (path === '/api/logout' && req.method === 'POST') {
      const session = requireWrite(req);
      const revoked = auth.revoke(cookieToken(req.headers.cookie));
      await revoked;
      closeSockets(state => state.session === session.hash);
      if (owner?.session === session.hash) owner = null;
      forwarding.refresh();
      fileTransfers.revalidate(); helperTransfers.revalidate(); services.revalidate();
      return reply(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', config, true) });
    }
    if (path === '/api/state' && req.method === 'GET') {
      return reply(res, 200, await panelSnapshot(req));
    }
    if (path === '/api/diagnostics' && req.method === 'GET') {
      requireSession(req);
      const [tunnel, services, filesReady] = await Promise.all([tunnelDiagnostics(), serviceDiagnostics(), fileHealth()]);
      requireSession(req);
      return reply(res, 200, { tunnel, services, files: { ready: filesReady } });
    }
    if (path === '/api/service/rtc' && req.method === 'POST') {
      requireWrite(req);
      const body = await jsonBody(req, 48 * 1024), session = requireWrite(req);
      const controller = new AbortController(); res.once('close', () => { if (!res.writableFinished) controller.abort(); });
      const headers = { host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, 'x-csrf-token': session.csrf, 'x-viewer-id': req.headers['x-viewer-id'] || '', ...(config.nodeId ? { 'x-codex-node': config.nodeId } : {}) };
      return reply(res, 200, await services.negotiate({ token: cookieToken(req.headers.cookie), session, viewer: headers['x-viewer-id'], body, headers, signal: controller.signal }));
    }
    if (path.startsWith('/api/')) {
      const session = requireSession(req);
      const shared = ['/api/desktop/claim', '/api/files', '/api/forward'].includes(path) || path.startsWith('/api/files/') || path.startsWith('/api/forward/download/') || req.method === 'GET' && ['/api/forward/agents', '/api/forward/agents/key'].includes(path);
      if (!shared && !desktopAccess(req, session)) { if (!['GET', 'HEAD'].includes(req.method)) requireWrite(req); throw denied(req, session); }
    }
    if (path === '/api/security' && req.method === 'GET') { const session = requireSession(req); if (!isOwner(req, session)) throw denied(req, session); return reply(res, 200, access.status()); }
    if (['/api/security/screen-lock', '/api/security/temporary-account'].includes(path) && req.method === 'POST') {
      const body = await ownedBody(req, 2048), expected = owner;
      const valid = () => { requireOwner(req); if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '控制权已变化，本次设置未保存'); };
      const oldRevision = access.screenRevision;
      let result;
      try { result = path.endsWith('/screen-lock') ? await access.saveScreen(body, valid) : await access.saveTemporary(body, valid); }
      finally {
        // A rename can commit a new policy before directory fsync fails. Even
        // when saving reports an error, all live grants must match that policy.
        if (oldRevision !== access.screenRevision) {
          if (access.screenEnabled) lockDesktop();
          else if (owner) owner.lockRevision = access.screenRevision;
        }
        forwarding.refresh();
        fileTransfers.revalidate(); helperTransfers.revalidate(); services.revalidate();
      }
      return reply(res, 200, { ...result, access: accessState(req, requireSession(req)) });
    }
    if (path === '/api/security/lock' && req.method === 'POST') {
      await ownedBody(req, 128);
      if (!access.screenEnabled) throw new HttpError(409, '请先开启屏幕锁');
      lockDesktop(); return reply(res, 200, { ok: true, access: accessState(req, requireSession(req)) });
    }
    if (config.mode === 'terminal' && (path.startsWith('/api/desktop/') && path !== '/api/desktop/claim' || ['/api/paste', '/api/key', '/api/terminal', '/api/clipboard/read'].includes(path))) {
      if (req.method === 'GET') requireSession(req); else requireOwner(req);
      throw new HttpError(501, '纯终端部署未启用桌面操作');
    }
    if (path === '/api/desktop/settings' && req.method === 'GET') {
      requireDesktopRead(req); const expected = owner;
      const result = await managerRequest(config, '/settings'); requireDesktopRead(req);
      if (owner !== expected) throw new HttpError(409, '页面控制权已变化');
      return reply(res, 200, result);
    }
    if (path === '/api/terminals' && req.method === 'GET') {
      requireDesktopRead(req); const expected = owner;
      const result = await managerRequest(config, '/terminals'); requireDesktopRead(req);
      if (owner !== expected) throw new HttpError(409, '页面控制权已变化');
      return reply(res, 200, result);
    }
    if (path === '/api/forward' && req.method === 'GET') {
      requireSession(req);
      const downloads = await forwardDownloads.list(); requireSession(req);
      return reply(res, 200, { ports: forwarding.list().ports, allPorts: forwarding.list().allPorts, maxConnections: 8, downloads, managedHelpersProtocol: 2 });
    }
    if (path === '/api/forward/agents' && req.method === 'GET') {
      const session = requireSession(req);
      if (session.role === 'temporary') {
        if (!forwardAgents.hasSharedKeys()) throw denied(req, session);
        return reply(res, 200, forwardAgents.sharedKeys());
      }
      requireDesktopRead(req); return reply(res, 200, forwardAgents.list());
    }
    if (path === '/api/forward/agents/key' && req.method === 'GET') {
      const session = requireSession(req); if (session.role !== 'temporary') requireDesktopRead(req);
      if (url.searchParams.getAll('id').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'id')) throw new HttpError(400, '助手标识无效');
      if (session.role === 'temporary') return reply(res, 200, forwardAgents.sharedKey(url.searchParams.get('id')));
      return reply(res, 200, forwardAgents.action('key', { id: url.searchParams.get('id') }));
    }
    if (/^\/api\/forward\/agents\/(?:rekey|visibility|rule|rule\/remove|inventory)$/.test(path) && req.method === 'POST') {
      requireWrite(req); requireDesktopRead(req); const expected = owner, body = await jsonBody(req, 4096); requireWrite(req); requireDesktopRead(req);
      if (owner !== expected) throw new HttpError(409, '控制权已变化，本次助手配置未保存');
      return reply(res, 200, forwardAgents.action(path.slice('/api/forward/agents/'.length), body));
    }
    if (path.startsWith('/api/forward/download/') && req.method === 'GET') {
      requireSession(req);
      if (url.searchParams.getAll('generation').length > 1) throw new HttpError(400, '助手版本参数无效');
      const token = cookieToken(req.headers.cookie), transfer = helperTransfers.begin(req, res, () => !!auth.get(token));
      try { return await forwardDownloads.serve(path.slice('/api/forward/download/'.length), res, url.searchParams.get('generation') ?? undefined, transfer); }
      finally { transfer.finish(); }
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
      if (session.role === 'temporary') throw denied(req, session);
      const { viewer, ifFree, lockPassword } = await jsonBody(req, 1024);
      requireWrite(req); // Revoked/expired sessions cannot claim through a delayed body.
      if (typeof viewer !== 'string' || !VIEWER.test(viewer)) throw new HttpError(400, '页面标识无效');
      if (ifFree !== undefined && ifFree !== true) throw new HttpError(400, '恢复认领参数无效');
      if (ifFree && owner && (owner.viewer !== viewer || owner.session !== session.hash)) throw new HttpError(409, '已有其他页面控制桌面，请明确接管');
      if (ifFree && owner) return reply(res, 200, { ok: true });
      if (access.screenEnabled && !(owner?.viewer === viewer && owner.session === session.hash && owner.lockRevision === access.screenRevision)) {
        if (typeof lockPassword !== 'string' || !lockPassword) throw denied(req, session);
        const key = clientKey(req), before = owner, version = access.screenRevision;
        const record = unlockFailures.get(key);
        if (record?.until > Date.now() && record.count >= 20) throw new HttpError(429, '解锁尝试过多，请一分钟后再试');
        if (loginBusy >= 2) throw new HttpError(429, '正在验证密码，请稍后重试');
        loginBusy++; let verified;
        try { verified = await access.verifyScreen(lockPassword); } finally { loginBusy--; }
        requireWrite(req);
        if (!verified) {
          const previous = unlockFailures.get(key), current = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
          current.count++; unlockFailures.set(key, current); if (unlockFailures.size > 1024) unlockFailures.delete(unlockFailures.keys().next().value);
          throw new HttpError(403, '屏幕锁密码不正确');
        }
        if (owner !== before || version !== access.screenRevision || res.destroyed || closing) throw new HttpError(409, '控制权或屏幕锁已变化，请重新解锁');
        unlockFailures.delete(key);
      }
      if (owner?.viewer !== viewer || owner?.session !== session.hash) closeSockets(() => true);
      if (owner?.viewer !== viewer || owner?.session !== session.hash) owner = { viewer, session: session.hash, lockRevision: access.screenRevision };
      return reply(res, 200, { ok: true, access: accessState(req, session) });
    }
    if (['/api/desktop/rtc', '/api/terminal/rtc'].includes(path) && req.method === 'POST') {
      const terminalMode = path === '/api/terminal/rtc';
      const expected = owner;
      const body = await ownedBody(req, 48 * 1024);
      const resumable = body.streamId !== undefined;
      const mode = terminalMode ? 'terminal' : 'desktop', standby = resumable && body.standby === true && config.mode !== 'terminal';
      if (resumable && (config.streamProtocol !== 1 || !STREAM_ID.test(body.streamId))) throw new HttpError(400, '会话协议无效');
      if (!config.webrtc) throw new HttpError(404, '未启用桌面直连');
      let offer, hints, relay, iceServers = [];
      try {
        hints = rtcHints(body.hints);
        const turn = await turnConfig();
        offer = withHintCandidates(rtcOffer(body, { ipv6: config.webrtcIPv6 === true, relay: turn?.relay }), hints.browser, { ipv6: config.webrtcIPv6 === true });
        iceServers = turn?.iceServers || []; relay = turn?.relay;
      } catch (error) { throw new HttpError(400, error.message); }
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
        closeSockets(state => state.rtcPending === true && !(standby && state.standby && state.mode !== mode));
        await rtcClosing;
        requireOwner(req);
        if (owner !== expected || closing || res.destroyed) throw new HttpError(409, '页面控制权已变化');
        const token = cookieToken(req.headers.cookie);
        const stream = resumable ? streamFor(body.streamId, mode, target, expected, token, standby) : null;
        const state = { session: expected.session, token, mode, standby, socket: null, rtcPending: true, ...(resumable ? { streamId: body.streamId } : {}) };
        let streamEntry;
        let terminalSession;
        if (terminalMode) state.inputIdle = () => terminalSession?.idle === true;
        const valid = () => !closing && !maintenancePending && owner === expected && !!auth.get(token) && sockets.get(bridge) === state &&
          (!resumable || streamStates.get(body.streamId)?.stream === stream && (!!streamEntry || JSON.stringify(streamStates.get(body.streamId).target) === JSON.stringify(target)));
        const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress;
        const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
        bridge = createRTCBridge({ address, ipv6Address, iceServers, stunUrl: config.webrtcStunUrl, relay, turnCa: config.selfhostCaBundle, vncSocket: config.vncSocket, valid,
          ...(resumable ? { connectStream: (channel, authorized, fail) => {
            streamEntry = streamRTC(channel, stream, authorized, fail); return streamEntry;
          } } : terminalMode ? { connectTerminal: (channel, authorized, fail) => {
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
              if (!current.available || current.maintenance || (!resumable && (current.inputBusy || current.clipboardBusy || current.viewportBusy))) throw new HttpError(409, '当前操作未结束，暂不切换连接');
              if (resumable) { state.rtcPending = false; bridge.activate(); return { active: true }; }
              for (const value of sockets.values()) if (value !== state && value.inputIdle && !value.inputIdle()) throw new HttpError(409, '终端输入尚未完成，暂不切换连接');
              closeSockets(value => value.socket !== bridge);
              state.rtcPending = false;
              bridge.activate();
              return { active: true };
            }
            if (resumable && !streamEntry?.active) throw new HttpError(409, '备用通道不可输入');
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
        const answer = withHintCandidates(await bridge.answer(offer), hints.server, { ipv6: !!ipv6Address });
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
      const result = await agent('/files'); requireSession(req); return reply(res, 200, result);
    }
    if (path.startsWith('/api/files/') && ['GET', 'PUT'].includes(req.method)) {
      const session = req.method === 'PUT' ? requireWrite(req) : requireSession(req);
      const encoded = path.slice('/api/files/'.length);
      let name;
      try { name = decodeURIComponent(encoded); } catch { throw new HttpError(400, '文件名无效'); }
      if (!name || name === '.' || name === '..' || name.startsWith('.upload-') || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 240) throw new HttpError(400, '文件名无效');
      const token = cookieToken(req.headers.cookie), transfer = fileTransfers.begin(req, res, () => !!auth.get(token), session.role === 'temporary' && req.method === 'PUT');
      try {
      if (req.method === 'PUT') {
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UPLOAD) throw new HttpError(413, '文件大小必须明确，且不能超过 50 MiB');
        const upload = readUploadHeaders(req.headers);
        const listed = await agent('/files'); transfer.check(); requireWrite(req);
        if (listed.uploadProtocol !== UPLOAD_PROTOCOL) throw new HttpError(503, '文件服务需要更新后才能安全上传；未发送文件内容');
        if (!Array.isArray(listed.files)) throw new HttpError(503, '共享目录状态暂不可用');
        const existing = listed.files.find(file => file.name === name);
        if (upload.mode === 'create' && existing) throw new HttpError(409, '已有同名文件，未覆盖；请选择替换或自动改名');
        if (upload.mode === 'replace' && (!existing || existing.version !== upload.version)) throw new HttpError(412, '原文件已变化，未替换；请刷新后重新选择');
        if (session.role === 'temporary') {
          if (listed.quotaProtocol !== 1) throw new HttpError(503, '文件助手需要更新后才能核算临时上传配额');
          if (listed.truncated !== false) throw new HttpError(413, '目录超过核算范围，临时上传已暂停；请管理员整理文件');
          if (listed.files.length >= 1000 && !(upload.mode === 'replace' && existing)) throw new HttpError(413, '共享目录已达到临时上传文件数量上限');
          let total = 0, replaced = 0;
          for (const file of listed.files) {
            if (!Number.isSafeInteger(file.size) || file.size < 0) throw new HttpError(503, '共享目录状态暂不可用');
            total += file.size; if (upload.mode === 'replace' && file.name === name) replaced = file.size;
          }
          if (total - replaced + length > 1024 * 1024 * 1024) throw new HttpError(413, '共享目录已达到临时上传的 1 GiB 容量上限');
        }
        const limiter = new Transform({ transform(chunk, _encoding, callback) { this.total = (this.total || 0) + chunk.length; callback(this.total > MAX_UPLOAD ? new Error('文件过大') : null, chunk); } });
        const response = await fetch(`${config.fileAgentUrl || config.agentUrl}/files/${encodeURIComponent(name)}`, {
          method: 'PUT', headers: { authorization: `Bearer ${config.agentSecret}`, 'content-length': String(length), 'content-type': 'application/octet-stream', ...uploadHeaders(upload), ...(session.role === 'temporary' ? { 'x-codex-upload-quota': 'temporary-v1' } : {}) },
          body: req.pipe(limiter), duplex: 'half', signal: transfer.signal,
        });
        const result = await response.json(); transfer.check(); return reply(res, response.status, result);
      }
      const response = await fetch(`${config.fileAgentUrl || config.agentUrl}/files/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${config.agentSecret}` }, signal: transfer.signal });
      transfer.check();
      if (!response.ok) return reply(res, response.status, await response.json());
      const etag = response.headers.get('etag');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, ...(response.headers.has('content-length') ? { 'content-length': response.headers.get('content-length') } : {}), ...(/^"[a-f0-9]{64}"$/.test(etag || '') ? { etag } : {}) });
      await pipeline(response.body, res);
      return;
      } finally { transfer.finish(); }
    }
    if (path.startsWith('/desktop/') || path.startsWith('/terminal/')) {
      const session = requireSession(req);
      // Iframe navigations carry their page identifier in the URL. Static
      // modules have no private data; all streams and actions check ownership.
      if (['/desktop/index.html', '/terminal/index.html'].includes(path) && !desktopAccess(req, session, url.searchParams.get('viewer') || undefined)) throw denied(req, session);
      if (config.mode === 'terminal' && (['/desktop/index.html', '/desktop/viewer.js', '/desktop/viewer.css'].includes(path) || path.startsWith('/desktop/novnc/'))) throw new HttpError(501, '纯终端部署未启用桌面资源');
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
    const asset = assets.get(path, url.searchParams.get('ui'));
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'sha256-${asset.scriptHash}'; style-src 'self'${path.startsWith('/terminal/') ? " 'unsafe-inline'" : ''}; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`);
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes.length, 'cache-control': 'no-store', 'x-ui-revision': asset.revision });
      return res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    }
    throw new HttpError(404, '资源不存在');
  }

  const handleRequest = (req, res) => {
    route(req, res).catch(error => {
      if (!error.status) console.error(`[panel] ${error.name}: request failed`); // No bodies, cookies or credentials.
      reply(res, error.status || 502, { error: error.status ? error.message : '服务暂时不可用，请稍后重试', outcome: error.outcome || (error.status ? 'rejected' : 'unknown'),
        ...(error.code && error.access ? { code: error.code, access: error.access } : {}) });
    });
  };
  const server = http.createServer(handleRequest);
  server.requestTimeout = 310_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 64;
  async function upgrade(req, socket, head) {
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\n${config.nodeId ? 'X-Codex-Node-Id: ' + config.nodeId + '\r\n' : ''}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    try { gatewayIdentity(req); } catch { return deny(403); }
    if (!hostAllowed(req) || !originAllowed(req)) return deny(403);
    const forwardURL = new URL(req.url, 'http://internal');
    if (entryBasePath !== '/') {
      const internalPath = stripEntryPath(forwardURL.pathname, entryBasePath);
      if (internalPath === null) return deny(404);
      forwardURL.pathname = internalPath;
    }
    if (forwardURL.pathname.startsWith('/forward/')) {
      if (closing || forwardURL.search) return deny(400);
      if (forwardURL.pathname === '/forward/agent') return forwardAgents.upgrade(req, socket, head);
      if (forwardURL.pathname === '/forward/transport') return forwardAgents.upgrade(req, socket, head, true);
      if (req.headers['x-codex-forward-node'] && req.headers['x-codex-forward-node'] !== config.nodeId) return deny(409);
      return forwarding.upgrade(req, socket, head, forwardURL.pathname);
    }
    if (!scopedNode(req, forwardURL)) return deny(409);
    const session = sessionOf(req);
    if (!session) return deny(401);
    if (!isOwner(req, session, forwardURL.searchParams.get('viewer'))) return deny(session.role === 'temporary' ? 403 : access.screenEnabled ? 423 : 409);
    const url = forwardURL;
    const terminalMode = url.pathname === '/terminal/connect';
    const streamMode = url.pathname === '/session/connect';
    if (config.mode === 'terminal' && (url.pathname === '/desktop/websockify' || streamMode && url.searchParams.get('mode') === 'desktop')) return deny(501);
    if (url.pathname !== '/desktop/websockify' && !terminalMode && !streamMode) return deny(404);
    if (!owner || owner.session !== session.hash || owner.viewer !== url.searchParams.get('viewer')) return deny(409);
    const expected = owner;
    const controls = await controlStatus();
    if (closing || socket.destroyed) { socket.destroy(); return; }
    if (!sessionOf(req)) return deny(401);
    if (owner !== expected) return deny(409);
    if (!controls.available || controls.maintenance) return deny(503);
    if (streamMode) {
      const id = url.searchParams.get('streamId'), mode = url.searchParams.get('mode');
      if (config.streamProtocol !== 1 || !STREAM_ID.test(id || '') || !['desktop', 'terminal'].includes(mode)) return deny(400);
      let target;
      if (mode === 'terminal') {
        try { target = terminalTarget({ terminalId: url.searchParams.get('terminalId'), terminalToken: url.searchParams.get('terminalToken') }); }
        catch { return deny(400); }
        if (!await terminalAvailable(target)) return deny(409);
      }
      if (owner !== expected || !sessionOf(req) || closing || maintenancePending || socket.destroyed) return deny(409);
      const standby = url.searchParams.get('standby') === '1' && config.mode !== 'terminal';
      const token = cookieToken(req.headers.cookie), stream = streamFor(id, mode, target, expected, token, standby);
      if ([...sockets.values()].some(state => state.streamId === id && state.relayPending && !state.socket.destroyed)) return deny(429);
      const state = { session: session.hash, token, socket, mode, standby, streamId: id, relayPending: true };
      sockets.set(socket, state); socket.once('close', () => sockets.delete(socket));
      const valid = () => owner === expected && sockets.get(socket) === state && !!auth.get(token) && !closing && !maintenancePending;
      terminalWss.handleUpgrade(req, socket, head, ws => {
        let entry;
        const timer = setTimeout(() => ws.terminate(), 2500).unref();
        ws.once('close', () => { clearTimeout(timer); entry?.close(); }); ws.once('error', () => entry?.close());
        ws.once('message', (bytes, binary) => {
          clearTimeout(timer); let first;
          try { if (binary || bytes.length > 1024) throw new Error(); first = JSON.parse(bytes.toString()); } catch { return ws.terminate(); }
          if (!valid() || streamStates.get(id)?.stream !== stream || JSON.stringify(streamStates.get(id).target) !== JSON.stringify(target) || first?.type !== 'auth' || !equal(first.csrf, session.csrf)) return ws.terminate();
          state.relayPending = false;
          entry = stream.attach('relay', { send: value => ws.send(JSON.stringify(value)), buffered: () => ws.bufferedAmount, close: () => ws.terminate() });
          ws.on('message', (data, bin) => {
            if (!valid() || bin || data.length > 24576) return ws.terminate();
            try { entry?.receive(JSON.parse(data.toString())); } catch { ws.terminate(); }
          });
        });
      });
      return;
    }
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
  async function startTunnel(path) {
    if (stopTunnel || tunnelStarting || closing || !server.listening) throw Error('私有 Tunnel 接口无法启动');
    tunnelStarting = true;
    const ingress = http.createServer((req, res) => { tunnelRequests.add(req); handleRequest(req, res); });
    ingress.requestTimeout = server.requestTimeout; ingress.headersTimeout = server.headersTimeout;
    ingress.maxHeadersCount = server.maxHeadersCount; ingress.maxConnections = 256;
    ingress.on('upgrade', (req, socket, head) => { tunnelRequests.add(req); void upgrade(req, socket, head).catch(() => socket.destroy()); });
    try {
      const stop = await listenPrivateHTTP(ingress, path);
      if (closing) { await stop(); throw Error('面板正在关闭'); }
      stopTunnel = stop;
    }
    finally { tunnelStarting = false; }
  }
  const expiration = setInterval(() => {
    closeSockets(state => !auth.get(state.token));
  }, 10_000).unref();
  async function close() {
    closing = true;
    forwardAgents.close(); await forwarding.close();
    await services.close();
    fileTransfers.close();
    helperTransfers.close();
    clearInterval(expiration);
    closeSockets(() => true);
    await rtcClosing;
    for (const client of wss.clients) client.terminate();
    wss.close();
    for (const client of terminalWss.clients) client.terminate();
    terminalWss.close();
    if (stopTunnel) { await stopTunnel(); stopTunnel = undefined; }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await auth.close();
  }
  return { server, startTunnel, close, reloadUI: assets.reload, get uiRevision() { return assets.revision; } };
}
