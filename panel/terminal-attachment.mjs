export const TERMINAL_IDLE_TTL = 60000;

// One replaceable viewer of a tmux task, no task creation or operation queue.
// Its generation fences callbacks from retired helpers; the parent owns auth
// and network paths. A detached viewer has one bounded idle timer.
export function createTerminalAttachment({ connect, push, changed, expired, fatal, idleMs = TERMINAL_IDLE_TTL }) {
  let source, generation = 0, disposed = false, timer;
  let status = { state: 'idle', reason: '' };
  const publish = () => { if (!disposed) changed({ ...status }); };
  function release() { generation++; const previous = source; source = undefined; previous?.close(); }
  function end(reason) {
    if (disposed || ['exited', 'failed'].includes(status.state)) return;
    if (!['target-exited', 'helper-failed', 'helper-timeout'].includes(reason)) { fatal(); return; }
    release(); status = { state: reason === 'target-exited' ? 'exited' : 'failed', reason }; publish();
    if (disposed) return;
    clearTimeout(timer); timer = setTimeout(expired, idleMs).unref();
  }
  return {
    attach() {
      if (disposed) throw Error('terminal attachment closed');
      clearTimeout(timer); release(); const current = generation;
      status = { state: 'attaching', reason: '' }; publish();
      if (disposed || current !== generation) return;
      try {
        const opened = connect({
          push: bytes => { if (!disposed && current === generation) push(bytes); },
          ready: () => { if (!disposed && current === generation) { status = { state: 'ready', reason: '' }; publish(); } },
          close: reason => { if (!disposed && current === generation) end(reason); },
        });
        if (!disposed && current === generation) source = opened; else opened?.close();
      } catch { end('helper-failed'); }
    },
    end, publish, release,
    write(bytes) { if (status.state !== 'ready' || !source) throw Error('terminal is not attached'); source.write(bytes); },
    pause() { source?.pause(); }, resume() { source?.resume(); },
    close() { if (disposed) return; disposed = true; clearTimeout(timer); release(); },
    get ready() { return status.state === 'ready'; },
    get idle() { return source?.idle ?? true; },
    get status() { return { ...status }; },
  };
}
