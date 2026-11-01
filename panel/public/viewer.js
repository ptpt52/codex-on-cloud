import RFB from './novnc/core/rfb.js';

const status = document.getElementById('status');
const viewer = new URLSearchParams(location.search).get('viewer');
const viewport = document.getElementById('viewport');
const screen = document.getElementById('screen');
const panLayer = document.getElementById('pan-layer');
const preferences = { zoom: 'fit', pan: false };
let rfb, retry, stopping = false;
let canvas, layoutFrame = 0, reportFrame = 0, lastReport = '', drag = null;
function announce(state) {
  parent.postMessage({ type: 'codex-desktop', state }, location.origin);
}
function reportView() {
  cancelAnimationFrame(reportFrame);
  reportFrame = requestAnimationFrame(() => {
    if (!canvas?.width) return;
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const report = { type: 'codex-desktop-view', scale: Math.round(scale * 10000) / 10000 };
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
    if (rfb.viewOnly !== preferences.pan) rfb.viewOnly = preferences.pan;
  }
  if (!preferences.pan) stopDrag();
  panLayer.hidden = !preferences.pan;
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
  if (!(value.zoom === 'fit' || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) || typeof value.pan !== 'boolean') return;
  preferences.zoom = value.zoom;
  preferences.pan = value.pan;
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
function connect() {
  if (stopping || !/^[a-f0-9-]{16,64}$/.test(viewer || '')) return;
  const url = new URL('/desktop/websockify', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('viewer', viewer);
  status.hidden = false;
  status.textContent = '正在连接独立桌面…';
  rfb = new RFB(screen, url.href, { shared: false });
  rfb.scaleViewport = true;
  // Preserve a usable terminal size on phones; rotating the phone scales the view.
  rfb.resizeSession = false;
  rfb.viewOnly = preferences.pan;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener('connect', () => { status.hidden = true; lastReport = ''; applyView(); announce('connected'); });
  rfb.addEventListener('disconnect', () => {
    if (stopping) return;
    status.hidden = false;
    status.textContent = '连接已断开，正在等待恢复。桌面任务继续运行。';
    announce('disconnected');
    // Reconnect only the framebuffer stream. Never replay input or start a task.
    retry = setTimeout(connect, 2500);
  });
}
window.addEventListener('pagehide', () => {
  stopping = true;
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
