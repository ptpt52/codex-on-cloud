import { RTCPeerConnection } from 'werift';
import { peerAddress } from './rtc-network.mjs';
import { guardIceAgent } from './rtc-guard.mjs';
import { forwardChannel } from './forward-channel.mjs';
import { guardSCTP } from './rtc-sctp.mjs';
export { guardSCTP as guardForwardSCTP } from './rtc-sctp.mjs';

// A mapping owns one peer, separate from the desktop/viewer and its UDP ports.
// Unhealthy peers stop receiving new streams; existing streams never migrate.
export function createForwardPeer({ address, ipv6Address, id, valid, authenticate, connect, status, closed }) {
  const allowed = host => peerAddress(host, !!ipv6Address);
  const pc = new RTCPeerConnection({ iceServers: [], iceUseIpv4: true, iceUseIpv6: !!ipv6Address, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: address, ...(ipv6Address ? { udp6: ipv6Address } : {}) }, icePortRange: [40016, 40047],
    iceFilterStunResponse: (_message, [host]) => allowed(host), iceFilterCandidatePair: pair => allowed(pair.remoteCandidate.host), maxMessageSize: 16384 });
  const sockets = new Set();
  let ended = false, closing, control, authenticated = false, draining = false, timer, pingTimer, deadline, nonce = 0, pending = 0, sentAt = 0, successes = 0;
  let current = { id, available: false, family: null, rttMs: null, reason: 'rtc_connecting' };
  const authorized = () => !ended && valid();
  const report = (available, reason, rttMs = null) => {
    if (ended) return;
    const host = pc.iceTransports[0]?.connection.nominated?.remoteCandidate.host;
    current = { id, available, healthy: successes >= 2, reason, rttMs, family: available && host ? host.includes(':') ? 'IPv6' : 'IPv4' : null };
    status(current);
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
      control?.close(); closed(); closing = pc.close().catch(() => {}); return closing;
    },
    async answer(offer) {
      try {
        await pc.setRemoteDescription(offer);
        guardSCTP(pc.sctpTransport?.sctp, authorized, () => { void handle.destroy('buffer_limit'); });
        for (const transport of pc.iceTransports) guardIceAgent(transport.connection, { valid: authorized, allowed });
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
    deadline = setTimeout(() => {
      pending = 0; successes = 0; report(false, 'rtc_health_timeout');
      // A healthy existing TCP stream can outlive a delayed probe. Probe again
      // without replacing its peer or allocating any target connection.
      pingTimer = setTimeout(probe, 3000).unref();
    }, 2000).unref();
  }
  timer = setTimeout(() => { void handle.destroy('rtc_negotiation_failed'); }, 14000).unref();
  pc.connectionStateChange.subscribe(state => {
    if (state === 'disconnected') handle.unhealthy('rtc_unavailable');
    if (['closed', 'failed'].includes(state)) void handle.destroy('rtc_unavailable');
  });
  pc.onDataChannel.subscribe(channel => {
    if (!authorized() || !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) return void handle.destroy('protocol_error');
    if (channel.label === 'codex-forward-health' && channel.protocol === 'forward-health-v1' && !control) {
      control = channel;
      let windowStart = performance.now(), received = 0;
      channel.onMessage.subscribe(bytes => {
        if (!authorized()) return void handle.destroy();
        if (performance.now() - windowStart >= 1000) { windowStart = performance.now(); received = 0; }
        if (++received > 8) return void handle.destroy('protocol_error');
        if (!authenticated) {
          let record; try { if (Buffer.isBuffer(bytes) || Buffer.byteLength(bytes) > 256) throw new Error(); record = JSON.parse(bytes); } catch { return void handle.destroy('protocol_error'); }
          if (!record || Object.keys(record).sort().join(',') !== 'id,token,type' || record.type !== 'auth' || record.id !== id || !authenticate(record.token)) return void handle.destroy('protocol_error');
          authenticated = true; clearTimeout(timer);
          try { channel.send('{"type":"ready"}'); } catch { return void handle.destroy(); }
          probe(); return;
        }
        if (!Buffer.isBuffer(bytes) || bytes.length !== 4) return void handle.destroy('protocol_error');
        const echo = bytes.readUInt32BE();
        if (echo <= nonce && (!pending || echo < pending)) return;
        if (!pending || echo !== pending) return void handle.destroy('protocol_error');
        pending = 0; clearTimeout(deadline); successes++;
        report(successes >= 2 && !draining, draining ? 'rtc_draining' : successes >= 2 ? '' : 'rtc_connecting', Math.round(performance.now() - sentAt));
        pingTimer = setTimeout(probe, successes < 2 ? 50 : 3000).unref();
      });
      channel.stateChange.subscribe(state => { if (state === 'closed') void handle.destroy(); });
      channel.error.subscribe(() => { void handle.destroy(); }); return;
    }
    if (channel.label !== 'codex-forward-data' || channel.protocol !== 'forward-data-v1' || !authenticated) return void handle.destroy('protocol_error');
    if (sockets.size >= 8) { channel.close(); return; }
    const socket = forwardChannel(channel); sockets.add(socket);
    const timeout = setTimeout(() => socket.terminate(), 5000).unref();
    socket.once('close', () => { clearTimeout(timeout); sockets.delete(socket); });
    socket.once('message', (bytes, binary) => {
      clearTimeout(timeout);
      if (!authorized() || !current.available || binary || bytes.toString() !== '{"type":"open"}') { socket.close(4000, 'rtc_unavailable'); return; }
      connect(socket);
    });
  });
  return handle;
}
