import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { equal } from './auth.mjs';
import { FORWARD_ERRORS } from './forward-errors.mjs';
import { createForwardPeer } from './forward-rtc.mjs';
import { rtcOffer } from './rtc-network.mjs';
import { rtcAddress, rtcIPv6Address } from './rtc.mjs';

export const FORWARD_LIMITS = Object.freeze({ mappings: 4, connections: 8, chunk: 16384, buffer: 256 * 1024, pairMs: 120000, resumeMs: 30000, resumeAttempts: 8, recent: 8, recentMs: 10 * 60000, closing: 8 });
const fail = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export function forwardPorts(value = '*') {
  if (value === '*') return '*';
  if (value === '') return [];
  const fields = String(value).split(',').map(item => item.trim());
  if (fields.length > 16 || fields.some(item => !/^[1-9]\d{0,4}$/.test(item) || Number(item) > 65535)) throw new Error('TCP_FORWARD_PORTS 需为 *、最多 16 个以逗号分隔的端口，或留空禁用');
  return [...new Set(fields.map(Number))];
}

export function forwardTargetHost(value = '127.0.0.1') {
  if (typeof value !== 'string' || value.length > 64) throw fail(400, '目标 IP 需为 IPv4 或 IPv6 地址');
  let host = value.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const family = net.isIP(host);
  if (!family || host.includes('%')) throw fail(400, '目标 IP 需为 IPv4 或 IPv6 地址，不含端口、域名或网卡标识');
  if (family === 6) {
    host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host);
    if (mapped) { const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16); host = [high >> 8, high & 255, low >> 8, low & 255].join('.'); }
  }
  const ipv4 = net.isIP(host) === 4;
  if (host === '::' || !ipv4 && host.startsWith('ff') || ipv4 && (host === '0.0.0.0' || Number(host.split('.')[0]) >= 224)) throw fail(400, '目标 IP 需为具体的单播地址');
  return host;
}

// Forwarding has its own lifetime: a desktop reconnect/mode change never
// touches these sockets. Recovery replaces only this mapping's transports.
export function createForwarding(config, { now = Date.now, createPeer = config.forwardPeerFactory || createForwardPeer } = {}) {
  const mappings = new Map(), recent = [], retiring = new Map(), peers = new Set();
  let negotiating = false;
  const controls = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 48 * 1024 });
  const streams = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: FORWARD_LIMITS.chunk });
  const blockedPort = port => [config.port, config.agentPort, config.tunnelMetricsPort].includes(port);
  const allPorts = () => (config.forwardPorts ?? '*') === '*';
  const ports = () => (allPorts() ? [22] : config.forwardPorts).filter(port => !blockedPort(port));
  const invalidReason = item => item.authorizationError() || (item.state === 'pending' && item.expires <= now() ? 'pair_expired' : '') ||
    (item.recoverUntil && item.recoverUntil <= now() ? 'resume_expired' : '');
  const authorized = item => mappings.get(item.id) === item && !invalidReason(item);
  const active = item => authorized(item) && item.state === 'active' && item.control?.readyState === 1;
  function retire(ws, code) {
    if (ws.readyState !== 1) return ws.terminate();
    if (retiring.size >= FORWARD_LIMITS.closing) {
      const [old, timeout] = retiring.entries().next().value;
      retiring.delete(old); clearTimeout(timeout); old.terminate();
    }
    const timeout = setTimeout(() => { retiring.delete(ws); ws.terminate(); }, 1000).unref();
    retiring.set(ws, timeout);
    ws.once('close', () => { clearTimeout(timeout); retiring.delete(ws); });
    ws.close(4000, code);
  }
  function disconnectStreams(item) {
    item.streamHash = undefined;
    const peer = item.peer; item.peer = null;
    void peer?.destroy();
    for (const stream of item.streams) { stream.ws.terminate(); stream.tcp.destroy(); }
    item.streams.clear();
    item.directClient = false; item.direct = undefined;
  }
  function remove(item, code = 'helper_disconnected') {
    if (mappings.get(item.id) !== item) return;
    mappings.delete(item.id); clearTimeout(item.timer);
    disconnectStreams(item);
    recent.unshift({ id: item.id, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, code, endedAt: now(), pairHash: item.pairHash, resumeHash: item.resumeHash });
    recent.splice(FORWARD_LIMITS.recent);
    if (item.control) retire(item.control, code);
  }
  function suspend(item, ws, code = 'helper_disconnected') {
    if (mappings.get(item.id) !== item || item.control !== ws) return;
    const invalid = invalidReason(item);
    if (invalid || !item.resumeHash) return remove(item, invalid || code);
    item.control = null; item.state = 'recovering'; item.errorCode = 'helper_reconnecting';
    item.recoverUntil ||= now() + FORWARD_LIMITS.resumeMs;
    clearTimeout(item.timer); disconnectStreams(item);
    item.timer = setTimeout(() => remove(item, invalidReason(item) || 'resume_expired'), Math.max(1, item.recoverUntil - now())).unref();
    retire(ws, 'helper_reconnecting');
  }
  function refresh() {
    for (const item of mappings.values()) { const code = invalidReason(item); if (code) remove(item, code); }
    for (let i = recent.length - 1; i >= 0; i--) if (now() - recent[i].endedAt >= FORWARD_LIMITS.recentMs) recent.splice(i, 1);
  }
  function revoke(session) { for (const item of mappings.values()) if (item.session === session) remove(item, 'signed_out'); }
  const timer = setInterval(refresh, 5000).unref();
  function list() {
    refresh();
    return { ports: ports(), allPorts: allPorts(), limit: FORWARD_LIMITS.mappings, maxConnections: FORWARD_LIMITS.connections,
      mappings: [...mappings.values()].map(item => ({ id: item.id, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort,
        state: item.state, expires: item.state === 'pending' ? item.expires : null, recoverUntil: item.recoverUntil || null, connections: item.streams.size, sent: item.sent, received: item.received, errorCode: item.errorCode || '', error: FORWARD_ERRORS[item.errorCode] || '',
        direct: { ...(item.direct || { available: false, reason: config.webrtc ? 'rtc_waiting_helper' : 'rtc_disabled' }), note: FORWARD_ERRORS[item.direct ? item.direct.reason : config.webrtc ? 'rtc_waiting_helper' : 'rtc_disabled'] || '' }, directConnections: [...item.streams].filter(stream => stream.ws.transport === 'direct').length })),
      recent: recent.map(({ pairHash: _pair, resumeHash: _resume, ...item }) => ({ ...item, error: FORWARD_ERRORS[item.code] })) };
  }
  function create(body, session, authorizationError) {
    refresh();
    if (!body || !['localPort,targetPort', 'localPort,targetHost,targetPort'].includes(Object.keys(body).sort().join(',')) || !Number.isInteger(body.localPort) || body.localPort < 1024 || body.localPort > 65535) throw fail(400, '本机端口需在 1024–65535 之间，请填写目标 IP 和端口');
    if (!Number.isInteger(body.targetPort) || body.targetPort < 1 || body.targetPort > 65535 || blockedPort(body.targetPort) || !allPorts() && !ports().includes(body.targetPort)) throw fail(400, '目标端口需在 1–65535 之间且符合服务器端口限制，不能映射工作台管理端口');
    const targetHost = forwardTargetHost(body.targetHost);
    if (authorizationError()) throw fail(401, '登录授权已失效，请重新登录');
    if (mappings.size >= FORWARD_LIMITS.mappings) throw fail(409, '最多保留 4 个映射，请先停止不用的映射');
    if ([...mappings.values()].some(item => item.session === session && item.localPort === body.localPort)) throw fail(409, '该本机端口已有待配对或活动映射');
    const code = secret(), item = { id: randomBytes(16).toString('hex'), session, authorizationError, pairHash: digest(code), expires: now() + FORWARD_LIMITS.pairMs,
      localPort: body.localPort, targetHost, targetPort: body.targetPort, state: 'pending', streams: new Set(), sent: 0, received: 0, opens: 0, openedAt: now(), peerId: 0, peerAt: -Infinity };
    mappings.set(item.id, item);
    return { id: item.id, code, expires: item.expires, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort };
  }
  function stop(body) {
    if (Object.keys(body).join(',') !== 'id' || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) throw fail(400, '映射标识无效');
    const item = mappings.get(body.id);
    if (item) remove(item, 'stopped');
    return { ok: true };
  }
  function heartbeat(ws, expired) {
    let alive = true;
    const interval = setInterval(() => {
      if (!alive || ws.readyState !== 1) return expired();
      alive = false; ws.ping();
    }, 15000).unref();
    ws.on('pong', () => { alive = true; });
    ws.once('close', () => clearInterval(interval)); ws.on('error', () => {});
  }
  function control(item, ws, resume = false, capable = false) {
    clearTimeout(item.timer);
    item.control = ws; item.generation = (item.generation || 0) + 1; item.peerId = 0; item.peerAt = -Infinity;
    heartbeat(ws, () => suspend(item, ws, 'heartbeat_timeout'));
    item.timer = setTimeout(() => suspend(item, ws, 'pairing_timeout'), Math.min(5000, item.recoverUntil ? Math.max(1, item.recoverUntil - now()) : 5000)).unref();
    const token = secret(); item.streamHash = digest(token);
    let resumeToken;
    if (!resume && capable) { resumeToken = secret(); item.resumeHash = digest(resumeToken); }
    ws.once('close', (code, reason) => {
      if (item.control !== ws) return;
      if (code === 1000 && reason.toString() === 'client_stopping') remove(item, 'helper_stopped');
      else suspend(item, ws);
    });
    ws.on('message', (data, binary) => {
      if (item.control !== ws) return;
      let value;
      try { if (binary) throw new Error(); value = JSON.parse(data.toString('utf8')); } catch { return remove(item, 'protocol_error'); }
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (item.state === 'active' && item.directClient) {
        if (value?.type === 'rtc_offer') { void negotiate(item, value); return; }
        if (value?.type === 'rtc_failed' && Object.keys(value).sort().join(',') === 'id,type' && value.id === item.peerId) { item.peer?.unhealthy('rtc_channel_failed'); return; }
        if (value?.type === 'rtc_drain' && Object.keys(value).sort().join(',') === 'id,type' && value.id === item.peerId) { item.peer?.drain(); return; }
      }
      if (item.state === 'connecting' && value && Object.keys(value).sort().join(',') === 'code,type' && value.type === 'error' && ['local_port_in_use', 'local_listen_failed'].includes(value.code)) return remove(item, value.code);
      if (item.state !== 'connecting' || !value || !['type', 'direct,type'].includes(Object.keys(value).sort().join(',')) || value.type !== 'listening' || (Object.hasOwn(value, 'direct') && value.direct !== 1)) return remove(item, 'protocol_error');
      clearTimeout(item.timer); item.state = 'active'; item.recoverUntil = undefined; item.resumeAttempts = 0; item.errorCode = ''; ws.send('{"type":"listening"}');
      item.directClient = value.direct === 1;
      if (item.directClient) send(item, { type: 'rtc_config', enabled: !!config.webrtc, ipv6: !!config.webrtcIPv6, stun: config.webrtcStunUrl || '' });
    });
    ws.send(JSON.stringify({ type: 'ready', version: 1, id: item.id, streamToken: token, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, maxConnections: FORWARD_LIMITS.connections, directProtocol: 1,
      ...(item.resumeHash ? { resumeProtocol: 1, resumeMs: item.recoverUntil ? Math.max(1, item.recoverUntil - now()) : FORWARD_LIMITS.resumeMs, ...(resumeToken ? { resumeToken } : {}) } : {}) }));
  }
  function send(item, record) {
    if (!authorized(item) || item.control?.readyState !== 1) return;
    const text = JSON.stringify(record);
    if (item.control.bufferedAmount + Buffer.byteLength(text) > 64 * 1024) return remove(item, 'buffer_limit');
    item.control.send(text);
  }
  function report(item, value) { item.direct = value; send(item, { type: 'rtc_status', ...value }); }
  async function negotiate(item, value) {
    const control = item.control, current = () => active(item) && item.control === control;
    if (Object.keys(value).sort().join(',') !== 'id,sdp,type' || !Number.isInteger(value.id) || value.id <= item.peerId || value.id > 2147483647) return remove(item, 'protocol_error');
    const rejected = reason => {
      if (!current()) return;
      const state = { id: value.id, available: false, reason, family: null, rttMs: null };
      if (!item.peer) item.direct = state;
      send(item, { type: 'rtc_status', ...state });
    };
    if (!config.webrtc) return rejected('rtc_disabled');
    if (negotiating || now() - item.peerAt < 10000 || item.peer?.streams || peers.size >= 4 && !item.peer) return rejected('rtc_busy');
    let offer; try { offer = rtcOffer({ type: 'offer', sdp: value.sdp }, { ipv6: !!config.webrtcIPv6 }); } catch { return rejected('rtc_negotiation_failed'); }
    negotiating = true; item.peerAt = now();
    try {
      await item.peer?.destroy();
      if (!current()) return;
      const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress || '127.0.0.1';
      const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
      let peer;
      item.peerId = value.id;
      peer = createPeer({ address, ipv6Address, id: value.id, valid: () => current() && item.peer === peer,
        authenticate: token => current() && item.peer === peer && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && equal(digest(token), item.streamHash),
        status: state => { if (current() && item.peer === peer) report(item, state); }, closed: () => { if (item.peer === peer) item.peer = null; },
        connect: socket => { if (!current() || item.peer !== peer) return socket.terminate(); const reason = reserve(item); if (reason) { item.errorCode = reason; socket.close(4000, reason); } else transfer(item, socket); } });
      peers.add(peer); const destroy = peer.destroy;
      peer.destroy = reason => { const result = destroy(reason); if (result) void Promise.resolve(result).finally(() => peers.delete(peer)); return result; };
      item.peer = peer; report(item, peer.state);
      const sdp = await peer.answer(offer);
      if (current() && item.peer === peer) send(item, { type: 'rtc_answer', id: value.id, typeDescription: 'answer', sdp });
    } catch { rejected('rtc_negotiation_failed'); }
    finally { negotiating = false; }
  }
  function reserve(item) {
    if (now() - item.openedAt >= 10000) { item.openedAt = now(); item.opens = 0; }
    if (item.streams.size >= FORWARD_LIMITS.connections) return 'connection_limit';
    if (++item.opens > 32) return 'rate_limit';
    return '';
  }
  function transfer(item, ws) {
    const generation = item.generation;
    const tcp = net.createConnection({ host: item.targetHost, port: item.targetPort, allowHalfOpen: true, highWaterMark: 32768 });
    const stream = { ws, tcp }; item.streams.add(stream); if (ws.transport !== 'direct') heartbeat(ws, () => abort('heartbeat_timeout'));
    const live = () => active(item) && item.generation === generation && item.streams.has(stream);
    let connected = false, clientFin = false, pending = 0;
    const deadline = setTimeout(() => tcp.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), 5000).unref();
    const abort = (code = 'protocol_error') => { if (live()) item.errorCode = code; tcp.destroy(); retire(ws, code); };
    ws.once('close', () => { clearTimeout(deadline); tcp.destroy(); item.streams.delete(stream); });
    tcp.once('connect', () => {
      clearTimeout(deadline);
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live()) return tcp.destroy();
      connected = true; item.errorCode = ''; tcp.setNoDelay(true); tcp.setKeepAlive(true, 30000); ws.send('{"type":"ready"}');
    });
    ws.on('message', (data, binary) => {
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live()) return tcp.destroy();
      if (!connected || clientFin) return abort();
      if (!binary) {
        if (data.toString('utf8') !== '{"type":"fin"}') return abort();
        clientFin = true; tcp.end(); return;
      }
      item.sent = Math.min(Number.MAX_SAFE_INTEGER, item.sent + data.length);
      if (!tcp.write(data)) ws.pause();
      if (tcp.writableLength > FORWARD_LIMITS.buffer) abort('buffer_limit');
    });
    tcp.on('drain', () => { if (ws.readyState === 1) ws.resume(); });
    tcp.on('data', data => {
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live()) return tcp.destroy();
      if (ws.readyState !== 1) return tcp.destroy();
      item.received = Math.min(Number.MAX_SAFE_INTEGER, item.received + data.length);
      if (ws.bufferedAmount + data.length > FORWARD_LIMITS.buffer) return abort('buffer_limit');
      tcp.pause();
      for (let offset = 0; offset < data.length; offset += FORWARD_LIMITS.chunk) {
        pending++;
        ws.send(data.subarray(offset, offset + FORWARD_LIMITS.chunk), { binary: true }, error => {
          pending--; if (error) abort('helper_disconnected'); else if (!pending && !tcp.destroyed) tcp.resume();
        });
      }
    });
    tcp.once('end', () => { if (ws.readyState === 1) ws.send('{"type":"fin"}'); });
    tcp.once('error', error => {
      if (!live()) return;
      item.errorCode = connected ? 'target_disconnected' : error.code === 'ETIMEDOUT' ? 'target_timeout' : 'target_unavailable';
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', code: item.errorCode }), () => ws.close(1011, item.errorCode));
    });
    tcp.once('close', () => { clearTimeout(deadline); if (ws.readyState === 1) ws.close(1000); });
  }
  function upgrade(req, socket, head, pathname) {
    const deny = (status, code) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n${code ? 'X-Codex-Forward-Error: ' + code + '\r\n' : ''}Content-Length: 0\r\n\r\n`);
    refresh();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if (!match || req.headers['sec-websocket-protocol'] !== 'codex-forward-v1') return deny(401);
    const hash = digest(match[1]);
    if (pathname === '/forward/resume') {
      if (req.headers['x-codex-forward-resume'] !== '1') return deny(400, 'protocol_error');
      const item = [...mappings.values()].find(item => item.resumeHash && equal(item.resumeHash, hash));
      if (!item || !authorized(item)) {
        const ended = recent.find(item => item.resumeHash && equal(item.resumeHash, hash));
        return deny(401, ended?.code || 'resume_authorization_invalid');
      }
      if (item.state === 'connecting' && item.control?.readyState === 1) return deny(409, 'resume_busy');
      if (item.state !== 'recovering') suspend(item, item.control);
      if (!authorized(item)) return deny(401, invalidReason(item) || 'resume_authorization_invalid');
      if ((item.resumeAttempts || 0) >= FORWARD_LIMITS.resumeAttempts) { remove(item, 'resume_expired'); return deny(401, 'resume_expired'); }
      item.resumeAttempts = (item.resumeAttempts || 0) + 1; clearTimeout(item.timer); item.state = 'connecting';
      item.timer = setTimeout(() => remove(item, 'resume_expired'), Math.max(1, item.recoverUntil - now())).unref();
      const abandoned = () => { if (item.state === 'connecting' && !item.control) remove(item, 'resume_expired'); };
      socket.once('close', abandoned);
      try { controls.handleUpgrade(req, socket, head, ws => { socket.removeListener('close', abandoned); control(item, ws, true); }); } catch { remove(item, 'protocol_error'); socket.destroy(); }
      return;
    }
    if (pathname === '/forward/helper') {
      const capable = req.headers['x-codex-forward-resume'] === '1';
      if (req.headers['x-codex-forward-resume'] !== undefined && !capable) return deny(400, 'protocol_error');
      const item = [...mappings.values()].find(item => item.state === 'pending' && equal(item.pairHash, hash));
      if (!item || !authorized(item)) {
        const used = [...mappings.values()].some(value => equal(value.pairHash, hash));
        if (used) return deny(409, 'pair_used');
        const ended = recent.find(value => equal(value.pairHash, hash));
        if (ended?.code === 'pair_expired') return deny(410, 'pair_expired');
        if (ended) return deny(401, ['signed_out', 'authorization_expired', 'authorization_revoked'].includes(ended.code) ? ended.code : 'pair_used');
        return deny(401, 'pair_invalid');
      }
      // Reserve synchronously before upgrading: the pairing code is single-use.
      item.state = 'connecting';
      item.timer = setTimeout(() => remove(item, 'pairing_timeout'), 5000).unref();
      const abandoned = () => { if (!item.control) remove(item); };
      socket.once('close', abandoned);
      try { controls.handleUpgrade(req, socket, head, ws => { socket.removeListener('close', abandoned); control(item, ws, false, capable); }); } catch { remove(item); socket.destroy(); }
      return;
    }
    if (pathname !== '/forward/data') return deny(404);
    const item = [...mappings.values()].find(item => item.state === 'active' && equal(item.streamHash, hash));
    if (!item || !authorized(item)) return deny(401, 'stream_authorization_invalid');
    const reason = reserve(item); if (reason) return deny(429, reason);
    streams.handleUpgrade(req, socket, head, ws => transfer(item, ws));
  }
  function close() {
    clearInterval(timer); for (const item of mappings.values()) remove(item, 'server_stopping');
    controls.close(); streams.close();
    return Promise.allSettled([...peers].map(peer => peer.destroy()));
  }
  return { list, create, stop, revoke, refresh, upgrade, close };
}
