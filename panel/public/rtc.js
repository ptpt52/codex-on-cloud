import { createControlClient } from '/control.js';
import { createHealthClient } from '/health.js';
import { gatherCandidates, selectedRoute } from './rtc-stats.js';

let enabled = true;
export function canTryDirect() { return enabled && window.isSecureContext && !!window.RTCPeerConnection; }

// HTTPS authenticates the SDP fingerprints; DTLS encrypts the LAN data stream.
// noVNC attaches to the connecting channel before negotiation can deliver bytes.
export async function desktopTransport(viewer, controlChanged = () => {}, { probe = false, signal, failed = () => {}, terminal } = {}) {
  if (signal?.aborted) return null;
  if (!canTryDirect()) { failed('unsupported'); return null; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false, failureReported = false, stage = 'signaling';
  const failure = reason => { if (!failureReported && !signal?.aborted) { failureReported = true; failed(reason); } };
  const timeout = setTimeout(() => {
    timedOut = true;
    failure(stage === 'signaling' ? 'signaling-timeout' : stage === 'connecting' ?
      ['connected', 'completed'].includes(peer?.iceConnectionState) ? 'channel-timeout' : 'ice-timeout' : 'timeout');
    controller.abort();
  }, 12000);
  let peer;
  try {
    const response = await fetch('/api/me', { signal: controller.signal });
    if (!response.ok) throw new Error('无法验证连接');
    const { csrf, webrtc, rtcStunUrl } = await response.json();
    if (controller.signal.aborted) throw new Error('连接已取消');
    if (!webrtc) { failure('disabled'); enabled = false; clearTimeout(timeout); signal?.removeEventListener('abort', cancel); return null; }
    peer = new RTCPeerConnection({ iceServers: typeof rtcStunUrl === 'string' && rtcStunUrl.length <= 256 && rtcStunUrl.startsWith('stun:') ? [{ urls: rtcStunUrl }] : [] });
    let channel, ended = false, videoReadySent = false, resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const control = createControlClient(peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' }), value => {
      if (value) { clearTimeout(timeout); resolveReady(); }
      else rejectReady(new Error('直连已关闭'));
      controlChanged(value);
    });
    const health = createHealthClient(peer.createDataChannel('codex-health', { ordered: true, protocol: 'codex-health-v1' }));
    const video = () => channel ||= peer.createDataChannel(terminal ? 'codex-terminal' : 'codex-vnc', { ordered: true, protocol: terminal ? 'terminal-v1' : 'rfb-ready-v1' });
    const viewerReady = () => {
      // Register after noVNC has attached its open handler. The server must not
      // send the RFB greeting before the browser has initialized that handler.
      const notify = () => {
        if (ended || videoReadySent || channel.readyState !== 'open') return;
        videoReadySent = true;
        try { channel.send(new Uint8Array([0])); } catch { close(); }
      };
      if (channel.readyState === 'open') notify();
      else channel.addEventListener('open', notify, { once: true });
    };
    if (!probe) video();
    const close = () => {
      if (ended) return;
      ended = true; clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      rejectReady(new Error('直连已关闭')); controller.abort(); control.close(); health.close(); peer.close();
    };
    controller.signal.addEventListener('abort', close, { once: true });
    peer.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) { if (!ended) failure('connection'); close(); }
    });
    return { get channel() { return channel; }, video, viewerReady, control, health, close,
      async stats() { return ended ? null : selectedRoute(await peer.getStats()); }, async start() {
      try {
        stage = 'gathering';
        await peer.setLocalDescription(await peer.createOffer());
        await gatherCandidates(peer, controller.signal);
        stage = 'signaling';
        const result = await fetch(terminal ? '/api/terminal/rtc' : '/api/desktop/rtc', { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-viewer-id': viewer },
          body: JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp, ...(terminal || {}) }),
        });
        if (!result.ok) throw new Error('直连暂不可用');
        const answer = await result.json();
        stage = 'connecting';
        await peer.setRemoteDescription(answer);
        await ready;
        if (!probe) await control.request('activate', {});
      } catch (error) { failure(timedOut ? 'timeout' : 'negotiation'); close(); throw error; }
    } };
  } catch { failure(timedOut ? 'timeout' : 'signaling'); clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.abort(); peer?.close(); return null; }
}
