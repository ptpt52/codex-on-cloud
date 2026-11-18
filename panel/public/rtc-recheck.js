import { pathPreferred } from './transport-policy.js';
import { rtcRouteKind } from './rtc-stats.js';

const failureReasons = Object.freeze({ rpc_timeout: 'rpc-timeout', heartbeat_timeout: 'heartbeat', local_http_timeout: 'local-http-timeout', local_http_error: 'local-http-error', peer_closed: 'peer-closed', channel_error: 'channel-error', control_protocol: 'control-protocol', control_send: 'control-send' });
const candidateReasons = ['unsupported', 'disabled', 'auth', 'target', 'busy', 'native-busy', 'queue-timeout', 'negotiation-timeout', 'negotiation', 'connection', 'signaling', 'signaling-timeout', 'gathering-timeout', 'ice-timeout', 'channel-timeout', 'timeout', 'protocol', 'signal-failed'];

// One explicit probe, no queue. Candidate admission is bounded to 26 seconds.
// A service promotion may commit to its separately bounded RPC: soft lifecycle
// cancellation then waits for adoption; explicit shutdown still aborts the peer.
export function createRTCRecheck({ open, current, allowed, idle, replace, trace = () => {}, probeStatus = () => null }) {
  let pending, committing = false;
  return { get running() { return !!pending; }, cancel({ force = false } = {}) { if (!committing || force) pending?.abort(); }, async run(report = () => {}) {
    if (pending) { report({ state: 'busy' }); return; }
    if (!allowed() || document.hidden || !navigator.onLine) { report({ state: 'unavailable' }); return; }
    const controller = pending = new AbortController(), timer = setTimeout(() => controller.abort(), 26000);
    let candidate, retained = false, step = 'candidate', result = 'failed', reason, outcome, status;
    const startedAt = performance.now();
    const log = type => { try { trace(type, { path: 'direct', step, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(type === 'recheck-ended' ? { result, reason, outcome, status, ...probeStatus() } : {}) }); } catch { /* Diagnostics never control adoption. */ } };
    try {
      log('recheck-start');
      report({ state: 'probing' }); candidate = await open(controller.signal);
      if (!candidate) throw Error('candidate unavailable');
      step = 'connect';
      await candidate.start();
      step = 'health';
      for (let n = 0; n < 3; n++) await candidate.health.ping();
      step = 'stats';
      const route = await candidate.stats(), previous = await current();
      if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
      if (previous && Number.isFinite(previous.rttMs) && !pathPreferred({ candidateMs: candidate.health.rttMs, currentMs: previous.rttMs, candidate: 'direct', turn: rtcRouteKind(route) !== 'direct' })) {
        result = 'kept'; reason = 'quality'; outcome = 'confirmed'; report({ state: result, reason }); return;
      }
      step = 'idle';
      report({ state: 'waiting' });
      while (!idle()) {
        if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
      step = 'switch'; log('recheck-switch');
      report({ state: 'switching' });
      const commit = () => {
        if (controller.signal.aborted || pending !== controller) return false;
        committing = true; step = 'commit'; clearTimeout(timer); return true;
      };
      const replacement = await replace(candidate, controller.signal, commit);
      retained = replacement?.retained === true;
      result = replacement?.state || 'deferred'; outcome = retained ? 'confirmed' : undefined;
      // The replacement's state describes this probe, not future peer health.
      report({ state: result });
    } catch (error) {
      result = controller.signal.aborted ? 'cancelled' : 'failed';
      reason = controller.signal.aborted ? 'aborted' : Object.hasOwn(failureReasons, error?.code) ? failureReasons[error.code] :
        candidateReasons.includes(error?.reason) ? error.reason : Number.isInteger(error?.status) ? 'http-status' : 'connection';
      status = error?.status;
      outcome = ['unknown', 'rejected', 'canceled'].includes(error?.outcome) ? error.outcome : ['switch', 'commit'].includes(step) ? 'unknown' : controller.signal.aborted ? 'canceled' : 'rejected';
      report({ state: result });
    }
    finally { clearTimeout(timer); if (!retained) candidate?.close(); if (pending === controller) { pending = undefined; committing = false; } log('recheck-ended'); }
  } };
}
