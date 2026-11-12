// Fair application admission before the pinned SCTP stack. Native SCTP still
// owns reliability/congestion control. No data is retried or moved to a peer.
export const RTC_WRITE_LIMITS = Object.freeze({ queue: 1024 * 1024, control: 512 * 1024, native: 128 * 1024, reserve: 65536, quantum: 65536, groups: 32 });
export function createRTCWriter({ valid, failed = () => {} }) {
  const groups = new Map();
  let ended = false, immediate, timer, pumping = false, queued = 0, controls = 0;
  const nativeBytes = () => [...groups.keys()].reduce((total, raw) => total + raw.bufferedAmount, 0);
  const ack = bytes => typeof bytes === 'string' && /^\{"type":"ack","(?:id|seq)":\d+\}$/.test(bytes);
  function schedule(delay = 0) {
    if (ended || pumping || immediate) return;
    if (timer) { if (delay) return; clearTimeout(timer); timer = undefined; }
    if (delay) timer = setTimeout(() => { timer = undefined; pump(); }, delay).unref();
    else immediate = setImmediate(() => { immediate = undefined; pump(); });
  }
  function pump() {
    if (ended) return;
    if (!valid()) { close(); failed(); return; }
    pumping = true; let sent = 0, blocked = false;
    try {
      while (sent < RTC_WRITE_LIMITS.quantum) {
        let selected; const native = nativeBytes();
        for (const group of groups.values()) {
          if (!group.queue.length || group.raw.readyState !== 'open') continue;
          const item = group.queue[0];
          if (native + item.size > RTC_WRITE_LIMITS.native + (item.priority ? RTC_WRITE_LIMITS.reserve : 0)) { blocked = true; continue; }
          if (!selected || group.queue[0].priority) selected = group;
          if (group.queue[0].priority) break;
        }
        if (!selected) break;
        const item = selected.queue[0];
        selected.queue.shift(); selected.bytes -= item.size; queued -= item.size; if (item.priority) controls -= item.size;
        groups.delete(selected.raw); groups.set(selected.raw, selected);
        try { selected.raw.send(item.bytes); }
        catch (error) { if (item.callback) queueMicrotask(() => item.callback(error)); throw error; }
        sent += item.size;
        if (item.callback) queueMicrotask(() => item.callback());
        maybeClose(selected);
      }
    } catch { close(); failed(); }
    finally { pumping = false; }
    if ([...groups.values()].some(group => group.queue.length)) schedule(blocked ? 2 : 0);
  }
  function discard(group) {
    for (const item of group.queue) {
      if (item.priority) controls -= item.size;
      if (item.callback) queueMicrotask(() => item.callback(Error('RTC channel closed')));
    }
    queued -= group.bytes; group.queue.length = 0; group.bytes = 0;
  }
  function maybeClose(group) {
    if (group.closing && !group.queue.length && !group.raw.bufferedAmount && group.raw.readyState === 'open') {
      clearTimeout(group.closeTimer); group.raw.close();
    }
  }
  function channel(raw, { control = false } = {}) {
    if (ended || groups.has(raw) || groups.size >= RTC_WRITE_LIMITS.groups) throw Error('RTC writer channel limit');
    const group = { raw, queue: [], bytes: 0, subscriptions: [], closing: false, closeTimer: undefined };
    groups.set(raw, group); raw.bufferedAmountLowThreshold = 0;
    group.subscriptions.push(raw.bufferedAmountLow.subscribe(() => { maybeClose(group); schedule(); }));
    group.subscriptions.push(raw.stateChange.subscribe(state => {
      if (state !== 'closed') return;
      clearTimeout(group.closeTimer); discard(group); groups.delete(raw); for (const sub of group.subscriptions) sub.unSubscribe(); schedule();
    }));
    function enqueue(bytes, callback) {
      const size = Buffer.byteLength(bytes), priority = control || typeof bytes === 'string';
      if (ended || group.closing || !valid() || raw.readyState !== 'open' || size > 65536 || group.queue.length >= 64 || group.bytes + size > 512 * 1024 || queued + size > RTC_WRITE_LIMITS.queue || priority && controls + size > RTC_WRITE_LIMITS.control) throw Error('RTC write buffer limit');
      const item = { bytes: typeof bytes === 'string' ? bytes : Buffer.from(bytes), size, priority, callback };
      // ACKs are independent of the opposite business direction. Preserve
      // their own order while allowing them ahead of this stream's data.
      if (ack(bytes)) { let at = 0; while (at < group.queue.length && ack(group.queue[at].bytes)) at++; group.queue.splice(at, 0, item); }
      else group.queue.push(item);
      group.bytes += size; queued += size; if (priority) controls += size; schedule();
    }
    return {
      get readyState() { return group.closing && raw.readyState !== 'closed' ? 'closing' : raw.readyState; }, get bufferedAmount() { return raw.bufferedAmount + group.bytes; },
      onMessage: raw.onMessage, stateChange: raw.stateChange, error: raw.error,
      send: enqueue,
      // TCP reads resume only after admission to SCTP, not merely after adding
      // another record to this scheduler's queue.
      sendTracked: enqueue,
      closeAfterFlush() {
        if (group.closing) return;
        group.closing = true;
        group.closeTimer = setTimeout(() => { discard(group); raw.close(); }, 1000).unref();
        maybeClose(group);
        schedule();
      },
      close() { discard(group); raw.close(); schedule(); },
    };
  }
  function close() {
    if (ended) return; ended = true; clearImmediate(immediate); clearTimeout(timer);
    for (const group of groups.values()) { clearTimeout(group.closeTimer); discard(group); for (const sub of group.subscriptions) sub.unSubscribe(); }
    groups.clear();
  }
  return { channel, close, get bufferedAmount() { return queued + nativeBytes(); } };
}
