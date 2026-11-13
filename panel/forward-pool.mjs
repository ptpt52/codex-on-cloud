import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { equal } from './auth.mjs';
import { rtcOffer } from './rtc-network.mjs';
import { withHintCandidates } from './rtc-hints.mjs';
import { rtcAddress, rtcIPv6Address } from './rtc.mjs';
import { forwardHeartbeat } from './forward-heartbeat.mjs';
import { createForwardMux, MUX_LIMITS } from './forward-mux.mjs';
import { createPathQuality, pathPreferred, ROUTE_COOLDOWN } from './public/transport-policy.js';

// One pool per authenticated helper instance, never per browser or per rule.
// Its WSS is both the independent signaling link and a credited data standby.
// Losing that WSS closes only its logical streams; a healthy RTC survives.
export function createForwardPool({ config, scope, valid, configuration, connect, createPeer, acquire, release }) {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 48 * 1024 });
  const token = randomBytes(32).toString('base64url');
  let ws, mux, opening = false, ended = false, peer, peerId = 0, peerAt = -Infinity, configKey = '';
  let current = { available: false, reason: config.webrtc ? 'rtc_connecting' : 'rtc_disabled', family: null, rttMs: null };
  const relayQuality = createPathQuality(); let relayHealthy = () => false;
  const live = () => !ended && valid();
  function send(value) {
    if (!live() || ws?.readyState !== 1) return false;
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 48 * 1024 || ws.bufferedAmount + Buffer.byteLength(bytes) > MUX_LIMITS.buffer) { ws.terminate(); return false; }
    try { ws.send(bytes); return true; } catch { ws.terminate(); return false; }
  }
  function options() {
    const hints = configuration();
    return { type: 'rtc_config', enabled: !!config.webrtc && hints.active, ipv6: !!config.webrtcIPv6, stun: config.webrtcStunUrl || '', window: 16, preflight: 1,
      hints: { server: hints.server[0] || '', browser: hints.browser[0] || '' }, hintRevision: createHash('sha256').update(JSON.stringify([hints.server, hints.browser])).digest('hex') };
  }
  function configure() {
    if (!live()) return;
    const value = options(), key = JSON.stringify(value);
    if (key !== configKey && send(value)) configKey = key;
    if (!value.enabled && peer && !peer.streams) void peer.destroy('rtc_disabled');
  }
  function report(state) { current = state; send({ type: 'rtc_status', ...state }); }
  async function negotiate(link, value) {
    const rejected = reason => {
      if (ws !== link) return;
      const state = { id: value.id, available: false, reason, family: null, rttMs: null };
      if (!peer) current = state;
      send({ type: 'rtc_status', ...state });
    };
    if (Object.keys(value).sort().join(',') !== 'id,sdp,type' || !Number.isInteger(value.id) || value.id <= peerId || value.id > 2147483647) return link.terminate();
    if (!options().enabled) return rejected('rtc_disabled');
    if (performance.now() - peerAt < 10000 || peer?.streams || !acquire(!!peer)) return rejected('rtc_busy');
    try {
      const hints = configuration();
      let offer = rtcOffer({ type: 'offer', sdp: value.sdp }, { ipv6: !!config.webrtcIPv6 });
      offer = withHintCandidates(offer, hints.browser, { ipv6: !!config.webrtcIPv6 });
      peerAt = performance.now();
      await peer?.destroy();
      if (!live() || ws !== link) return;
      const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress || '127.0.0.1';
      const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
      peerId = value.id;
      let candidate;
      const directQuality = createPathQuality(); let preferred = 'direct', wins = 0, changedAt = -Infinity;
      const prefer = rttMs => {
        if (!Number.isFinite(rttMs) || rttMs < 0) return preferred === 'direct';
        directQuality.sample(rttMs);
        // An unavailable WSS can never prevent a healthy direct open.
        if (!relayHealthy()) { wins = 0; return true; }
        const candidatePath = preferred === 'direct' ? 'relay' : 'direct';
        const candidateMs = candidatePath === 'direct' ? directQuality.rttMs : relayQuality.rttMs;
        const currentMs = preferred === 'direct' ? directQuality.rttMs : relayQuality.rttMs;
        wins = pathPreferred({ candidateMs, currentMs, candidate: candidatePath }) ? Math.min(2, wins + 1) : 0;
        if (wins >= 2 && performance.now() - changedAt >= ROUTE_COOLDOWN) { preferred = candidatePath; changedAt = performance.now(); wins = 0; }
        return preferred === 'direct';
      };
      candidate = createPeer({ address, ipv6Address, stunUrl: config.webrtcStunUrl, id: value.id, shared: true,
        prefer,
        valid: () => live() && peer === candidate,
        authenticate: value => live() && typeof value === 'string' && value.length === 43 && equal(value, token),
        connect: (socket, record) => { if (!live() || peer !== candidate) return socket.terminate(); connect(socket, record); },
        status: state => { if (peer === candidate && live()) report(state); },
        closed: () => { if (peer === candidate) peer = undefined; } });
      peer = candidate; report(peer.state);
      const sdp = withHintCandidates({ type: 'answer', sdp: await candidate.answer(offer) }, hints.server, { ipv6: !!ipv6Address }).sdp;
      if (live() && ws === link && peer === candidate) send({ type: 'rtc_answer', id: value.id, typeDescription: 'answer', sdp });
    } catch { rejected('rtc_negotiation_failed'); }
    finally { release(); }
  }
  function upgrade(req, socket, head) {
    if (!live() || opening || ws?.readyState === 1) { socket.end(`HTTP/1.1 409 Rejected\r\n${config.nodeId ? 'X-Codex-Node-Id: ' + config.nodeId + '\r\n' : ''}X-Codex-Forward-Error: resume_busy\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    opening = true;
    const abandoned = () => { opening = false; };
    socket.once('close', abandoned);
    try { server.handleUpgrade(req, socket, head, link => {
      socket.removeListener('close', abandoned); opening = false;
      if (!live()) return link.terminate();
      ws = link; configKey = '';
      let healthAt = -Infinity, nonce = 0, pending = 0, sentAt, deadline, lastAt = performance.now(), messages = 0;
      const healthy = () => live() && ws === link && performance.now() - healthAt < 10000;
      relayHealthy = healthy; relayQuality.clear();
      const localMux = createForwardMux(link, { valid: () => live() && ws === link, healthy, connect }); mux = localMux;
      const ping = () => {
        if (pending) return;
        if (!live() || ws !== link || nonce >= 2147483647) return link.terminate();
        pending = ++nonce; sentAt = performance.now(); send({ type: 'pool-ping', id: pending });
        const expire = () => {
          // Credited business records also prove application progress. A busy
          // WSS must not be killed because its text Pong waits behind data.
          const remaining = 6000 - (performance.now() - Math.max(sentAt, healthAt));
          if (remaining > 0) deadline = setTimeout(expire, remaining).unref(); else link.terminate();
        };
        deadline = setTimeout(expire, 6000).unref();
      };
      const interval = setInterval(ping, 3000).unref();
      forwardHeartbeat(link, () => link.terminate());
      link.on('error', () => link.terminate());
      link.once('close', () => {
        clearInterval(interval); clearTimeout(deadline); localMux.close();
        if (ws === link) { ws = undefined; mux = undefined; }
      });
      link.on('message', (bytes, binary) => {
        if (!live() || ws !== link) return link.terminate();
        try {
          if (binary) { localMux.receive(bytes); healthAt = performance.now(); return; }
          if (performance.now() - lastAt >= 10000) { lastAt = performance.now(); messages = 0; }
          if (++messages > 40) throw Error();
          const value = JSON.parse(bytes.toString());
          if (value?.type === 'pool-pong' && Object.keys(value).sort().join(',') === 'id,type' && pending && value.id === pending) {
            pending = 0; clearTimeout(deadline); healthAt = performance.now(); relayQuality.sample(healthAt - sentAt); return;
          }
          if (value?.type === 'rtc_offer') { void negotiate(link, value); return; }
          if (['rtc_failed', 'rtc_drain'].includes(value?.type) && Object.keys(value).sort().join(',') === 'id,type' && value.id === peerId) {
            if (value.type === 'rtc_drain') peer?.drain(); else peer?.unhealthy('rtc_channel_failed'); return;
          }
          throw Error();
        } catch { link.terminate(); }
      });
      send({ type: 'pool-ready', version: 1, id: scope.id, token }); configure();
      if (peer) send({ type: 'rtc_status', ...peer.state });
      ping();
    }); } catch { opening = false; socket.destroy(); }
  }
  function close() {
    if (ended) return;
    ended = true; mux?.close(); ws?.terminate(); server.close(); return peer?.destroy();
  }
  return { scope, upgrade, configure, close, get state() { return peer?.streams >= 24 && current.available ? { ...current, available: false, reason: 'rtc_busy' } : current; } };
}
