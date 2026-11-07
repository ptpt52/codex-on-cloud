import { createControlClient } from '/control.js';
import { createHealthClient } from '/health.js';
import { gatherCandidates, selectedRoute } from './rtc-stats.js';
import { disconnectGrace, RTC_SIGNAL_TIMEOUT, RTC_CONNECT_TIMEOUT } from './transport-policy.js';
import { rtcHints, createRTCHints } from '/rtc-hints.js';

let enabled = true;
export function canTryDirect() { return enabled && window.isSecureContext && !!window.RTCPeerConnection; }

// HTTPS authenticates the SDP fingerprints; DTLS encrypts the LAN data stream.
// noVNC attaches to the connecting channel before negotiation can deliver bytes.
export async function desktopTransport(viewer, controlChanged = () => {}, { probe = false, signal, failed = () => {}, terminal, streamId, bootstrap, service = false } = {}) {
  if (signal?.aborted) return null;
  if (!canTryDirect()) { failed('unsupported'); return null; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false, failureReported = false, stage = 'signaling';
  const failure = reason => { if (!failureReported && !signal?.aborted) { failureReported = true; failed(reason); } };
  let timeout;
  const deadline = (nextStage, ms) => {
    stage = nextStage; clearTimeout(timeout); timeout = setTimeout(() => {
      timedOut = true;
      failure(stage === 'signaling' ? 'signaling-timeout' : stage === 'connecting' ?
        ['connected', 'completed'].includes(peer?.iceConnectionState) ? 'channel-timeout' : 'ice-timeout' : stage === 'gathering' ? 'gathering-timeout' : 'timeout');
      controller.abort();
    }, ms);
  };
  deadline('signaling', RTC_SIGNAL_TIMEOUT);
  let peer;
  try {
    let settings = bootstrap?.();
    let storedHints;
    // Legacy viewers can start before the parent sends its bootstrap message.
    // Read the same bounded browser entry without waiting for that message.
    if (settings?.hints === undefined) { let storage; try { storage = localStorage; } catch {} storedHints = createRTCHints(storage).value; }
    const hints = rtcHints(settings?.hints ?? storedHints);
    if (!settings || typeof settings.webrtc !== 'boolean' || typeof settings.csrf !== 'string' || !settings.csrf || typeof settings.rtcStunUrl !== 'string' || settings.rtcStunUrl.length > 256) {
      const response = await fetch('/api/me', { signal: controller.signal });
      if (!response.ok) throw new Error('无法验证连接');
      settings = await response.json();
    }
    const { csrf, webrtc, rtcStunUrl } = settings;
    if (controller.signal.aborted) throw new Error('连接已取消');
    if (!webrtc) { failure('disabled'); enabled = false; clearTimeout(timeout); signal?.removeEventListener('abort', cancel); return null; }
    peer = new RTCPeerConnection({ iceServers: typeof rtcStunUrl === 'string' && rtcStunUrl.length <= 256 && rtcStunUrl.startsWith('stun:') ? [{ urls: rtcStunUrl }] : [] });
    let channel, ended = false, videoReadySent = false, resolveReady, rejectReady, grace;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const control = createControlClient(peer.createDataChannel(service ? 'codex-service' : 'codex-control', { ordered: true, protocol: service ? 'service-v1' : 'codex-control-v1' }), value => {
      if (value) { clearTimeout(timeout); resolveReady(); }
      else rejectReady(new Error('直连已关闭'));
      controlChanged(value);
    });
    const health = createHealthClient(peer.createDataChannel('codex-health', { ordered: true, protocol: 'codex-health-v1' }));
    const video = () => channel ||= peer.createDataChannel(streamId ? 'codex-stream' : terminal ? 'codex-terminal' : 'codex-vnc', { ordered: true, protocol: streamId ? 'stream-v1' : terminal ? 'terminal-v1' : 'rfb-ready-v1' });
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
    if (!probe && !service) video();
    let features;
    const close = () => {
      if (ended) return;
      ended = true; grace?.close(); clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      rejectReady(new Error('直连已关闭')); controller.abort(); control.close(); health.close(); peer.close();
    };
    controller.signal.addEventListener('abort', close, { once: true });
    grace = disconnectGrace(() => { if (!ended) failure('connection'); close(); });
    peer.addEventListener('connectionstatechange', () => grace.state(peer.connectionState));
    return { get channel() { return channel; }, get features() { return features; }, video, viewerReady, control, health, close,
      fileChannel() { if (!service) throw Error('非服务通道'); return peer.createDataChannel('codex-files', { ordered: true, protocol: 'files-v1' }); },
      async stats() { return ended ? null : selectedRoute(await peer.getStats()); }, async start() {
      try {
        deadline('gathering', 3000);
        await peer.setLocalDescription(await peer.createOffer());
        await gatherCandidates(peer, controller.signal);
        deadline('signaling', RTC_SIGNAL_TIMEOUT);
        const result = await fetch(service ? '/api/service/rtc' : terminal ? '/api/terminal/rtc' : '/api/desktop/rtc', { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-viewer-id': viewer },
          body: JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp, ...(terminal || {}), ...(streamId ? { streamId } : {}), ...(hints.server || hints.browser ? { hints } : {}) }),
        });
        if (!result.ok) throw new Error('直连暂不可用');
        const answer = await result.json();
        deadline('connecting', RTC_CONNECT_TIMEOUT);
        await peer.setRemoteDescription(answer);
        await ready;
        if (service) features = await control.request('ping', {});
        else if (!probe) await control.request('activate', {});
      } catch (error) { failure(timedOut ? 'timeout' : 'negotiation'); close(); throw error; }
    } };
  } catch { failure(timedOut ? 'timeout' : 'signaling'); clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.abort(); peer?.close(); return null; }
}
