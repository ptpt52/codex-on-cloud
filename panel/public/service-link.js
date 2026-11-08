import { desktopTransport } from '/rtc-transport.js';
import { createFileClient } from './file-client.js';
const routes = { 'GET /api/state': 'state', 'GET /api/diagnostics': 'diagnostics', 'GET /api/files': 'files', 'GET /api/forward': 'forward-list',
  'POST /api/forward': 'forward-create', 'POST /api/forward/stop': 'forward-stop', 'POST /api/forward/hints': 'forward-hints' };
export const serviceAction = (path, method) => Object.hasOwn(routes, method + ' ' + path) ? routes[method + ' ' + path] : null;

// Separate authenticated service link: no frame, desktop claim or input replay.
export function createServiceLink({ viewer, options, changed, trace = () => {} }) {
  let running = false, epoch = 0, current, files, pending, retry, timer, delay = 15000, busy = false, checking = false;
  const state = { ready: false, issue: '', route: null };
  const publish = () => changed({ ...state });
  function retire(issue = '') { clearTimeout(timer); const old = current, oldFiles = files; current = files = undefined; state.ready = false; state.route = null; state.issue = issue; oldFiles?.close(); old?.close(); publish(); }
  function schedule(ms = delay) { clearTimeout(retry); if (running && !document.hidden && navigator.onLine) retry = setTimeout(probe, ms); }
  async function monitor(version, peer) {
    if (!running || epoch !== version || current !== peer || checking) return;
    if (!document.hidden) {
      checking = true;
      try { await peer.health.ping(); const route = await peer.stats(); if (current === peer && epoch === version) { state.route = route; publish(); } }
      catch { if (current === peer) { retire('connection'); schedule(1000); } return; }
      finally { checking = false; }
    }
    if (current === peer && epoch === version) timer = setTimeout(() => void monitor(version, peer), 3000);
  }
  async function probe() {
    clearTimeout(retry); retry = undefined;
    if (!running || current || pending || document.hidden || !navigator.onLine) return;
    const version = epoch, controller = pending = new AbortController(); let candidate;
    state.issue = 'connecting'; publish();
    try {
      candidate = await desktopTransport(viewer, () => {}, { service: true, trace, probe: true, signal: controller.signal, bootstrap: options,
        failed: reason => { if (epoch !== version || controller.signal.aborted) return; state.issue = reason; if (current === candidate) { retire(reason); schedule(1000); } } });
      if (!candidate) throw Error('服务直连不可用');
      await candidate.start(); await candidate.health.ping();
      if (!running || epoch !== version || controller.signal.aborted) throw Error('协商已取消');
      const route = await candidate.stats();
      if (!running || epoch !== version || controller.signal.aborted) throw Error('协商已取消');
      current = candidate; state.ready = true; state.issue = ''; state.route = route; delay = 15000; publish();
      if (candidate.features?.filesProtocol === 1) {
        const channel = candidate.fileChannel();
        files = createFileClient(channel, () => { if (current === candidate) { retire('connection'); schedule(1000); } });
        channel.addEventListener('open', publish);
      }
      timer = setTimeout(() => void monitor(version, candidate), 3000);
    } catch {
      candidate?.close(); if (epoch === version && !controller.signal.aborted) { state.ready = false; publish(); schedule(); delay = Math.min(delay * 2, 60000); }
    } finally { if (pending === controller) pending = undefined; }
  }
  function wake() { if (!running) return; if (current && !checking) { clearTimeout(timer); timer = setTimeout(() => void monitor(epoch, current), 100); } else if (!current) schedule(100); }
  window.addEventListener('online', wake); navigator.connection?.addEventListener('change', wake);
  document.addEventListener('visibilitychange', wake);
  return { state, get running() { return running; }, get ready() { return !!current && state.ready; }, get busy() { return busy; },
    get rttMs() { return current?.health.rttMs ?? null; },
    get transport() { return current; },
    get files() { return files?.ready ? files : null; },
    start() { if (running) return; running = true; epoch++; delay = 15000; void probe(); },
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
