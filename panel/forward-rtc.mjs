import { RTCPeerConnection } from 'werift';
import { peerAddress, rtcIceConfiguration } from './rtc-network.mjs';
import { rtcDirectKind } from './public/rtc-stats.js';
import { guardIceAgent } from './rtc-guard.mjs';
import { forwardChannel } from './forward-channel.mjs';
import { guardSCTP } from './rtc-sctp.mjs';
import { createFlowBudget } from './flow-budget.mjs';
import { createRTCWriter } from './rtc-writer.mjs';
import { validTransferWindow } from './public/transfer-window.js';
import { createHeartbeatPolicy } from './public/health.js';
import { heartbeatProgress, HEARTBEAT_CONGESTION_GRACE } from './public/transport-policy.js';
export { guardSCTP as guardForwardSCTP } from './rtc-sctp.mjs';

export function forwardNegotiationFailure(pc) {
  if (!['connected', 'completed'].includes(pc.iceConnectionState)) return 'rtc_ice_timeout';
  if (!pc.dtlsTransports.some(transport => transport.state === 'connected')) return 'rtc_dtls_timeout';
  return 'rtc_auth_timeout';
}

// Managed rules share one helper peer; one-time mappings retain their own peer.
// Unhealthy peers stop receiving new streams; existing streams never migrate.
export function createForwardPeer({ address, ipv6Address, remoteHints = [], stunUrl = '', id, valid, authenticate, connect, status, closed, reverse = false, shared = false, prefer = () => true, maxWindow = 8, flowBudget = createFlowBudget() }) {
  const healthPolicy = createHeartbeatPolicy(); let progressAt = -Infinity;
  if (!validTransferWindow(maxWindow)) throw Error('Invalid maximum forward window');
  const allowed = host => peerAddress(host, !!ipv6Address, remoteHints);
  const { stun, ...ice } = rtcIceConfiguration(stunUrl);
  const pc = new RTCPeerConnection({ ...ice, iceUseIpv4: true, iceUseIpv6: !!ipv6Address, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: address, ...(ipv6Address ? { udp6: ipv6Address } : {}) }, icePortRange: [40016, 40047],
    iceFilterStunResponse: (_message, [host]) => allowed(host), iceFilterCandidatePair: pair => allowed(pair.remoteCandidate.host), maxMessageSize: 16384 });
  const sockets = new Set();
  const budget = flowBudget;
  const writer = createRTCWriter({ valid: () => authorized(), failed: () => { void handle.destroy('buffer_limit'); } });
  let window = 4, preflight = false;
  let ended = false, closing, control, authenticated = false, draining = false, timer, pingTimer, deadline, nonce = 0, pending = 0, sentAt = 0, successes = 0;
  let current = { id, available: false, family: null, rttMs: null, reason: 'rtc_connecting' };
  const authorized = () => !ended && valid();
  const report = (available, reason, rttMs = null) => {
    if (ended) return;
    const connection = pc.iceTransports[0]?.connection, pair = connection?.nominated, host = pair?.remoteCandidate.host;
    const family = available && host ? host.includes(':') ? 'IPv6' : 'IPv4' : null;
    const endpoint = candidate => ({ address: candidate?.host, type: candidate?.type });
    const mapped = pair && connection.reflexiveBySocket.get(pair.protocol);
    const local = mapped && (mapped.host !== pair.localCandidate.host || mapped.port !== pair.localCandidate.port) ? mapped : pair?.localCandidate;
    const preferred = prefer(rttMs);
    current = { id, available: available && preferred, healthy: successes >= 2, reason: available && !preferred ? 'rtc_path_slower' : reason, rttMs, family, window,
      route: available ? rtcDirectKind({ family, local: endpoint(local), remote: endpoint(pair.remoteCandidate) }) : 'unknown' };
    status(current);
    // Keep actual direct-path health independent of the pooled WSS. The
    // helper can admit new direct streams while signaling is reconnecting.
    if (shared && authenticated && control?.readyState === 'open') {
      try { if (control.bufferedAmount > 4096) throw Error(); control.send(JSON.stringify({ type: 'rtc_status', ...current })); } catch { queueMicrotask(() => { void handle.destroy(); }); }
    }
  };
  const handle = {
    get state() { return current; },
    get streams() { return sockets.size; },
    unhealthy(reason) { successes = 0; report(false, reason); },
    drain() { draining = true; report(false, 'rtc_draining'); },
    destroy(reason = 'rtc_unavailable') {
      if (ended) return closing;
      successes = 0; report(false, reason); ended = true;
      clearTimeout(timer); clearTimeout(pingTimer); clearTimeout(deadline);
      for (const socket of sockets) socket.terminate();
      control?.close(); writer.close(); budget.close(); closed(); closing = pc.close().catch(() => {}); return closing;
    },
    async answer(offer) {
      try {
        await pc.setRemoteDescription(offer);
        guardSCTP(pc.sctpTransport?.sctp, authorized, () => { void handle.destroy('buffer_limit'); });
        for (const transport of pc.iceTransports) guardIceAgent(transport.connection, { valid: authorized, allowed, stun });
        if (!authorized()) throw new Error('Revoked');
        await pc.setLocalDescription(await pc.createAnswer());
        if (!authorized() || Buffer.byteLength(pc.localDescription.sdp) > 32768) throw new Error('Revoked or oversized');
        return pc.localDescription.sdp;
      } catch { await handle.destroy('rtc_negotiation_failed'); throw new Error('Direct negotiation failed'); }
    },
  };
  function probe() {
    if (!authorized() || !authenticated || control?.readyState !== 'open' || control.bufferedAmount > 4096 || nonce >= 2147483647) return void handle.destroy();
    const bytes = Buffer.alloc(4); pending = ++nonce; bytes.writeUInt32BE(pending); sentAt = performance.now();
    try { control.send(bytes); } catch { return void handle.destroy(); }
    let deferred = false;
    const expire = () => {
      if (!authorized() || !pending) return;
      if (!deferred && heartbeatProgress(sentAt, progressAt)) { deferred = true; deadline = setTimeout(expire, HEARTBEAT_CONGESTION_GRACE).unref(); return; }
      pending = 0; successes = 0; report(false, 'rtc_health_timeout');
      // A healthy existing TCP stream can outlive a delayed probe. Probe again
      // without replacing its peer or allocating any target connection.
      pingTimer = setTimeout(probe, 3000).unref();
    };
    deadline = setTimeout(expire, healthPolicy.timeoutMs).unref();
  }
  timer = setTimeout(() => { void handle.destroy(forwardNegotiationFailure(pc)); }, 14000).unref();
  pc.connectionStateChange.subscribe(state => {
    if (state === 'disconnected') handle.unhealthy('rtc_unavailable');
    if (['closed', 'failed'].includes(state)) void handle.destroy(authenticated ? 'rtc_unavailable' : forwardNegotiationFailure(pc));
  });
  pc.onDataChannel.subscribe(channel => {
    if (!authorized() || !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) return void handle.destroy('protocol_error');
    if (channel.label === 'codex-forward-health' && channel.protocol === 'forward-health-v1' && !control) {
      control = writer.channel(channel, { control: true });
      let windowStart = performance.now(), received = 0;
      channel.onMessage.subscribe(bytes => {
        if (!authorized()) return void handle.destroy();
        if (performance.now() - windowStart >= 1000) { windowStart = performance.now(); received = 0; }
        if (++received > 8) return void handle.destroy('protocol_error');
        if (!authenticated) {
          let record; try { if (Buffer.isBuffer(bytes) || Buffer.byteLength(bytes) > 256) throw new Error(); record = JSON.parse(bytes); } catch { return void handle.destroy('protocol_error'); }
          const fields = record && Object.keys(record).sort().join(',');
          if (!record || !['id,token,type', 'id,token,type,window', 'id,preflight,token,type,window'].includes(fields) || record.type !== 'auth' || record.id !== id || !authenticate(record.token) || record.window !== undefined && !validTransferWindow(record.window) || record.preflight !== undefined && record.preflight !== 1) return void handle.destroy('protocol_error');
          window = Math.min(record.window ?? 4, maxWindow);
          preflight = record.preflight === 1;
          authenticated = true; clearTimeout(timer);
          try { control.send(JSON.stringify({ type: 'ready', ...(record.window === undefined ? {} : { window, peerWindowBytes: 512 * 1024 }), ...(preflight ? { preflight: 1 } : {}) })); } catch { return void handle.destroy(); }
          probe(); return;
        }
        if (!Buffer.isBuffer(bytes) || bytes.length !== 4) return void handle.destroy('protocol_error');
        const echo = bytes.readUInt32BE();
        if (echo <= nonce && (!pending || echo < pending)) return;
        if (!pending || echo !== pending) return void handle.destroy('protocol_error');
        pending = 0; clearTimeout(deadline); successes++; healthPolicy.sample(performance.now() - sentAt);
        report(successes >= 2 && !draining, draining ? 'rtc_draining' : successes >= 2 ? '' : 'rtc_connecting', Math.round(performance.now() - sentAt));
        pingTimer = setTimeout(probe, successes < 2 ? 50 : 3000).unref();
      });
      channel.stateChange.subscribe(state => { if (state === 'closed') void handle.destroy(); });
      channel.error.subscribe(() => { void handle.destroy(); }); return;
    }
    if (channel.label !== 'codex-forward-data' || channel.protocol !== 'forward-data-v1' || !authenticated) return void handle.destroy('protocol_error');
    if (sockets.size >= (shared ? 24 : 8)) { channel.close(); return; }
    let queued; try { queued = writer.channel(channel); } catch { channel.close(); return; }
    function prepare() {
      if (!authorized() || sockets.size >= (shared ? 24 : 8)) { queued.close(); return; }
      if (preflight) {
        const ready = current.available && !draining && budget.canOpen();
        try { queued.send(JSON.stringify({ type: 'preflight', ready })); }
        catch { queued.close(); return; }
        // This response precedes open and never connects the target. A busy
        // peer can safely send this new TCP through the existing WSS standby.
        if (!ready) { queued.closeAfterFlush(); return; }
      }
      const socket = forwardChannel(queued, { window, budget }); sockets.add(socket);
      const activity = channel.onMessage.subscribe(() => { if (socket.readyState === 1 && authorized()) progressAt = performance.now(); });
      const timeout = setTimeout(() => socket.terminate(), 5000).unref();
      socket.once('close', () => { clearTimeout(timeout); activity.unSubscribe(); sockets.delete(socket); });
      socket.once('message', (bytes, binary) => {
        clearTimeout(timeout);
        if (shared) {
          let record; try { if (!binary) record = JSON.parse(bytes.toString()); } catch {}
          if (!authorized() || !current.available || !record || record.type !== 'open') return socket.terminate();
          connect(socket, record); return;
        }
        let streamId;
        if (reverse) {
          let record; try { record = JSON.parse(bytes.toString()); } catch {}
          if (!record || Object.keys(record).sort().join(',') !== 'id,type' || record.type !== 'open' || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)) { socket.close(4000, 'protocol_error'); return; }
          streamId = record.id;
        }
        if (!authorized() || !current.available || binary || !reverse && bytes.toString() !== '{"type":"open"}') { socket.close(4000, 'rtc_unavailable'); return; }
        connect(socket, streamId);
      });
    }
    if (channel.readyState === 'open') prepare();
    else {
      const subscription = channel.stateChange.subscribe(state => {
        if (state === 'open' || state === 'closed') subscription.unSubscribe();
        if (state === 'open') prepare();
      });
    }
  });
  return handle;
}
