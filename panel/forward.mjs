import net from 'node:net';
import { serialConfig } from './serial-config.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { equal } from './auth.mjs';
import { FORWARD_ERRORS } from './forward-errors.mjs';
import { createForwardPeer } from './forward-rtc.mjs';
import { rtcOffer } from './rtc-network.mjs';
import { rtcAddress, rtcIPv6Address } from './rtc.mjs';
import { rtcHints, withHintCandidates } from './rtc-hints.mjs';
import { createReverseForwarding } from './reverse-forward.mjs';
import { forwardHeartbeat as heartbeat } from './forward-heartbeat.mjs';

export const FORWARD_LIMITS = Object.freeze({ mappings: 4, managedMappings: 32, connections: 8, chunk: 16384, buffer: 256 * 1024, pairMs: 120000, resumeMs: 30000, resumeAttempts: 8, recent: 8, recentMs: 10 * 60000, closing: 8 });
const fail = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export function forwardDeviceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 48 || Buffer.byteLength(value) > 192 || /[\p{Cc}\p{Cf}]/u.test(value)) throw fail(400, '设备名称需为 1–48 个字符，不含控制字符');
  return value.trim();
}
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

// Forwarding has its own lifetime: screen locking, takeover, and desktop
// reconnect/mode changes preserve its grants and both existing/new TCP streams.
// Negotiated recovery preserves healthy data within the original grant/budget.
export function createForwarding(config, { now = Date.now, createPeer = config.forwardPeerFactory || createForwardPeer } = {}) {
  const mappings = new Map(), recent = [], retiring = new Map(), peers = new Set();
  let negotiating = false;
  const controls = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 48 * 1024 });
  const streams = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: FORWARD_LIMITS.chunk });
  const blockedPort = port => [config.port, config.agentPort, config.fileAgentPort, config.tunnelMetricsPort].includes(port);
  const allPorts = () => (config.forwardPorts ?? '*') === '*';
  const ports = () => (allPorts() ? [22] : config.forwardPorts).filter(port => !blockedPort(port));
  const invalidReason = item => item.authorizationError() || (item.state === 'pending' && item.expires <= now() ? 'pair_expired' : '') ||
    (item.recoverUntil && item.recoverUntil <= now() ? 'resume_expired' : '');
  const authorized = item => mappings.get(item.id) === item && !invalidReason(item);
  const active = item => authorized(item) && item.state === 'active' && item.control?.readyState === 1;
  const streamLive = (item, stream) => authorized(item) && item.streams.has(stream) && (item.keepStreams && stream.established || active(item) && stream.generation === item.generation);
  const reverse = createReverseForwarding({ limits: FORWARD_LIMITS, active, authorized, streamLive, invalidReason, remove, retire, send, reserve, now });
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
    if (item.direction === 'reverse') reverse.disconnect(item);
    item.streamHash = undefined;
    item.streamToken = undefined;
    const peer = item.peer; item.peer = null;
    void peer?.destroy();
    for (const stream of item.streams) { stream.ws?.terminate(); stream.tcp.destroy(); }
    item.streams.clear();
    item.directClient = false; item.direct = undefined;
  }
  function remove(item, code = 'helper_disconnected') {
    if (mappings.get(item.id) !== item) return;
    mappings.delete(item.id); clearTimeout(item.timer);
    disconnectStreams(item);
    recent.unshift({ id: item.id, session: item.session, helperId: item.authorization.helperId, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, ...details(item), code, endedAt: now(), pairHash: item.pairHash, resumeHash: item.resumeHash });
    recent.splice(FORWARD_LIMITS.recent);
    if (item.control) retire(item.control, code);
  }
  function suspend(item, ws, code = 'helper_disconnected') {
    if (mappings.get(item.id) !== item || item.control !== ws) return;
    const invalid = invalidReason(item);
    if (invalid || !item.resumeHash || item.direction === 'reverse' && !item.localApproved) return remove(item, invalid || code);
    item.control = null; item.state = 'recovering'; item.errorCode = 'helper_reconnecting';
    item.recoverUntil ||= now() + FORWARD_LIMITS.resumeMs;
    clearTimeout(item.timer);
    if (item.keepStreams) {
      for (const stream of item.streams) if (!stream.established) { clearTimeout(stream.timer); stream.ws?.terminate(); stream.tcp.destroy(); item.streams.delete(stream); }
    } else disconnectStreams(item);
    item.timer = setTimeout(() => remove(item, invalidReason(item) || 'resume_expired'), Math.max(1, item.recoverUntil - now())).unref();
    retire(ws, 'helper_reconnecting');
  }
  function refresh() {
    for (const item of mappings.values()) { const code = invalidReason(item); if (code) remove(item, code); }
    for (let i = recent.length - 1; i >= 0; i--) if (now() - recent[i].endedAt >= FORWARD_LIMITS.recentMs) recent.splice(i, 1);
  }
  function revoke(session) { for (const item of mappings.values()) if (item.session === session) remove(item, 'signed_out'); }
  const timer = setInterval(refresh, 5000).unref();
  function details(item) { return item.direction === 'reverse' ? { direction: 'reverse', deviceName: item.deviceName, deviceId: item.deviceId, protocol: item.protocol, ...(item.serial ? { serial: item.serial } : {}), targetStatus: item.targetStatus || { state: 'unverified' } } : { targetStatus: item.targetStatus || { state: 'unverified' } }; }
  function list(visible = () => true, viewer) {
    if (typeof visible !== 'function') visible = () => true;
    refresh();
    return { ports: ports(), allPorts: allPorts(), limit: FORWARD_LIMITS.mappings, maxConnections: FORWARD_LIMITS.connections,
      mappings: [...mappings.values()].filter(visible).map(item => ({ id: item.id, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, ...details(item),
        createdAt: item.createdAt, authorization: { expiresAt: item.authorization.expiresAt ?? null, role: item.authorization.role || 'admin', createdHere: item.session === viewer, ...(item.authorization.helperId ? { helperId: item.authorization.helperId, ruleId: item.authorization.ruleId } : {}) },
        hints: { ...item.hints }, maxConnections: item.serial ? 1 : FORWARD_LIMITS.connections,
        state: item.state, expires: item.state === 'pending' ? item.expires : null, recoverUntil: item.recoverUntil || null, connections: item.streams.size, sent: item.sent, received: item.received, errorCode: item.errorCode || '', error: FORWARD_ERRORS[item.errorCode] || '',
        direct: { ...(item.direct || { available: false, reason: config.webrtc ? 'rtc_waiting_helper' : 'rtc_disabled' }), note: FORWARD_ERRORS[item.direct ? item.direct.reason : config.webrtc ? 'rtc_waiting_helper' : 'rtc_disabled'] || '' }, directConnections: [...item.streams].filter(stream => stream.ws?.transport === 'direct').length })),
      recent: recent.filter(visible).map(({ pairHash: _pair, resumeHash: _resume, session: _session, ...item }) => ({ ...item, error: FORWARD_ERRORS[item.code] })) };
  }
  function normalize(body, policy = true) {
    let hints;
    try { hints = rtcHints(body?.hints); } catch (error) { throw fail(400, error.message); }
    if (body && Object.hasOwn(body, 'hints')) { body = { ...body }; delete body.hints; }
    const reversed = body?.direction === 'reverse', serial = reversed && body.protocol === 'serial' ? serialConfig(body.serial) : null;
    const fieldsValid = serial ? Object.keys(body).sort().join(',') === 'deviceName,direction,localPort,protocol,serial' : body && (reversed ? Object.keys(body).every(key => ['direction', 'localPort', 'targetHost', 'targetPort', 'deviceName', 'deviceId', 'protocol'].includes(key)) : ['localPort,targetPort', 'localPort,targetHost,targetPort'].includes(Object.keys(body).sort().join(',')));
    if (!fieldsValid || !Number.isInteger(body.localPort) || body.localPort < 1024 || body.localPort > 65535 || policy && reversed && blockedPort(body.localPort)) throw fail(400, '监听端口需在 1024–65535 之间，不能占用工作台管理端口');
    if (!serial && (!Number.isInteger(body.targetPort) || body.targetPort < 1 || body.targetPort > 65535 || policy && (!reversed && blockedPort(body.targetPort) || !allPorts() && !ports().includes(body.targetPort)))) throw fail(400, '目标端口需在 1–65535 之间且符合服务器端口限制，不能映射工作台管理端口');
    const targetHost = serial ? undefined : forwardTargetHost(body.targetHost);
    const deviceName = reversed ? forwardDeviceName(body.deviceName ?? '本地设备') : undefined;
    if (reversed && (body.deviceId !== undefined && (typeof body.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(body.deviceId)) || body.protocol !== undefined && !['ssh', 'telnet', 'tcp', 'serial'].includes(body.protocol))) throw fail(400, '设备标识或协议无效');
    body = { ...body, ...(!serial ? { targetHost } : {}), ...(reversed ? { deviceName } : {}) };
    return { body, hints, reversed, serial, targetHost, deviceName };
  }
  function validate(body, { policy = true } = {}) { const value = normalize(body, policy); return { ...value.body, hints: value.hints }; }
  function create(body, session, authorizationError, authorization = {}) {
    refresh();
    const value = normalize(body), { hints, reversed, serial, targetHost, deviceName } = value; body = value.body;
    if (authorizationError()) throw fail(401, '登录授权已失效，请重新登录');
    if (mappings.size >= FORWARD_LIMITS.managedMappings || !authorization.helperId && [...mappings.values()].filter(item => !item.authorization.helperId).length >= FORWARD_LIMITS.mappings) throw fail(409, authorization.helperId ? '活动映射已达到 32 条上限，请先停用不用的规则' : '最多保留 4 个映射，请先停止不用的映射');
    if ([...mappings.values()].some(item => item.direction === (reversed ? 'reverse' : undefined) && item.localPort === body.localPort && (reversed || item.session === session))) throw fail(409, '该监听端口已有待配对或活动映射');
    const code = secret(), item = { id: randomBytes(16).toString('hex'), session, hints, authorizationError, authorization, createdAt: now(), pairHash: digest(code), expires: now() + FORWARD_LIMITS.pairMs,
      localPort: body.localPort, targetHost, targetPort: serial ? undefined : body.targetPort, ...(serial ? { serial } : {}), ...(reversed ? { direction: 'reverse', deviceName, deviceId: body.deviceId, protocol: body.protocol || 'tcp' } : {}), state: 'pending', streams: new Set(), sent: 0, received: 0, opens: 0, openedAt: now(), peerId: 0, peerAt: -Infinity };
    mappings.set(item.id, item);
    return { id: item.id, code, expires: item.expires, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, ...details(item) };
  }
  function stop(body, allowed = () => true) {
    if (Object.keys(body).join(',') !== 'id' || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) throw fail(400, '映射标识无效');
    const item = mappings.get(body.id);
    if (item && !allowed(item)) throw fail(403, '当前登录无权操作此映射');
    if (item) remove(item, 'stopped');
    return { ok: true };
  }
  function updateHints(body, allowed) {
    if (!body || Object.keys(body).sort().join(',') !== 'hints,id' || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) throw fail(400, '映射参数无效');
    const item = mappings.get(body.id);
    if (!item) throw fail(404, '映射已结束');
    if (!authorized(item) || !allowed(item)) throw fail(403, '当前登录无权操作此映射');
    try { item.hints = rtcHints(body.hints); } catch (error) { throw fail(400, error.message); }
    if (active(item) && item.directClient) sendConfig(item);
    return { ok: true };
  }
  function sendConfig(item) { send(item, { type: 'rtc_config', enabled: !!config.webrtc, ipv6: !!config.webrtcIPv6, stun: config.webrtcStunUrl || '', hints: item.hints }); }
  function control(item, ws, resume = false, capable = false) {
    // Reverse helpers wait for local consent before heartbeats are installed.
    // Handle receiver errors from the first frame, including resume handshakes;
    // close still owns the existing removal/recovery and stream cleanup rules.
    ws.on('error', () => ws.terminate());
    clearTimeout(item.timer);
    item.activating = false;
    item.control = ws; item.generation = (item.generation || 0) + 1;
    if (!resume || !item.keepStreams) { item.peerId = 0; item.peerAt = -Infinity; }
    if (item.direction !== 'reverse') heartbeat(ws, () => suspend(item, ws, 'heartbeat_timeout'));
    const activateMs = item.direction === 'reverse' && !resume ? 60000 : 5000;
    item.timer = setTimeout(() => suspend(item, ws, item.direction === 'reverse' && !resume ? 'reverse_confirm_timeout' : 'pairing_timeout'), Math.min(activateMs, item.recoverUntil ? Math.max(1, item.recoverUntil - now()) : activateMs)).unref();
    const token = resume && item.keepStreams ? item.streamToken : secret(); item.streamHash = digest(token);
    // At most four mapping-scoped secrets, memory only, retained solely for a
    // negotiated management resume. They never appear in list/history/logs.
    if (item.keepStreams) item.streamToken = token;
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
      if (item.direction === 'reverse' && item.state === 'connecting' && value?.type === 'error' && Object.keys(value).sort().join(',') === 'code,type' && value.code === 'reverse_denied') return remove(item, 'reverse_denied');
      if (item.state === 'active' && item.directClient) {
        if (value?.type === 'rtc_offer') { void negotiate(item, value); return; }
        if (value?.type === 'rtc_failed' && Object.keys(value).sort().join(',') === 'id,type' && value.id === item.peerId) { item.peer?.unhealthy('rtc_channel_failed'); return; }
        if (value?.type === 'rtc_drain' && Object.keys(value).sort().join(',') === 'id,type' && value.id === item.peerId) { item.peer?.drain(); return; }
      }
      if (item.state === 'connecting' && value && Object.keys(value).sort().join(',') === 'code,type' && value.type === 'error' && ['local_port_in_use', 'local_listen_failed'].includes(value.code)) return remove(item, value.code);
      if (item.state !== 'connecting' || item.activating || !value || !['type', 'direct,type'].includes(Object.keys(value).sort().join(',')) || value.type !== 'listening' || (Object.hasOwn(value, 'direct') && value.direct !== 1)) return remove(item, 'protocol_error');
      item.activating = true;
      if (item.direction === 'reverse') item.localApproved = true;
      const generation = item.generation, current = () => authorized(item) && item.control === ws && item.generation === generation && item.state === 'connecting';
      const activate = () => {
        if (!current()) return;
        clearTimeout(item.timer); item.activating = false; item.state = 'active'; item.recoverUntil = undefined; item.resumeAttempts = 0; item.errorCode = ''; ws.send('{"type":"listening"}');
        item.directClient = value.direct === 1;
        if (item.direction === 'reverse') heartbeat(ws, () => suspend(item, ws, 'heartbeat_timeout'));
        if (item.directClient) sendConfig(item);
        if (item.directClient && item.peer) send(item, { type: 'rtc_status', ...item.peer.state });
      };
      if (item.direction === 'reverse') void reverse.start(item, current).then(activate).catch(() => {});
      else activate();
    });
    ws.send(JSON.stringify({ type: 'ready', version: 1, id: item.id, streamToken: token, localPort: item.localPort, targetHost: item.targetHost, targetPort: item.targetPort, maxConnections: item.serial ? 1 : FORWARD_LIMITS.connections, ...(item.serial ? { serial: item.serial, serialProtocol: 1, protocol: 'serial' } : {}), directProtocol: 1,
      ...(item.direction === 'reverse' ? { direction: 'reverse', reverseProtocol: 1, deviceName: item.deviceName } : {}),
      ...(item.resumeHash ? { resumeProtocol: 1, ...(item.keepStreams ? { keepStreamsProtocol: 1 } : {}), resumeMs: item.recoverUntil ? Math.max(1, item.recoverUntil - now()) : FORWARD_LIMITS.resumeMs, ...(resumeToken ? { resumeToken } : {}) } : {}) }));
  }
  function send(item, record) {
    // Preserved peers may report health during a resume handshake. Cache that
    // status, but never interleave it with ready/listening authorization records.
    if (!active(item)) return;
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
    const hints = { ...item.hints };
    let offer; try { offer = withHintCandidates(rtcOffer({ type: 'offer', sdp: value.sdp }, { ipv6: !!config.webrtcIPv6 }), hints.browser, { ipv6: !!config.webrtcIPv6 }); } catch { return rejected('rtc_negotiation_failed'); }
    negotiating = true; item.peerAt = now();
    try {
      await item.peer?.destroy();
      if (!current()) return;
      const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress || '127.0.0.1';
      const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
      let peer;
      item.peerId = value.id;
      const live = () => authorized(item) && item.peer === peer && (item.keepStreams || current());
      peer = createPeer({ address, ipv6Address, id: value.id, valid: live,
        authenticate: token => active(item) && live() && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && equal(digest(token), item.streamHash),
        status: state => { if (live()) report(item, state); }, closed: () => { if (item.peer === peer) item.peer = null; },
        reverse: item.direction === 'reverse',
        connect: (socket, id) => { if (!active(item) || !live()) return socket.terminate(); if (item.direction === 'reverse') return reverse.transfer(item, socket, id); const reason = reserve(item); if (reason) { item.errorCode = reason; socket.close(4000, reason); } else transfer(item, socket); } });
      peers.add(peer); const destroy = peer.destroy;
      peer.destroy = reason => { const result = destroy(reason); if (result) void Promise.resolve(result).finally(() => peers.delete(peer)); return result; };
      item.peer = peer; report(item, peer.state);
      const sdp = withHintCandidates({ type: 'answer', sdp: await peer.answer(offer) }, hints.server, { ipv6: !!ipv6Address }).sdp;
      if (current() && item.peer === peer) send(item, { type: 'rtc_answer', id: value.id, typeDescription: 'answer', sdp });
    } catch { rejected('rtc_negotiation_failed'); }
    finally { negotiating = false; }
  }
  function reserve(item) {
    if (now() - item.openedAt >= 10000) { item.openedAt = now(); item.opens = 0; }
    if (item.streams.size >= (item.serial ? 1 : FORWARD_LIMITS.connections)) return item.serial ? 'serial_busy' : 'connection_limit';
    if (++item.opens > 32) return 'rate_limit';
    return '';
  }
  function transfer(item, ws) {
    const tcp = net.createConnection({ host: item.targetHost, port: item.targetPort, allowHalfOpen: true, highWaterMark: 32768 });
    const stream = { ws, tcp, generation: item.generation, established: false }; item.streams.add(stream); if (ws.transport !== 'direct') heartbeat(ws, code => abort(code));
    const live = () => streamLive(item, stream);
    let connected = false, clientFin = false, pending = 0;
    const deadline = setTimeout(() => tcp.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), 5000).unref();
    const abort = (code = 'protocol_error') => { if (live()) item.errorCode = code; tcp.destroy(); retire(ws, code); };
    ws.once('close', () => { clearTimeout(deadline); tcp.destroy(); item.streams.delete(stream); });
    tcp.once('connect', () => {
      clearTimeout(deadline);
      if (!authorized(item)) return remove(item, invalidReason(item) || 'authorization_revoked');
      if (!live()) return tcp.destroy();
      connected = stream.established = true; item.targetStatus = { state: 'reachable', at: now() }; item.errorCode = ''; tcp.setNoDelay(true); tcp.setKeepAlive(true, 30000); ws.send('{"type":"ready"}');
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
      item.targetStatus = { state: 'failed', at: now() };
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
      if (item.serial && req.headers['x-codex-forward-serial'] !== '1') { item.errorCode = 'serial_upgrade_required'; return deny(426, 'serial_upgrade_required'); }
      if (item.keepStreams && req.headers['x-codex-forward-keep-streams'] !== '1') return deny(400, 'protocol_error');
      if (item.direction === 'reverse' && req.headers['x-codex-forward-reverse'] !== '1') return deny(426, 'reverse_upgrade_required');
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
      if (req.headers['x-codex-forward-keep-streams'] !== undefined && (!capable || req.headers['x-codex-forward-keep-streams'] !== '1')) return deny(400, 'protocol_error');
      const item = [...mappings.values()].find(item => item.state === 'pending' && equal(item.pairHash, hash));
      if (!item || !authorized(item)) {
        const used = [...mappings.values()].some(value => equal(value.pairHash, hash));
        if (used) return deny(409, 'pair_used');
        const ended = recent.find(value => equal(value.pairHash, hash));
        if (ended?.code === 'pair_expired') return deny(410, 'pair_expired');
        if (ended) return deny(401, ['signed_out', 'authorization_expired', 'authorization_revoked'].includes(ended.code) ? ended.code : 'pair_used');
        return deny(401, 'pair_invalid');
      }
      if (item.serial && req.headers['x-codex-forward-serial'] !== '1') { item.errorCode = 'serial_upgrade_required'; return deny(426, 'serial_upgrade_required'); }
      if (item.direction === 'reverse' && req.headers['x-codex-forward-reverse'] !== '1') return deny(426, 'reverse_upgrade_required');
      // Reserve synchronously before upgrading: the pairing code is single-use.
      item.keepStreams = capable && req.headers['x-codex-forward-keep-streams'] === '1';
      item.state = 'connecting';
      item.timer = setTimeout(() => remove(item, 'pairing_timeout'), item.direction === 'reverse' ? 60000 : 5000).unref();
      const abandoned = () => { if (!item.control) remove(item); };
      socket.once('close', abandoned);
      try { controls.handleUpgrade(req, socket, head, ws => { socket.removeListener('close', abandoned); control(item, ws, false, capable); }); } catch { remove(item); socket.destroy(); }
      return;
    }
    if (pathname !== '/forward/data') return deny(404);
    const item = [...mappings.values()].find(item => item.state === 'active' && equal(item.streamHash, hash));
    if (!item || !authorized(item)) return deny(401, 'stream_authorization_invalid');
    if (item.direction === 'reverse') {
      const id = req.headers['x-codex-reverse-stream'];
      if (!reverse.waiting(item, id)) return deny(401, 'stream_authorization_invalid');
      streams.handleUpgrade(req, socket, head, ws => reverse.transfer(item, ws, id)); return;
    }
    const reason = reserve(item); if (reason) return deny(429, reason);
    streams.handleUpgrade(req, socket, head, ws => transfer(item, ws));
  }
  function close() {
    const listeners = [];
    clearInterval(timer); for (const item of mappings.values()) { remove(item, 'server_stopping'); if (item.listenerClosing) listeners.push(item.listenerClosing); }
    controls.close(); streams.close();
    return Promise.allSettled([...listeners, ...[...peers].map(peer => peer.destroy())]);
  }
  return { list, create, validate, stop, updateHints, revoke, refresh, upgrade, close };
}
