import { createControlClient } from '/control.js';
import { createHealthClient } from '/health.js';
import { gatherCandidates, selectedRoute, rtcRouteKind, rtcDirectKind } from './rtc-stats.js';
import { disconnectGrace, RTC_SIGNAL_TIMEOUT, RTC_CONNECT_TIMEOUT, RTC_NEGOTIATION_TIMEOUT, RTC_NATIVE_LIMIT, rtcFailureStatus, createRTCNativeWaiter } from './transport-policy.js';
import { rtcHints, createRTCHints } from '/rtc-hints.js';
import { nodeHeaders, nodeIdentity } from '/node-scope.js';
import { entryPath, entryBasePath } from '/entry-path.js';
import { rtcIceServers, rtcCredentialsNeedRefresh } from '/rtc-ice.js';
import { requestRTCOffer, OFFER_LIMITS } from '/rtc-offers.js';

let enabled = true;
const native = createRTCNativeWaiter();
// Diagnostics have a separate realm-wide budget. Timed out/closed peers keep
// charging their native reads until settlement, without blocking negotiation.
const nativeStats = createRTCNativeWaiter();
export function canTryDirect() { return enabled && window.isSecureContext && !!window.RTCPeerConnection; }

// HTTPS authenticates the SDP fingerprints; DTLS encrypts the LAN data stream.
// noVNC attaches to the connecting channel before negotiation can deliver bytes.
export async function desktopTransport(viewer, controlChanged = () => {}, { probe = false, signal, failed = () => {}, terminal, streamId, standby = false, bootstrap, service = false, recheck = false, trace = () => {} } = {}) {
  if (signal?.aborted) return null;
  if (!canTryDirect()) { failed('unsupported'); return null; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false, failureReported = false, lastFailure = '', stage = 'signaling';
  const failure = (reason, status) => { if (!failureReported && !signal?.aborted) { failureReported = true; lastFailure = reason; trace('path-lost', { path: 'direct', reason, stage, ...(status ? { status } : {}) }); failed(reason); } };
  let timeout;
  const expire = reason => { timedOut = true; failure(reason); controller.abort(); };
  // Per-phase budgets never extend the bounded lifetime of this negotiation.
  const totalTimeout = setTimeout(() => expire('negotiation-timeout'), RTC_NEGOTIATION_TIMEOUT);
  const clearDeadlines = () => { clearTimeout(timeout); clearTimeout(totalTimeout); };
  const deadline = (nextStage, ms) => {
    stage = nextStage; clearTimeout(timeout); timeout = setTimeout(() => {
      expire(stage === 'queued' ? 'queue-timeout' : stage === 'signaling' ? 'signaling-timeout' : stage === 'connecting' ?
        ['connected', 'completed'].includes(peer?.iceConnectionState) ? 'channel-timeout' : 'ice-timeout' : stage === 'gathering' ? 'gathering-timeout' : 'timeout');
    }, ms);
  };
  deadline('signaling', RTC_SIGNAL_TIMEOUT);
  let peer;
  try {
    let settings = bootstrap?.();
    let storedHints;
    // Legacy viewers can start before the parent sends its bootstrap message.
    // Read the same bounded browser entry without waiting for that message.
    if (settings?.hints === undefined) { let storage; try { storage = localStorage; } catch {} storedHints = createRTCHints(storage, { nodeId: nodeIdentity(), basePath: entryBasePath }).value; }
    const hints = rtcHints(settings?.hints ?? storedHints);
    if (!settings || typeof settings.webrtc !== 'boolean' || typeof settings.csrf !== 'string' || !settings.csrf || typeof settings.rtcStunUrl !== 'string' || settings.rtcStunUrl.length > 256 || rtcCredentialsNeedRefresh(settings)) {
      const response = await fetch(entryPath('/api/me'), { headers: nodeHeaders(), redirect: 'manual', signal: controller.signal });
      if (!response.ok) { failure(response.type === 'opaqueredirect' ? 'auth' : rtcFailureStatus(response.status), response.status); throw new Error('无法验证连接'); }
      settings = await response.json();
    }
    const { csrf, webrtc, rtcStunUrl } = settings;
    if (controller.signal.aborted) throw new Error('连接已取消');
    if (!webrtc) { failure('disabled'); enabled = false; clearDeadlines(); signal?.removeEventListener('abort', cancel); return null; }
    peer = new RTCPeerConnection({ iceServers: rtcIceServers(settings, { now: Date.now() }) });
    for (const [name, phase, property] of [['iceconnectionstatechange', 'ice', 'iceConnectionState'], ['connectionstatechange', 'peer', 'connectionState'], ['icegatheringstatechange', 'gathering', 'iceGatheringState']]) {
      peer.addEventListener(name, () => trace('rtc-state', { path: 'direct', phase, state: peer[property] }));
    }
    let channel, ended = false, videoReadySent = false, resolveReady, rejectReady, grace;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const control = createControlClient(peer.createDataChannel(service ? 'codex-service' : 'codex-control', { ordered: true, protocol: service ? 'service-v1' : 'codex-control-v1' }), value => {
      if (value) resolveReady();
      else rejectReady(new Error('直连已关闭'));
      controlChanged(value);
    }, { keepOnTimeout: service, trace });
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
    let features, statsRead, statsResolve, statsTimer, statsPending = false, statsBlockedLogged = false, lastRoute;
    function stats() {
      if (ended) return Promise.resolve(null);
      if (statsRead) return statsRead;
      // Statistics are optional diagnostics, not a prerequisite for healthy
      // data channels. Keep at most one native read, even if it never settles.
      if (statsPending) return Promise.resolve(null);
      if (nativeStats.pending >= RTC_NATIVE_LIMIT) {
        if (!statsBlockedLogged) { statsBlockedLogged = true; trace('rtc-stats-busy', { path: 'direct', pendingStats: nativeStats.pending }); }
        return Promise.resolve(null);
      }
      statsBlockedLogged = false;
      statsPending = true;
      statsRead = new Promise(resolve => {
        const finish = value => { clearTimeout(statsTimer); statsResolve = statsRead = undefined; resolve(value); };
        statsResolve = finish;
        statsTimer = setTimeout(() => { trace('rtc-stats-timeout', { path: 'direct', durationMs: 1000 }); finish(null); }, 1000);
        nativeStats.wait(() => peer.getStats()).then(value => {
          const result = ended ? null : selectedRoute(value), kind = rtcRouteKind(result);
          const route = kind === 'relay' ? 'turn' : kind === 'direct' ? rtcDirectKind(result) : 'unknown';
          if (!ended && route !== lastRoute) { lastRoute = route; trace('rtc-route', { path: 'direct', route }); }
          return result;
        }, () => null)
          .catch(() => null).then(value => { statsPending = false; statsResolve?.(value); });
      });
      return statsRead;
    }
    const close = () => {
      if (ended) return;
      ended = true; grace?.close(); clearDeadlines(); signal?.removeEventListener('abort', cancel);
      statsResolve?.(null);
      rejectReady(new Error('直连已关闭')); controller.abort(); control.close(); health.close(); peer.close();
    };
    controller.signal.addEventListener('abort', close, { once: true });
    grace = disconnectGrace(() => { if (!ended) failure('connection'); close(); });
    peer.addEventListener('connectionstatechange', () => grace.state(peer.connectionState));
    return { get channel() { return channel; }, get features() { return features; }, get closed() { return ended; }, video, viewerReady, control, health, close,
      fileChannel() { if (!service) throw Error('非服务通道'); return peer.createDataChannel('codex-files', { ordered: true, protocol: 'files-v1' }); },
      stats, async start() {
      try {
        let stageAt = performance.now(); trace('rtc-stage', { path: 'direct', stage: 'gathering' });
        deadline('gathering', 4000);
        const offer = await native.wait(() => peer.createOffer(), controller.signal);
        await native.wait(() => peer.setLocalDescription(offer), controller.signal);
        await gatherCandidates(peer, controller.signal);
        const candidates = (peer.localDescription?.sdp || '').split('\n').filter(line => /^a=candidate:/.test(line));
        trace('rtc-candidates', { path: 'direct', host: candidates.filter(line => / typ host(?:\s|$)/.test(line)).length, reflexive: candidates.filter(line => / typ (?:srflx|prflx)(?:\s|$)/.test(line)).length, relay: candidates.filter(line => / typ relay(?:\s|$)/.test(line)).length });
        trace('rtc-stage', { path: 'direct', stage: 'gathering', durationMs: Math.round(performance.now() - stageAt) });
        deadline('queued', OFFER_LIMITS.waitMs);
        const waitingAt = performance.now(); trace('rtc-stage', { path: 'direct', stage: 'queued' });
        const release = await requestRTCOffer({ signal: controller.signal, priority: service ? 1 : standby ? 2 : 0, expired: () => controller.abort() });
        trace('rtc-stage', { path: 'direct', stage: 'queued', durationMs: Math.round(performance.now() - waitingAt) });
        deadline('signaling', RTC_SIGNAL_TIMEOUT);
        stageAt = performance.now(); trace('rtc-stage', { path: 'direct', stage: 'signaling' });
        let answer;
        try {
          if (controller.signal.aborted) throw new Error('连接已取消');
          const result = await fetch(entryPath(service ? '/api/service/rtc' : terminal ? '/api/terminal/rtc' : '/api/desktop/rtc'), { method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-viewer-id': viewer, ...nodeHeaders() },
            body: JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp, ...(terminal || {}), ...(service && recheck ? { recheck: true } : {}), ...(streamId ? { streamId, ...(standby ? { standby: true } : {}) } : {}), ...(hints.server || hints.browser ? { hints } : {}) }),
          });
          if (!result.ok) { const reason = result.type === 'opaqueredirect' ? 'auth' : rtcFailureStatus(result.status); failure(reason, result.status); throw Object.assign(new Error('直连暂不可用'), { reason, status: result.status }); }
          answer = await result.json();
          trace('rtc-stage', { path: 'direct', stage: 'signaling', status: result.status, durationMs: Math.round(performance.now() - stageAt) });
        } finally { release(); }
        stageAt = performance.now(); trace('rtc-stage', { path: 'direct', stage: 'connecting' });
        deadline('connecting', RTC_CONNECT_TIMEOUT);
        await native.wait(() => peer.setRemoteDescription(answer), controller.signal);
        await ready;
        clearDeadlines();
        trace('rtc-stage', { path: 'direct', stage: 'connecting', durationMs: Math.round(performance.now() - stageAt) });
        stage = 'ready';
        if (service) features = await control.request('ping', {});
        else if (!probe) await control.request('activate', {});
      } catch (error) { failure(timedOut ? 'timeout' : ['busy', 'native-busy', 'queue-timeout'].includes(error?.reason) ? error.reason : 'negotiation'); close(); throw Object.assign(error, { reason: lastFailure || 'negotiation' }); }
    } };
  } catch { failure(timedOut ? 'timeout' : 'signaling'); clearDeadlines(); signal?.removeEventListener('abort', cancel); controller.abort(); peer?.close(); return null; }
}
