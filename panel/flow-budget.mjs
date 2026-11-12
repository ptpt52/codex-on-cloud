// A peer-wide budget for unacknowledged application bytes, independent of SCTP's
// own receive window. A stream cannot reclaim credit ahead of older waiters.
export function createFlowBudget(limit = 512 * 1024) {
  const waiting = new Map();
  let used = 0, peak = 0, scheduled = false, draining = false, admitted, ended = false;
  function schedule() {
    if (ended || scheduled || draining || !waiting.size || used >= limit) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false; if (ended) return;
      draining = true;
      // Snapshot the round. Requeued blocked streams wait for later credit;
      // they cannot turn an undersized remainder into a busy microtask loop.
      for (const [owner, run] of [...waiting]) {
        if (used >= limit) break;
        waiting.delete(owner); admitted = owner; run(); admitted = undefined;
      }
      draining = false;
    });
  }
  return {
    acquire(owner, bytes) {
      if (ended || bytes < 0 || bytes > limit || used + bytes > limit || waiting.size && admitted !== owner) return false;
      used += bytes; peak = Math.max(peak, used); return true;
    },
    wait(owner, run) {
      if (ended) return;
      if (!waiting.has(owner) && waiting.size >= 32) throw Error('Peer flow wait limit');
      waiting.set(owner, run); schedule();
    },
    release(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > used) throw Error('Invalid peer credit');
      used -= bytes; schedule();
    },
    forget(owner) { waiting.delete(owner); },
    close() { ended = true; waiting.clear(); },
    get used() { return used; }, get peak() { return peak; },
  };
}
