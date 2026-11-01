import { createControlClient } from '/control.js';

// HTTPS authenticates the SDP fingerprints; DTLS encrypts the LAN data stream.
// noVNC attaches to the connecting channel before negotiation can deliver bytes.
export async function desktopTransport(viewer, controlChanged = () => {}) {
  if (!window.isSecureContext || !window.RTCPeerConnection) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let peer;
  try {
    const response = await fetch('/api/me', { signal: controller.signal });
    if (!response.ok) throw new Error('无法验证连接');
    const { csrf, webrtc } = await response.json();
    if (!webrtc) { clearTimeout(timeout); return null; }
    peer = new RTCPeerConnection({ iceServers: [] });
    const channel = peer.createDataChannel('codex-vnc', { ordered: true, protocol: 'rfb' });
    const control = createControlClient(peer.createDataChannel('codex-control', { ordered: true, protocol: 'codex-control-v1' }), controlChanged);
    const close = () => { clearTimeout(timeout); controller.abort(); control.close(); peer.close(); };
    controller.signal.addEventListener('abort', () => peer.close(), { once: true });
    channel.addEventListener('open', () => clearTimeout(timeout), { once: true });
    peer.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected'].includes(peer.connectionState)) close();
    });
    return { channel, control, close, async start() {
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
      } catch (error) { close(); throw error; }
    } };
  } catch { clearTimeout(timeout); controller.abort(); peer?.close(); return null; }
}
