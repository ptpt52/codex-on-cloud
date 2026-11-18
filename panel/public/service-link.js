import { directRetry } from './transport-policy.js';
import { desktopTransport } from '/rtc-transport.js';
import { createFileClient } from './file-client.js';
import { createRTCRecheck } from './rtc-recheck.js';
const routes = { 'GET /api/state': 'state', 'GET /api/diagnostics': 'diagnostics', 'GET /api/files': 'files', 'POST /api/files/delete': 'file-delete', 'GET /api/forward': 'forward-list' };
export const serviceAction = (path, method) => Object.hasOwn(routes, method + ' ' + path) ? routes[method + ' ' + path] : null;

// Separate authenticated service link: no frame, desktop claim or input replay.
export function createServiceLink({ viewer, options, changed, canReplace = () => true, trace = () => {} }) {
  let running = false, epoch = 0, current, files, pending, retry, timer, delay = 15000, busy = false, checking = false;
  let attempts = 0, halted = false, healthMisses = 0, retryDue = 0, probeAt = -Infinity;
  let replacing = false, heartbeatLoggedAt = -Infinity, monitorGeneration = 0, fileRecovery;
  let monitorDue = Infinity, healthDue = 0;
  const state = { ready: false, issue: '', route: null };
  const publish = () => changed({ ...state });
  function cancelMonitor() { ++monitorGeneration; clearTimeout(timer); timer = undefined; monitorDue = Infinity; healthDue = 0; checking = false; current?.health.cancel?.(); }
  // One monitor timer. Hints can expedite it, never postpone an earlier check
  // or exceed one scheduled health probe per second on this association.
  function queueMonitor(version, peer, delay) {
    const now = performance.now(), due = Math.max(now + delay, healthDue);
    if (timer !== undefined && monitorDue <= due) return;
    clearTimeout(timer); monitorDue = due;
    timer = setTimeout(() => { timer = undefined; monitorDue = Infinity; void monitor(version, peer); }, Math.max(0, due - now));
  }
  function retire(issue = '') { cancelMonitor(); healthMisses = 0; const old = current, oldFiles = files; current = files = fileRecovery = undefined; state.ready = false; state.route = null; state.issue = issue; if (old) trace('path-lost', { path: 'direct', reason: issue || 'closed' }); oldFiles?.close(); old?.close(); publish(); }
  function schedule(ms = delay) {
    if (!running || halted || document.hidden || !navigator.onLine) return;
    const due = performance.now() + ms; if (retry && retryDue <= due) return;
    clearTimeout(retry); retryDue = due; trace('retry', { path: 'direct', waitMs: Math.round(ms), reason: state.issue }); retry = setTimeout(probe, ms);
  }
  function openFiles(candidate) {
    if (current !== candidate || files) return;
    const channel = candidate.fileChannel();
    const client = createFileClient(channel, recoverable => {
      if (current !== candidate || files !== client) return;
      files = undefined;
      if (!recoverable) { retire('connection'); schedule(1000); return; }
      const reopen = () => {
        if (!running || current !== candidate || files) return;
        // Reuse the one health monitor; never compete with an in-flight ping
        // or admit another file until a fresh echo verifies this association.
        fileRecovery = candidate;
        if (!checking) queueMonitor(epoch, candidate, 0);
      };
      if (channel.readyState === 'closed') queueMicrotask(reopen);
      else channel.addEventListener('close', reopen, { once: true });
      publish();
    }, { window: candidate.features?.filesWindow || 4 });
    files = client; channel.addEventListener('open', publish, { once: true });
  }
  function install(candidate, route, version) {
    const unavailable = () => Object.assign(Error('服务候选连接已关闭或失效'), { reason: 'connection' });
    if (!running || epoch !== version || candidate.closed) throw unavailable();
    cancelMonitor(); const old = current, oldFiles = files;
    current = candidate; files = fileRecovery = undefined; state.ready = false;
    try {
      oldFiles?.close(); old?.close();
      // Install every dependent channel and the monitor before publishing
      // readiness. A failed installation must leave no current peer behind
      // to block the next automatic probe.
      if (candidate.features?.filesProtocol === 1) openFiles(candidate);
      if (!running || epoch !== version || current !== candidate || candidate.closed) throw unavailable();
      queueMonitor(version, candidate, 3000);
      state.ready = true; state.issue = ''; state.route = route; healthMisses = 0;
      trace('path-active', { path: 'direct' }); publish();
    } catch (error) {
      if (current === candidate) retire('connection');
      throw error;
    }
  }
  function keepFileProgress(version, peer) {
    if (!files?.progressing) return false;
    healthMisses = 0; state.issue = peer.control?.draining ? 'rpc-timeout' : '';
    if (performance.now() - heartbeatLoggedAt >= 15000) { heartbeatLoggedAt = performance.now(); trace('heartbeat-delayed', { path: 'direct', reason: 'file-progress', waitMs: 3000 }); }
    queueMonitor(version, peer, 3000); publish(); return true;
  }
  async function monitor(version, peer) {
    if (!running || epoch !== version || current !== peer || checking || replacing || document.hidden || !navigator.onLine) return;
    // An unanswered RPC cannot hold an idle service forever. While a bounded
    // file transfer is active, preserve its separate channel and use HTTPS for
    // new controls. Retire after completion unless the late reply has drained.
    if (peer.control?.draining && !files?.busy) { retire('rpc-timeout'); schedule(1000); return; }
    const generation = ++monitorGeneration;
    const active = () => running && epoch === version && current === peer && generation === monitorGeneration && !document.hidden && navigator.onLine;
    {
      // Authenticated file data/ACKs prove this shared SCTP association is
      // alive. Do not queue an idle probe behind it and retire a working file.
      // If progress stops for six seconds, resume normal heartbeat checks.
      if (keepFileProgress(version, peer)) return;
      checking = true;
      const checkedAt = performance.now(); healthDue = checkedAt + 1000;
      try {
        await peer.health.ping({ confirmation: healthMisses > 0 }); if (!active()) return;
        const route = await peer.stats();
        if (active()) {
          healthMisses = 0; state.issue = peer.control?.draining ? 'rpc-timeout' : ''; state.route = route;
          if (performance.now() - heartbeatLoggedAt >= 15000) { heartbeatLoggedAt = performance.now(); trace('heartbeat-ok', { path: 'direct', rttMs: Math.round(peer.health.rttMs || 0) }); }
          if (fileRecovery === peer) { fileRecovery = undefined; openFiles(peer); }
          publish();
        }
      }
      catch (error) {
        if (active()) {
          if (error.code === 'heartbeat_timeout' && keepFileProgress(version, peer)) return;
          if (error.code === 'heartbeat_timeout') trace('heartbeat-timeout', { path: 'direct', reason: 'heartbeat', durationMs: Math.max(0, Math.round(performance.now() - checkedAt)) });
          if (error.code === 'heartbeat_timeout' && ++healthMisses === 1) { state.issue = 'heartbeat-suspect'; publish(); queueMonitor(version, peer, 0); }
          else { retire(error.code === 'heartbeat_timeout' ? 'heartbeat' : 'connection'); schedule(1000); }
        }
        return;
      }
      finally { if (generation === monitorGeneration) checking = false; }
    }
    if (active()) queueMonitor(version, peer, 3000);
  }
  async function probe() {
    clearTimeout(retry); retry = undefined;
    if (!running || recheck.running || halted || current || pending || document.hidden || !navigator.onLine) return;
    const version = epoch, controller = pending = new AbortController(); let candidate;
    probeAt = performance.now(); state.issue = 'connecting'; publish();
    try {
      candidate = await desktopTransport(viewer, () => {}, { service: true, trace, probe: true, signal: controller.signal, bootstrap: options,
        failed: reason => { if (epoch !== version || controller.signal.aborted) return; state.issue = reason; if (current === candidate) { retire(reason); schedule(1000); } } });
      if (!candidate) throw Error('服务直连不可用');
      await candidate.start(); await candidate.health.ping();
      if (!running || epoch !== version || controller.signal.aborted) throw Error('协商已取消');
      const route = await candidate.stats();
      if (!running || epoch !== version || controller.signal.aborted) throw Error('协商已取消');
      install(candidate, route, version); delay = 15000; attempts = 0;
    } catch (error) {
      candidate?.close(); if (epoch === version && !controller.signal.aborted) {
        state.issue = error?.reason || (state.issue && state.issue !== 'connecting' ? state.issue : 'connection');
        const decision = directRetry(state.issue, attempts++); halted = decision.stop; delay = decision.delay;
        if (halted) trace('probe-stopped', { path: 'direct', reason: state.issue, attempt: attempts });
        state.ready = false; publish(); schedule();
      }
    } finally { if (pending === controller) pending = undefined; }
  }
  function wake() {
    if (!running) return;
    if (document.hidden || !navigator.onLine) {
      cancelMonitor(); healthMisses = 0; clearTimeout(retry); retry = undefined; recheck.cancel();
      if (!current) pending?.abort();
      return;
    }
    if (current && !checking) queueMonitor(epoch, current, 100);
    else if (!current) schedule(Math.max(100, 5000 - (performance.now() - probeAt)));
  }
  const recheck = createRTCRecheck({
    trace,
    allowed: () => running && !pending,
    idle: () => !busy && !files?.busy && !checking && !replacing && canReplace(),
    current: () => current && !current.control?.draining && ({ rttMs: current.health.rttMs }),
    open: async signal => {
      let candidate; const promoteRequired = !!current;
      candidate = await desktopTransport(viewer, () => {}, { service: true, recheck: promoteRequired, probe: true, trace, signal, bootstrap: options,
        failed: reason => { if (current === candidate) { retire(reason); schedule(1000); } } });
      if (candidate) candidate.promoteRequired = promoteRequired;
      return candidate;
    },
    replace: async (candidate, signal, commit) => {
      const version = epoch;
      const eligible = () => running && epoch === version && !signal.aborted && !candidate.closed && !busy && !files?.busy && !checking && canReplace();
      if (!eligible()) return;
      replacing = true;
      try {
        const route = await candidate.stats();
        if (!eligible()) return;
        if (candidate.promoteRequired) {
          if (!commit()) return;
          cancelMonitor();
          // The server retires the old peer when promote commits. From here a
          // soft pause/busy hint cannot discard the replacement after success.
          // The control client's existing eight-second deadline still applies.
          await candidate.control.request('promote', {});
          if (!running || epoch !== version || signal.aborted) return;
        }
        install(candidate, route, version);
        return { retained: true, state: 'selected' };
      } finally {
        replacing = false;
        if (running && epoch === version && current && current !== candidate) {
          queueMonitor(version, current, 100);
        }
      }
    },
  });
  window.addEventListener('online', wake); window.addEventListener('offline', wake); navigator.connection?.addEventListener('change', wake);
  document.addEventListener('visibilitychange', wake);
  return { state, get running() { return running; }, get ready() { return !!current && !current.closed && state.ready && !current.control?.draining; }, get busy() { return busy; },
    get rttMs() { return current?.health.rttMs ?? null; },
    get transport() { return current; },
    get files() { return !replacing && files?.ready ? files : null; },
    get helperFiles() { return !replacing && current?.features?.helperDownloadsProtocol === 1 && files?.ready ? files : null; },
    start() { if (running) return; running = true; epoch++; delay = 15000; attempts = 0; halted = false; void probe(); },
    wake, async recheck(report) { await recheck.run(report); if (running && !current) schedule(1000); },
    stop() { running = false; epoch++; recheck.cancel({ force: true }); clearTimeout(retry); pending?.abort(); pending = undefined; retire(); },
    async request(action, body, signal) {
      const peer = current;
      if (!peer || !state.ready || peer.control?.draining || busy || replacing || signal?.aborted) throw Object.assign(Error('服务直连未就绪，本次操作未发送'), { outcome: 'rejected' });
      busy = true;
      let value;
      try {
        value = await peer.control.request(action, body);
      } catch (err) {
        if (!err.status && current === peer) {
          if (err.code === 'rpc_timeout' && files?.busy) { state.issue = 'rpc-timeout'; publish(); }
          else { retire(err.code === 'rpc_timeout' ? 'rpc-timeout' : 'connection'); schedule(1000); }
        }
        throw err;
      }
      finally { busy = false; }
      // Drain the one admitted RPC before releasing its slot. Caller cancellation
      // does not undo a dispatched action or invalidate the shared file channel.
      if (signal?.aborted) throw Object.assign(Error('请求已取消，操作结果请刷新确认'), { outcome: 'unknown' });
      return value;
    },
  };
}
