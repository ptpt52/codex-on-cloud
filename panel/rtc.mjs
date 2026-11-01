import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { RTCPeerConnection } from 'werift';
import { attachRTCControl } from './rtc-control.mjs';

export const RTC_TIMEOUT = 8000;
const MAX_MESSAGE = 64 * 1024, HIGH_WATER = 256 * 1024;

export function privateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function rtcAddress(explicit) {
  const addresses = Object.values(networkInterfaces()).flat().map(item => item.address);
  if (explicit) {
    if (!privateIPv4(explicit) || !addresses.includes(explicit)) throw new Error('WEBRTC_LAN_ADDRESS 必须是本机已分配的私有 IPv4 地址');
    return explicit;
  }
  return addresses.find(address => privateIPv4(address) && !address.startsWith('127.')) || '127.0.0.1';
}

// Only one data m-section and a bounded set of LAN UDP candidates. No supplied
// STUN/TURN URL, public destination, media stream or DNS hostname is used.
export function lanOffer(body) {
  if (body.type !== 'offer' || typeof body.sdp !== 'string' || Buffer.byteLength(body.sdp) > 32768 || /\0/.test(body.sdp)) throw new Error('连接协商内容无效');
  const lines = body.sdp.split(/\r?\n/);
  const media = lines.filter(line => line.startsWith('m='));
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]) ||
      !lines.some(line => /^a=fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(line))) throw new Error('仅支持加密桌面数据通道');
  let candidates = 0;
  return { type: 'offer', sdp: lines.filter(line => {
    if (!line.startsWith('a=candidate:')) return true;
    const fields = line.slice(12).split(/ +/);
    const [, component, transport, , host, port, typ, kind] = fields;
    const mdns = /^[a-zA-Z0-9-]{1,63}\.local$/.test(host || '');
    return ++candidates <= 8 && component === '1' && transport?.toLowerCase() === 'udp' &&
      (privateIPv4(host) || mdns) && /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535 && typ === 'typ' && kind === 'host';
  }).join('\r\n') };
}

export function createRTCBridge({ address, vncSocket, valid, closed, performControl }) {
  const pc = new RTCPeerConnection({
    iceServers: [], iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: address }, icePortRange: [40000, 40015],
    iceFilterStunResponse: (_message, [host]) => privateIPv4(host),
    iceFilterCandidatePair: pair => privateIPv4(pair.remoteCandidate.host),
    maxMessageSize: MAX_MESSAGE,
  });
  let channel, control, upstream, ended = false, closePromise, activated = false, openVideo;
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
      upstream?.destroy();
      closed();
      closePromise = pc.close().catch(() => {});
      return closePromise;
    },
    async answer(offer) {
      try {
        await pc.setRemoteDescription(offer);
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
    if (value.label === 'codex-control' && value.protocol === 'codex-control-v1' && value.ordered && value.maxRetransmits == null && value.maxPacketLifeTime == null) {
      if (control || !authorized()) { void handle.destroy(); return; }
      control = attachRTCControl(value, { valid: authorized, perform: performControl });
      return;
    }
    if (channel || !authorized() || value.label !== 'codex-vnc' || value.protocol !== 'rfb' || !value.ordered ||
        value.maxRetransmits != null || value.maxPacketLifeTime != null) { void handle.destroy(); return; }
    channel = value;
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;
    channel.bufferedAmountLow.subscribe(() => { if (authorized()) upstream?.resume(); });
    channel.error.subscribe(() => { void handle.destroy(); });
    channel.stateChange.subscribe(state => {
      if (state === 'closed') void handle.destroy();
    });
    channel.onMessage.subscribe(bytes => {
      if (!activated || !authorized() || !Buffer.isBuffer(bytes) || bytes.length > MAX_MESSAGE || !upstream || upstream.writableLength + bytes.length > HIGH_WATER) {
        void handle.destroy(); return;
      }
      upstream.write(bytes);
    });
    openVideo = () => {
      if (!activated) return;
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
