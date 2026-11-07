// A single read-only probe and deadline, independent of terminal input IDs.
export function createTerminalHealth(send, failed) {
  let active = false, ended = false, sequence = 0, pending = 0, timer, deadline, networkCheck = false, sentAt;
  let rttMs = null, measuredAt = 0;
  function cancel() {
    clearTimeout(timer); clearTimeout(deadline);
    timer = deadline = sentAt = undefined; pending = 0; rttMs = null;
  }
  function fail() {
    if (ended || !active) return;
    ended = true; active = false; cancel(); failed();
  }
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!active || ended) return;
      if (sequence >= 2147483647) return fail();
      pending = ++sequence;
      deadline = setTimeout(fail, 2000);
      sentAt = performance.now();
      try { if (send(pending) !== true) fail(); } catch { fail(); }
    }, delay);
  }
  return {
    get rttMs() { return performance.now() - measuredAt <= 10000 ? rttMs : null; },
    start() {
      if (ended) return;
      cancel(); active = true; networkCheck = false; schedule(3000);
    },
    wake() {
      if (ended || (networkCheck && (pending || timer !== undefined))) return;
      cancel(); active = true; networkCheck = true; schedule(250);
    },
    suspend() { active = false; networkCheck = false; cancel(); },
    close() { ended = true; active = false; cancel(); },
    receive(nonce) {
      if (ended || !active) return;
      if (!Number.isSafeInteger(nonce) || nonce <= 0 || nonce > sequence) return fail();
      if (nonce !== pending) return; // Late echoes cannot acknowledge a fresh probe.
      measuredAt = performance.now(); rttMs = Math.round(measuredAt - sentAt); sentAt = undefined;
      clearTimeout(deadline); deadline = undefined; pending = 0; networkCheck = false; schedule(3000);
    },
  };
}
