// A peer-wide budget for unacknowledged application bytes, independent of SCTP's
// own receive window. Small records have reserved credit; older waiters of
// each class retain precedence when credit is released.
export const FLOW_SMALL_RECORD = 256, FLOW_RESERVED = 128 * 1024;
export function createFlowBudget(limit = 512 * 1024, reserve = Math.min(FLOW_RESERVED, Math.floor(limit / 4))) {
  const waiting = new Map();
  let used = 0, bulk = 0, peak = 0, scheduled = false, draining = false, admitted, admittedKind, ended = false;
  const bulkBytes = bytes => reserve && bytes <= FLOW_SMALL_RECORD ? 0 : bytes;
  const kindOf = bytes => bulkBytes(bytes) ? 'bulk' : 'small';
  const fits = bytes => used + bytes <= limit && bulk + bulkBytes(bytes) <= limit - reserve;
  function schedule() {
    if (ended || scheduled || draining || !waiting.size || used >= limit) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false; if (ended) return;
      draining = true;
      // Snapshot the round. Requeued blocked streams wait for later credit;
      // they cannot turn an undersized remainder into a busy microtask loop.
      const blocked = new Set();
      try { for (const [owner, { run, bytes }] of [...waiting]) {
        if (!waiting.has(owner)) continue;
        const kind = kindOf(bytes);
        if (blocked.has(kind) || !fits(bytes)) { blocked.add(kind); continue; }
        waiting.delete(owner); admitted = owner; admittedKind = kind; run(); admitted = undefined;
      } } finally { admitted = undefined; admittedKind = undefined; draining = false; }
    });
  }
  return {
    acquire(owner, bytes) {
      if (ended || bytes < 0 || bytes > limit || !fits(bytes) || waiting.size && admitted !== owner) return false;
      if (admitted === owner && admittedKind !== kindOf(bytes) && [...waiting.values()].some(item => kindOf(item.bytes) === kindOf(bytes))) return false;
      used += bytes; bulk += bulkBytes(bytes); peak = Math.max(peak, used); return true;
    },
    wait(owner, run, bytes) {
      if (ended) return;
      if (!waiting.has(owner) && waiting.size >= 32) throw Error('Peer flow wait limit');
      waiting.set(owner, { run, bytes }); schedule();
    },
    release(bytes, bulkSize) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > used || !Number.isSafeInteger(bulkSize) || bulkSize < 0 || bulkSize > bytes || bulkSize > bulk || bytes - bulkSize > used - bulk) throw Error('Invalid peer credit');
      used -= bytes; bulk -= bulkSize; schedule();
    },
    bulkBytes,
    canOpen() { return !ended && !waiting.size && fits(16384); },
    forget(owner) { waiting.delete(owner); },
    close() { ended = true; waiting.clear(); },
    get used() { return used; }, get peak() { return peak; },
  };
}
