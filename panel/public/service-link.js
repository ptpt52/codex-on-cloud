import { directRetry } from './transport-policy.js';
import { desktopTransport } from '/rtc-transport.js';
import { createFileClient } from './file-client.js';
const routes = { 'GET /api/state': 'state', 'GET /api/diagnostics': 'diagnostics', 'GET /api/files': 'files', 'GET /api/forward': 'forward-list',
  'POST /api/forward': 'forward-create', 'POST /api/forward/stop': 'forward-stop', 'POST /api/forward/hints': 'forward-hints' };
export const serviceAction = (path, method) => Object.hasOwn(routes, method + ' ' + path) ? routes[method + ' ' + path] : null;

// Separate authenticated service link: no frame, desktop claim or input replay.
export function createServiceLink({ viewer, options, changed, trace = () => {} }) {
  let running = false, epoch = 0, current, files, pending, retry, timer, delay = 15000, busy = false, checking = false;
  let attempts = 0, halted = false, healthMisses = 0, retryDue = 0, probeAt = -Infinity;
  const state = { ready: false, issue: '', route: null };
  const publish = () => changed({ ...state });
  function retire(issue = '') { clearTimeout(timer); healthMisses = 0; const old = current, oldFiles = files; current = files = undefined; state.ready = false; state.route = null; state.issue = issue; oldFiles?.close(); old?.close(); publish(); }
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
      const reopen = () => { if (running && current === candidate && !files) { openFiles(candidate); publish(); } };
      if (channel.readyState === 'closed') queueMicrotask(reopen);
      else channel.addEventListener('close', reopen, { once: true });
      publish();
    });
    files = client; channel.addEventListener('open', publish, { once: true });
  }
  async function monitor(version, peer) {
    if (!running || epoch !== version || current !== peer || checking) return;
    if (!document.hidden) {
      checking = true;
      try { await peer.health.ping({ confirmation: healthMisses > 0 }); const route = await peer.stats(); if (current === peer && epoch === version) { healthMisses = 0; state.issue = ''; state.route = route; publish(); } }
      catch (error) {
        if (current === peer) {
          if (error.code === 'heartbeat_timeout' && ++healthMisses === 1) { state.issue = 'heartbeat-suspect'; publish(); timer = setTimeout(() => void monitor(version, peer), 0); }
          else { retire('connection'); schedule(1000); }
        }
        return;
      }
      finally { checking = false; }
    }
    if (current === peer && epoch === version) timer = setTimeout(() => void monitor(version, peer), 3000);
  }
  async function probe() {
    clearTimeout(retry); retry = undefined;
    if (!running || halted || current || pending || document.hidden || !navigator.onLine) return;
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
      current = candidate; state.ready = true; state.issue = ''; state.route = route; delay = 15000; attempts = healthMisses = 0; publish();
      if (candidate.features?.filesProtocol === 1) {
        openFiles(candidate);
      }
      timer = setTimeout(() => void monitor(version, candidate), 3000);
    } catch {
      candidate?.close(); if (epoch === version && !controller.signal.aborted) {
        const decision = directRetry(state.issue, attempts++); halted = decision.stop; delay = decision.delay; state.ready = false; publish(); schedule();
      }
    } finally { if (pending === controller) pending = undefined; }
  }
  function wake() { if (!running) return; if (current && !checking) { clearTimeout(timer); timer = setTimeout(() => void monitor(epoch, current), 100); } else if (!current) schedule(Math.max(100, 5000 - (performance.now() - probeAt))); }
  window.addEventListener('online', wake); navigator.connection?.addEventListener('change', wake);
  document.addEventListener('visibilitychange', wake);
  return { state, get running() { return running; }, get ready() { return !!current && state.ready; }, get busy() { return busy; },
    get rttMs() { return current?.health.rttMs ?? null; },
    get transport() { return current; },
    get files() { return files?.ready ? files : null; },
    get helperFiles() { return current?.features?.helperDownloadsProtocol === 1 && files?.ready ? files : null; },
    start() { if (running) return; running = true; epoch++; delay = 15000; attempts = 0; halted = false; void probe(); },
    wake,
    stop() { running = false; epoch++; clearTimeout(retry); pending?.abort(); pending = undefined; retire(); },
    async request(action, body, signal) {
      const peer = current;
      if (!peer || !state.ready || busy || signal?.aborted) throw Object.assign(Error('服务直连未就绪，本次操作未发送'), { outcome: 'rejected' });
      busy = true;
      try {
        const value = await peer.control.request(action, body);
        if (signal?.aborted) throw Object.assign(Error('请求已取消，操作结果请刷新确认'), { outcome: 'unknown' });
        return value;
      } catch (err) { if (!err.status && current === peer) { retire('connection'); schedule(1000); } throw err; }
      finally { busy = false; }
    },
  };
}
