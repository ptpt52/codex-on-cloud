import { createControlClient } from '/control.js';
import { createHealthClient } from '/health.js';

let enabled = true;
export function canTryDirect() { return enabled && window.isSecureContext && !!window.RTCPeerConnection; }

// HTTPS authenticates the SDP fingerprints; DTLS encrypts the LAN data stream.
// noVNC attaches to the connecting channel before negotiation can deliver bytes.
export async function desktopTransport(viewer, controlChanged = () => {}, { probe = false, signal } = {}) {
  if (!canTryDirect() || signal?.aborted) return null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 8000);
  let peer;
  try {
    const response = await fetch('/api/me', { signal: controller.signal });
    if (!response.ok) throw new Error('无法验证连接');
    const { csrf, webrtc } = await response.json();
    if (controller.signal.aborted) throw new Error('连接已取消');
    if (!webrtc) { enabled = false; clearTimeout(timeout); signal?.removeEventListener('abort', cancel); return null; }
    peer = new RTCPeerConnection({ iceServers: [] });
    let channel, ended = false, videoReadySent = false, resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const control = createControlClient(peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' }), value => {
      if (value) { clearTimeout(timeout); resolveReady(); }
      else rejectReady(new Error('直连已关闭'));
      controlChanged(value);
    });
    const health = createHealthClient(peer.createDataChannel('codex-health', { ordered: true, protocol: 'codex-health-v1' }));
    const video = () => channel ||= peer.createDataChannel('codex-vnc', { ordered: true, protocol: 'rfb-ready-v1' });
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
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) close();
    });
    return { get channel() { return channel; }, video, viewerReady, control, health, close, async start() {
      try {
        await peer.setLocalDescription(await peer.createOffer());
        if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
          const cleanup = () => {
            peer.removeEventListener('icegatheringstatechange', changed);
            controller.signal.removeEventListener('abort', aborted);
          };
          const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
          const aborted = () => { cleanup(); reject(new Error('直连协商超时')); };
          peer.addEventListener('icegatheringstatechange', changed);
          controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) aborted(); else changed();
        });
        const result = await fetch('/api/desktop/rtc', { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-viewer-id': viewer },
          body: JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }),
        });
        if (!result.ok) throw new Error('直连暂不可用');
        await peer.setRemoteDescription(await result.json());
        await ready;
        if (!probe) await control.request('activate', {});
      } catch (error) { close(); throw error; }
    } };
  } catch { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.abort(); peer?.close(); return null; }
}
