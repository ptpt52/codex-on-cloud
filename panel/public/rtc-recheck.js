import { pathPreferred } from './transport-policy.js';
import { rtcRouteKind } from './rtc-stats.js';

// One explicit probe, no queue. Candidate admission is bounded to 26 seconds;
// the owning connection decides how to hand over its existing business stream.
export function createRTCRecheck({ open, current, allowed, idle, replace }) {
  let pending;
  return { get running() { return !!pending; }, cancel() { pending?.abort(); }, async run(report = () => {}) {
    if (pending) { report({ state: 'busy' }); return; }
    if (!allowed() || document.hidden || !navigator.onLine) { report({ state: 'unavailable' }); return; }
    const controller = pending = new AbortController(), timer = setTimeout(() => controller.abort(), 26000);
    let candidate, retained = false;
    try {
      report({ state: 'probing' }); candidate = await open(controller.signal);
      if (!candidate) throw Error('candidate unavailable');
      await candidate.start();
      for (let n = 0; n < 3; n++) await candidate.health.ping();
      const route = await candidate.stats(), previous = await current();
      if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
      if (previous && Number.isFinite(previous.rttMs) && !pathPreferred({ candidateMs: candidate.health.rttMs, currentMs: previous.rttMs, candidate: 'direct', turn: rtcRouteKind(route) === 'relay' })) {
        report({ state: 'kept', reason: 'quality' }); return;
      }
      report({ state: 'waiting' });
      while (!idle()) {
        if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (controller.signal.aborted || !allowed() || document.hidden || !navigator.onLine) throw Error('cancelled');
      report({ state: 'switching' });
      const result = await replace(candidate, controller.signal);
      retained = result?.retained === true;
      report({ state: result?.state || 'deferred' });
    } catch { report({ state: controller.signal.aborted ? 'cancelled' : 'failed' }); }
    finally { clearTimeout(timer); if (!retained) candidate?.close(); if (pending === controller) pending = undefined; }
  } };
}
