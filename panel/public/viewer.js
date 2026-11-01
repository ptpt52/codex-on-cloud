import RFB from './novnc/core/rfb.js';
import { desktopTransport, canTryDirect } from './rtc.js';

const status = document.getElementById('status');
const viewer = new URLSearchParams(location.search).get('viewer');
const frame = new URLSearchParams(location.search).get('frame');
const viewport = document.getElementById('viewport');
const screen = document.getElementById('screen');
const panLayer = document.getElementById('pan-layer');
const preferences = { zoom: 'fit', pan: false, blocked: true, revision: -1 };
let rfb, retry, stopping = false;
let transport, directFailed = false, connectionEpoch = 0, transportName = '';
let viewing = false, switching = false, switchingFrom, probeTimer, probeController, probeDelay = 15000, switchSequence = 0, switchApproval;
const pressedKeys = new Set(), pressedPointers = new Set();
let lastInteraction = 0;
let canvas, layoutFrame = 0, reportFrame = 0, lastReport = '', drag = null;
function announce(state) {
  parent.postMessage({ type: 'codex-desktop', state, frame, transport: transportName }, location.origin);
}
function reportControl() {
  parent.postMessage({ type: 'codex-control-state', frame, ready: transportName === 'direct' && transport?.control.ready === true }, location.origin);
  scheduleProbe();
}
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent || value?.frame !== frame || !Number.isSafeInteger(value.id) || value.id < 1) return;
  if (value.type === 'codex-control-cancel') { transport?.control.close(); return; }
  if (value.type !== 'codex-control-request') return;
  const current = transport;
  const request = current?.control.ready && !preferences.blocked
    ? current.control.request(value.action, value.body)
    : Promise.reject(Object.assign(new Error('直连暂不可用，本次操作未发送'), { outcome: 'rejected' }));
  void request.then(result => {
    parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: true, value: result }, location.origin);
  }, error => {
    parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: false,
      error: { message: error.message, outcome: error.outcome || 'unknown', status: error.status } }, location.origin);
  });
});
function reportView() {
  cancelAnimationFrame(reportFrame);
  reportFrame = requestAnimationFrame(() => {
    if (!canvas?.width) return;
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const report = { type: 'codex-desktop-view', frame, revision: preferences.revision, scale: Math.round(scale * 10000) / 10000, width: canvas.width, height: canvas.height };
    const signature = JSON.stringify(report);
    if (signature === lastReport) return;
    lastReport = signature;
    parent.postMessage(report, location.origin);
  });
}
const canvasObserver = new ResizeObserver(reportView);
function applyView() {
  cancelAnimationFrame(layoutFrame);
  const nextCanvas = screen.querySelector('canvas');
  if (nextCanvas !== canvas) {
    canvasObserver.disconnect();
    canvas = nextCanvas;
    if (canvas) canvasObserver.observe(canvas);
  }
  const rect = canvas?.getBoundingClientRect();
  const center = {
    x: rect?.width ? (viewport.clientWidth / 2 - rect.left) / rect.width : 0.5,
    y: rect?.height ? (viewport.clientHeight / 2 - rect.top) / rect.height : 0.5,
  };
  const manual = preferences.zoom !== 'fit' && canvas?.width && canvas?.height;
  screen.style.width = manual ? `${Math.round(canvas.width * preferences.zoom)}px` : '100%';
  screen.style.height = manual ? `${Math.round(canvas.height * preferences.zoom)}px` : '100%';
  if (rfb) {
    // Resize the local container through public APIs; remote pixels and input coordinates stay intact.
    rfb.scaleViewport = true;
    if (rfb.viewOnly !== (preferences.pan || preferences.blocked)) rfb.viewOnly = preferences.pan || preferences.blocked;
  }
  if (!preferences.pan && !preferences.blocked) stopDrag();
  panLayer.hidden = !preferences.pan && !preferences.blocked;
  layoutFrame = requestAnimationFrame(() => {
    if (manual) {
      viewport.scrollLeft = Math.max(0, Math.min(1, center.x)) * canvas.width * preferences.zoom - viewport.clientWidth / 2;
      viewport.scrollTop = Math.max(0, Math.min(1, center.y)) * canvas.height * preferences.zoom - viewport.clientHeight / 2;
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    reportView();
  });
}
const screenObserver = new MutationObserver(applyView);
screenObserver.observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
const viewportObserver = new ResizeObserver(applyView);
viewportObserver.observe(viewport);
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent || value?.type !== 'codex-desktop-options') return;
  if (!(value.zoom === 'fit' || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) || typeof value.pan !== 'boolean' || typeof value.blocked !== 'boolean') return;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return;
  preferences.zoom = value.zoom;
  preferences.pan = value.pan;
  // Let an already held key/pointer release on the old stream. A handoff is
  // refused below if native input raced with the parent's idle confirmation.
  preferences.blocked = value.handoff === true && (pressedKeys.size || pressedPointers.size) ? false : value.blocked;
  preferences.busy = value.busy === true;
  preferences.revision = value.revision ?? 0;
  applyView();
});

// A separate input layer blocks taps, wheel events and keys before noVNC can send them.
function stopDrag(event) {
  if (event && drag && event.pointerId !== drag.id) return;
  const id = drag?.id;
  drag = null;
  panLayer.classList.remove('dragging');
  if (id !== undefined && panLayer.hasPointerCapture(id)) panLayer.releasePointerCapture(id);
}
panLayer.addEventListener('pointerdown', event => {
  event.preventDefault();
  if (drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  panLayer.setPointerCapture(event.pointerId);
  panLayer.focus({ preventScroll: true });
  panLayer.classList.add('dragging');
});
panLayer.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  event.preventDefault();
  viewport.scrollLeft += drag.x - event.clientX;
  viewport.scrollTop += drag.y - event.clientY;
  drag.x = event.clientX;
  drag.y = event.clientY;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) panLayer.addEventListener(name, stopDrag);
for (const name of ['click', 'contextmenu']) panLayer.addEventListener(name, event => event.preventDefault());
panLayer.addEventListener('wheel', event => {
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  viewport.scrollLeft += event.deltaX * unit;
  viewport.scrollTop += event.deltaY * unit;
}, { passive: false });
panLayer.addEventListener('keydown', event => {
  const steps = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60], PageUp: [0, -viewport.clientHeight], PageDown: [0, viewport.clientHeight] };
  if (!steps[event.key]) return;
  event.preventDefault();
  viewport.scrollLeft += steps[event.key][0];
  viewport.scrollTop += steps[event.key][1];
});
function needsProbe() {
  return !stopping && viewing && !switching && canTryDirect() && (!transport || !transport.control.ready);
}
function idleForSwitch() {
  return !preferences.blocked && !preferences.busy && !pressedKeys.size && !pressedPointers.size && performance.now() - lastInteraction >= 800;
}
function scheduleProbe(delay = probeDelay) {
  if (probeTimer || probeController || !needsProbe() || document.hidden || !navigator.onLine) return;
  probeTimer = setTimeout(() => { probeTimer = null; void probeDirect(); }, delay);
}
function finishSwitch() {
  switching = false; switchingFrom = undefined;
  parent.postMessage({ type: 'codex-direct-finished', frame }, location.origin);
}
function prepareSwitch(signal) {
  return new Promise(resolve => {
    const id = ++switchSequence;
    const finish = allowed => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (switchApproval?.id === id) switchApproval = undefined;
      resolve(allowed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, 2000);
    switchApproval = { id, finish };
    signal.addEventListener('abort', abort, { once: true });
    parent.postMessage({ type: 'codex-direct-prepare', frame, id }, location.origin);
  });
}
window.addEventListener('message', event => {
  const value = event.data;
  if (switchApproval && event.origin === location.origin && event.source === parent && value?.type === 'codex-direct-approved' && value.frame === frame && value.id === switchApproval.id) switchApproval.finish(value.allowed === true);
});
function waitStable(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('探测已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function probeDirect() {
  if (!needsProbe() || document.hidden || !navigator.onLine) return;
  if (!idleForSwitch()) { scheduleProbe(5000); return; }
  const controller = probeController = new AbortController(), epoch = connectionEpoch;
  let candidate, prepared = false, requested = false, promoted = false;
  try {
    candidate = await desktopTransport(viewer, () => { if (transport === candidate) reportControl(); }, { probe: true, signal: controller.signal });
    if (!candidate) throw new Error('直连未就绪');
    await candidate.start();
    await candidate.control.request('ping', {});
    await waitStable(controller.signal);
    await candidate.control.request('ping', {});
    if (!needsProbe() || epoch !== connectionEpoch || !idleForSwitch() || controller.signal.aborted) return;
    requested = true;
    prepared = await prepareSwitch(controller.signal);
    if (!prepared || epoch !== connectionEpoch || stopping || controller.signal.aborted) return;
    if (pressedKeys.size || pressedPointers.size || performance.now() - lastInteraction < 800) return;
    switching = true; switchingFrom = rfb;
    await candidate.control.request('activate', {});
    if (epoch !== connectionEpoch || stopping || controller.signal.aborted) return;
    attachViewer(candidate);
    promoted = true; probeDelay = 15000;
  } catch {
    probeDelay = Math.min(60000, probeDelay * 2);
  } finally {
    if (!promoted) candidate?.close();
    probeController = null;
    if (requested && !promoted) {
      finishSwitch();
      if (!viewing && !stopping) { announce('disconnected'); clearTimeout(retry); retry = setTimeout(connect, 2500); }
    }
    scheduleProbe();
  }
}
function attachViewer(direct) {
  const previous = rfb, previousTransport = transport;
  transport = direct;
  transportName = direct ? 'direct' : 'relay';
  const url = new URL('/desktop/websockify', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('viewer', viewer);
  const instance = rfb = new RFB(screen, direct ? direct.video() : url.href, { shared: false });
  if (previousTransport !== direct) previousTransport?.close();
  previous?.disconnect();
  instance.scaleViewport = true;
  instance.resizeSession = false;
  instance.viewOnly = preferences.pan || preferences.blocked;
  instance.qualityLevel = 6;
  instance.compressionLevel = 2;
  instance.addEventListener('connect', () => {
    if (rfb !== instance || stopping) return;
    viewing = true; status.hidden = true; lastReport = ''; applyView(); announce('connected'); reportControl();
    if (switching) finishSwitch();
    scheduleProbe();
  });
  instance.addEventListener('disconnect', () => {
    if (rfb !== instance || stopping) return;
    viewing = false;
    if (switching && switchingFrom === instance) return;
    if (switching) finishSwitch();
    if (direct) directFailed = true;
    direct?.close();
    probeController?.abort(); clearTimeout(probeTimer); probeTimer = null;
    status.hidden = false;
    status.textContent = '连接已断开，正在等待恢复。桌面任务继续运行。';
    announce('disconnected');
    clearTimeout(retry); retry = setTimeout(connect, 2500);
  });
  return instance;
}
async function connect() {
  if (stopping || !/^[a-f0-9-]{16,64}$/.test(viewer || '')) return;
  const epoch = ++connectionEpoch;
  transportName = ''; viewing = false;
  announce('connecting');
  status.hidden = false; status.textContent = '正在连接独立桌面…';
  const direct = directFailed ? null : await desktopTransport(viewer, reportControl);
  if (stopping || connectionEpoch !== epoch) { direct?.close(); return; }
  const instance = attachViewer(direct);
  // RFB handlers are attached before negotiation can deliver video bytes.
  if (direct) void direct.start().catch(() => instance.disconnect());
}
for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(name, event => {
  lastInteraction = performance.now();
  if (name === 'keydown' && pressedKeys.size < 64) pressedKeys.add(event.code || event.key);
  if (name === 'keyup') pressedKeys.delete(event.code || event.key);
  if (name === 'pointerdown' && pressedPointers.size < 8) pressedPointers.add(event.pointerId);
  if (name === 'pointerup' || name === 'pointercancel') pressedPointers.delete(event.pointerId);
}, true);
window.addEventListener('blur', () => { pressedKeys.clear(); pressedPointers.clear(); lastInteraction = performance.now(); });
function networkChanged() {
  if (document.hidden || !navigator.onLine) { if (!switching) probeController?.abort(); clearTimeout(probeTimer); probeTimer = null; return; }
  probeDelay = 15000; clearTimeout(probeTimer); probeTimer = null; scheduleProbe(1000);
}
window.addEventListener('online', networkChanged);
window.addEventListener('offline', networkChanged);
document.addEventListener('visibilitychange', networkChanged);
navigator.connection?.addEventListener('change', networkChanged);
window.addEventListener('pagehide', () => {
  stopping = true;
  connectionEpoch++;
  probeController?.abort(); clearTimeout(probeTimer); switchApproval?.finish(false);
  transport?.close();
  stopDrag();
  clearTimeout(retry);
  cancelAnimationFrame(layoutFrame);
  cancelAnimationFrame(reportFrame);
  screenObserver.disconnect();
  canvasObserver.disconnect();
  viewportObserver.disconnect();
  rfb?.disconnect();
});
announce('ready');
connect();
