import net from 'node:net';
import { RTCPeerConnection } from 'werift';
import { attachRTCControl } from './rtc-control.mjs';
import { attachRTCHealth } from './rtc-health.mjs';
import { peerAddress } from './rtc-network.mjs';
import { createMDNSLookup } from './rtc-mdns.mjs';
import { guardIceAgent } from './rtc-guard.mjs';
export { privateIPv4, rtcOffer, rtcIPv6Address, rtcAddress } from './rtc-network.mjs';

export const RTC_TIMEOUT = 12000;
const MAX_MESSAGE = 64 * 1024, HIGH_WATER = 256 * 1024;

export function createRTCBridge({ address, ipv6Address, vncSocket, valid, closed, performControl, connectTerminal }) {
  const allowed = host => peerAddress(host, !!ipv6Address);
  const pc = new RTCPeerConnection({
    iceServers: [], iceUseIpv4: true, iceUseIpv6: !!ipv6Address, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: address, ...(ipv6Address ? { udp6: ipv6Address } : {}) }, icePortRange: [40000, 40015],
    iceFilterStunResponse: (_message, [host]) => allowed(host),
    iceFilterCandidatePair: pair => allowed(pair.remoteCandidate.host),
    maxMessageSize: MAX_MESSAGE,
  });
  // One application m-section: prepare its transport before remote candidates
  // arrive, so Chrome's masked addresses use our bounded, multi-record lookup.
  pc.createSctpTransport();
  for (const transport of pc.iceTransports) transport.connection.lookup = createMDNSLookup({ address, ipv6: !!ipv6Address });
  let channel, control, health, upstream, terminal, ended = false, closePromise, activated = false, videoReady = false, openVideo;
  let timer = setTimeout(() => handle.destroy(), RTC_TIMEOUT + 2000).unref();
  const handle = {
    activate() {
      if (ended || !valid()) throw new Error('连接控制权已变化');
      if (activated) return;
      activated = true;
      clearTimeout(timer);
      timer = setTimeout(() => handle.destroy(), 5000).unref();
      if (channel?.readyState === 'open') openVideo();
    },
    destroy() {
      if (ended) return closePromise;
      ended = true;
      clearTimeout(timer);
      control?.close();
      health?.close();
      terminal?.close();
      upstream?.destroy();
      closed();
      closePromise = pc.close().catch(() => {});
      return closePromise;
    },
    async answer(offer) {
      try {
        await pc.setRemoteDescription(offer);
        for (const transport of pc.iceTransports) guardIceAgent(transport.connection, { valid: authorized, allowed });
        if (ended || !valid()) throw new Error('连接控制权已变化');
        await pc.setLocalDescription(await pc.createAnswer());
        if (ended || !valid()) throw new Error('连接控制权已变化');
        return { type: 'answer', sdp: pc.localDescription.sdp };
      } catch (error) { await handle.destroy(); throw error; }
    },
  };
  const authorized = () => !ended && valid();
  pc.connectionStateChange.subscribe(state => {
    if (['closed', 'failed', 'disconnected'].includes(state)) void handle.destroy();
  });
  pc.onDataChannel.subscribe(value => {
    if (value.label === 'codex-health' && value.protocol === 'codex-health-v1' && value.ordered && value.maxRetransmits == null && value.maxPacketLifeTime == null) {
      if (health || !authorized()) { void handle.destroy(); return; }
      health = attachRTCHealth(value, { valid: authorized, fail: () => { void handle.destroy(); } });
      return;
    }
    if (value.label === 'codex-control' && value.protocol === 'codex-control-v1' && value.ordered && value.maxRetransmits == null && value.maxPacketLifeTime == null) {
      if (control || !authorized()) { void handle.destroy(); return; }
      control = attachRTCControl(value, { valid: authorized, perform: performControl });
      return;
    }
    const streamValid = connectTerminal ? value.label === 'codex-terminal' && value.protocol === 'terminal-v1'
      : value.label === 'codex-vnc' && ['rfb', 'rfb-ready-v1'].includes(value.protocol);
    if (channel || !authorized() || !streamValid || !value.ordered ||
        value.maxRetransmits != null || value.maxPacketLifeTime != null) { void handle.destroy(); return; }
    channel = value;
    videoReady = value.protocol === 'rfb'; // Old clients retain their original protocol until refreshed.
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.bufferedAmountLow.subscribe(() => { if (authorized()) upstream?.resume(); });
    channel.error.subscribe(() => { void handle.destroy(); });
    channel.stateChange.subscribe(state => {
      if (state === 'closed') void handle.destroy();
    });
    channel.onMessage.subscribe(bytes => {
      if (!videoReady) {
        if (!authorized() || !Buffer.isBuffer(bytes) || bytes.length !== 1 || bytes[0] !== 0) { void handle.destroy(); return; }
        videoReady = true;
        openVideo();
        return; // The fixed readiness byte never reaches VNC.
      }
      if (connectTerminal) {
        if (!activated || !authorized() || !terminal || !Buffer.isBuffer(bytes) || bytes.length > 16384) { void handle.destroy(); return; }
        terminal.receive(bytes); return;
      }
      if (!activated || !authorized() || !Buffer.isBuffer(bytes) || bytes.length > MAX_MESSAGE || !upstream || upstream.writableLength + bytes.length > HIGH_WATER) {
        void handle.destroy(); return;
      }
      upstream.write(bytes);
    });
    openVideo = () => {
      if (!activated || !videoReady || channel.readyState !== 'open') return;
      if (connectTerminal) {
        if (!authorized() || terminal) { void handle.destroy(); return; }
        terminal = connectTerminal(channel, authorized, () => { void handle.destroy(); });
        clearTimeout(timer); return;
      }
      if (!authorized() || upstream) { void handle.destroy(); return; }
      upstream = net.createConnection({ path: vncSocket, highWaterMark: MAX_MESSAGE });
      upstream.once('connect', () => clearTimeout(timer));
      upstream.once('error', () => { void handle.destroy(); });
      upstream.once('close', () => { void handle.destroy(); });
      upstream.on('data', bytes => {
        if (!authorized() || channel.readyState !== 'open') { void handle.destroy(); return; }
        try {
          // Small SCTP messages keep a framebuffer burst from blocking input.
          for (let offset = 0; offset < bytes.length; offset += 16384) channel.send(bytes.subarray(offset, offset + 16384));
          if (channel.bufferedAmount >= HIGH_WATER) upstream.pause();
        } catch { void handle.destroy(); }
      });
    };
    if (channel.readyState === 'open') openVideo();
    else channel.stateChange.subscribe(state => { if (state === 'open') openVideo(); });
  });
  return handle;
}
