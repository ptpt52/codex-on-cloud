import RFB from './novnc/core/rfb.js';
import { desktopTransport, canTryDirect } from './rtc.js';
import { createDesktopPointer } from './desktop-pointer.js';
import { createFrameHold } from './frame-hold.js';
import { routePolicy, STABLE_ROUTE } from './transport-policy.js';
import { createStreamClient } from './stream-client.js';
import { afterFirstFrame } from './first-frame.js';
import { createPanelBridge } from '/control.js';

const status = document.getElementById('status');
const viewer = new URLSearchParams(location.search).get('viewer');
const frame = new URLSearchParams(location.search).get('frame');
const viewport = document.getElementById('viewport');
const frameHold = createFrameHold(viewport), fastConnect = new URLSearchParams(location.search).get('fast') === '1', routes = routePolicy();
const streamEnabled = new URLSearchParams(location.search).get('stream') === '1';
let streamClient, streamPaused = false, streamCsrf = '', rtcConfig;
const remoteKeys = new Map();
let lastMouse = { x: 0, y: 0, buttons: 0 }, releaseMouse = false;
const screen = document.getElementById('screen');
const panLayer = document.getElementById('pan-layer');
const preferences = { zoom: 'fit', pan: false, blocked: true, revision: -1, pointerMode: 'touch', scrollTarget: 'viewport' };
let rfb, retry, stopping = false, resizeReady = false, frameReadiness;
let transport, directFailed = false, connectionEpoch = 0, transportName = '';
let viewing = false, connecting = false, switching = false, switchingFrom, probeTimer, probeController, probeDelay = 15000, switchSequence = 0, switchApproval;
let healthTimer, healthGeneration = 0, healthNetworkCheck = false, viewAnchor, restoringView = false;
let networkDetails = null, directIssue = '', statsPending = false;
const pressedKeys = new Set(), pressedPointers = new Set();
let lastInteraction = -Infinity, idleTimer;
let canvas, layoutFrame = 0, reportFrame = 0, lastReport = '', drag = null, scrollGesture = null;
const pointerControls = createDesktopPointer({ viewport, screen, cursor: document.getElementById('touch-cursor'), controls: document.getElementById('pointer-controls'),
  changed: () => { lastInteraction = performance.now(); reportView(); clearTimeout(idleTimer); idleTimer = setTimeout(reportView, 850); },
  chooseScroll: scrollTarget => parent.postMessage({ type: 'codex-pointer-options', frame, scrollTarget }, location.origin) });
function announce(state) {
  parent.postMessage({ type: 'codex-desktop', state, frame, transport: transportName }, location.origin);
}
function reportNetwork() {
  parent.postMessage({ type: 'codex-transport', frame, details: networkDetails, issue: directIssue }, location.origin);
}
function directFailure(reason) { directIssue = reason; reportNetwork(); }
async function refreshNetwork() {
  const current = transport;
  if (!current || !viewing || statsPending || stopping) return;
  statsPending = true;
  try {
    const details = await current.stats();
    if (transport === current && viewing && !stopping) { networkDetails = details; reportNetwork(); }
  } catch {} finally { statsPending = false; }
}
function reportControl() {
  parent.postMessage({ type: 'codex-control-state', frame, ready: transportName === 'direct' && transport?.control.ready === true }, location.origin);
  panelBridge.report();
  scheduleProbe();
}
const panelBridge = createPanelBridge({ frame, current: () => streamClient?.socket, connected: () => viewing && transportName === 'direct' });
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
    const report = { type: 'codex-desktop-view', frame, revision: preferences.revision, scale: Math.round(scale * 10000) / 10000, width: canvas.width, height: canvas.height,
      resizeReady, idle: !pressedKeys.size && !pressedPointers.size && !pointerControls.busy && performance.now() - lastInteraction >= 800 };
    const signature = JSON.stringify(report);
    if (signature === lastReport) return;
    lastReport = signature;
    parent.postMessage(report, location.origin);
  });
}
const canvasObserver = new ResizeObserver(reportView);
function rememberView() {
  if (!viewing || restoringView || !canvas?.width || !canvas?.height) return;
  const scale = canvas.getBoundingClientRect().width / canvas.width;
  if (scale > 0 && Number.isFinite(scale)) viewAnchor = { zoom: preferences.zoom, x: viewport.scrollLeft / scale, y: viewport.scrollTop / scale };
}
viewport.addEventListener('scroll', rememberView);
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
  const widthFit = preferences.zoom === 'width' && canvas?.width && canvas?.height;
  const manual = typeof preferences.zoom === 'number' && canvas?.width && canvas?.height;
  const scrollTop = viewport.scrollTop;
  screen.style.width = widthFit ? `${viewport.clientWidth}px` : manual ? `${Math.round(canvas.width * preferences.zoom)}px` : '100%';
  screen.style.height = widthFit ? `${Math.ceil(canvas.height * viewport.clientWidth / canvas.width)}px` : manual ? `${Math.round(canvas.height * preferences.zoom)}px` : '100%';
  // Release a synthetic drag on its original stream before viewOnly changes.
  pointerControls.update(canvas, viewing && !streamPaused, preferences);
  if (rfb) {
    // Resize the local container through public APIs; remote pixels and input coordinates stay intact.
    rfb.scaleViewport = true;
    if (rfb.viewOnly !== (preferences.pan || preferences.blocked || streamPaused)) rfb.viewOnly = preferences.pan || preferences.blocked || streamPaused;
  }
  if (!preferences.pan && !preferences.blocked) stopDrag();
  panLayer.hidden = !preferences.pan && !preferences.blocked;
  layoutFrame = requestAnimationFrame(() => {
    if (!viewing || !canvas?.width || !canvas?.height) return;
    if (restoringView && viewAnchor?.zoom === preferences.zoom && (manual || widthFit)) {
      const scale = widthFit ? viewport.clientWidth / canvas.width : preferences.zoom;
      viewport.scrollLeft = widthFit ? 0 : viewAnchor.x * scale;
      viewport.scrollTop = viewAnchor.y * scale;
    } else if (manual) {
      viewport.scrollLeft = Math.max(0, Math.min(1, center.x)) * canvas.width * preferences.zoom - viewport.clientWidth / 2;
      viewport.scrollTop = Math.max(0, Math.min(1, center.y)) * canvas.height * preferences.zoom - viewport.clientHeight / 2;
    } else if (widthFit) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = scrollTop;
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    restoringView = false;
    rememberView();
    reportView();
  });
}
const screenObserver = new MutationObserver(applyView);
screenObserver.observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
const viewportObserver = new ResizeObserver(applyView);
viewportObserver.observe(viewport);
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent || value?.type !== 'codex-desktop-options' || value.frame !== frame) return;
  if (value.rtc && typeof value.rtc.webrtc === 'boolean' && typeof value.rtc.rtcStunUrl === 'string' && value.rtc.rtcStunUrl.length <= 256) rtcConfig = { webrtc: value.rtc.webrtc, rtcStunUrl: value.rtc.rtcStunUrl };
  if (!(['fit', 'width'].includes(value.zoom) || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) || typeof value.pan !== 'boolean' || typeof value.blocked !== 'boolean') return;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return;
  preferences.zoom = value.zoom;
  preferences.pan = value.pan;
  if (['touch', 'trackpad'].includes(value.pointerMode)) preferences.pointerMode = value.pointerMode;
  if (['viewport', 'remote'].includes(value.scrollTarget)) preferences.scrollTarget = value.scrollTarget;
  // Let an already held key/pointer release on the old stream. A handoff is
  // refused below if native input raced with the parent's idle confirmation.
  preferences.blocked = value.handoff === true && (pressedKeys.size || pressedPointers.size || pointerControls.busy) ? false : value.blocked;
  preferences.busy = value.busy === true;
  preferences.revision = value.revision ?? 0;
  if (streamEnabled && typeof value.csrf === 'string' && value.csrf.length <= 256 && value.csrf && !streamCsrf) { streamCsrf = value.csrf; void connect(); }
  applyView();
});

// Intercept scrolling gestures before the pinned noVNC 1.7 gesture handler turns
// them into remote drags. Taps and native mouse/keyboard input remain with noVNC.
for (const name of ['gesturestart', 'gesturemove', 'gestureend']) screen.addEventListener(name, event => {
  if (!['drag', 'twodrag'].includes(event.detail?.type)) return;
  if (!scrollGesture && (preferences.scrollTarget !== 'viewport' || preferences.pan || preferences.blocked)) return;
  event.stopImmediatePropagation();
  const y = event.detail.type === 'twodrag' ? event.detail.magnitudeY : event.detail.clientY;
  if (name === 'gesturestart') scrollGesture = { y, instance: rfb };
  if (name === 'gesturemove' && scrollGesture) {
    if (scrollGesture.instance === rfb && preferences.scrollTarget === 'viewport' && !preferences.pan && !preferences.blocked) viewport.scrollTop += scrollGesture.y - y;
    scrollGesture.y = y;
  }
  if (name === 'gestureend') scrollGesture = null;
}, true);
viewport.addEventListener('wheel', event => {
  if (preferences.scrollTarget !== 'viewport' || preferences.pan || preferences.blocked) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  viewport.scrollLeft += event.deltaX * unit;
  viewport.scrollTop += event.deltaY * unit;
}, { capture: true, passive: false });

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
  return !streamClient && !stopping && viewing && !switching && canTryDirect() && (!transport || !transport.control.ready);
}
function stopHealth() {
  healthGeneration++;
  healthNetworkCheck = false;
  clearTimeout(healthTimer); healthTimer = undefined;
  transport?.health.cancel();
}
function monitorDirect(delay = 3000) {
  stopHealth();
  if (streamClient) return;
  if (stopping || !viewing || !transport || document.hidden || !navigator.onLine) return;
  const current = transport, generation = healthGeneration;
  const tick = async () => {
    healthTimer = undefined;
    if (generation !== healthGeneration || current !== transport || !viewing || stopping || document.hidden || !navigator.onLine) return;
    try {
      await current.health.ping();
      if (generation === healthGeneration && current === transport) {
        healthNetworkCheck = false;
        void refreshNetwork(); healthTimer = setTimeout(tick, 3000);
      }
    } catch {
      if (generation !== healthGeneration || current !== transport || stopping || document.hidden || !navigator.onLine) return;
      // Cancel uncertain input in the parent before replacing the stream. Never replay it.
      rememberView(); stopHealth();
      directFailure('heartbeat'); networkDetails = null;
      directFailed = true; viewing = false; connecting = false;
      probeController?.abort(); clearTimeout(probeTimer); probeTimer = null;
      if (switching) finishSwitch();
      pressedKeys.clear(); pressedPointers.clear();
      announce('disconnected');
      clearTimeout(retry);
      void connect();
    }
  };
  healthTimer = setTimeout(tick, delay);
}
function idleForSwitch() {
  return !preferences.blocked && !preferences.busy && !pressedKeys.size && !pressedPointers.size && !pointerControls.busy && performance.now() - lastInteraction >= 800;
}
function scheduleProbe(delay = probeDelay) {
  if (probeTimer || probeController || !needsProbe() || document.hidden || !navigator.onLine) return;
  probeTimer = setTimeout(() => { probeTimer = null; void probeDirect(); }, fastConnect ? Math.max(delay, routes.remaining()) : delay);
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
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, fastConnect ? STABLE_ROUTE : 500);
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
    candidate = await desktopTransport(viewer, () => { if (transport === candidate) reportControl(); }, { probe: true, signal: controller.signal,
      failed: reason => { if (epoch === connectionEpoch && !controller.signal.aborted) directFailure(reason); } });
    if (!candidate) throw new Error('直连未就绪');
    await candidate.start();
    await candidate.control.request('ping', {});
    await waitStable(controller.signal);
    await candidate.control.request('ping', {});
    if (!needsProbe() || epoch !== connectionEpoch || !idleForSwitch() || controller.signal.aborted) return;
    requested = true;
    prepared = await prepareSwitch(controller.signal);
    if (!prepared || epoch !== connectionEpoch || stopping || controller.signal.aborted) return;
    if (pressedKeys.size || pressedPointers.size || pointerControls.busy || performance.now() - lastInteraction < 800) return;
    switching = true; switchingFrom = rfb;
    frameHold.capture(canvas);
    await candidate.control.request('activate', {});
    if (epoch !== connectionEpoch || stopping || controller.signal.aborted) return;
    attachViewer(candidate);
    promoted = true; probeDelay = 15000; routes.changed();
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
function attachViewer(direct, channel) {
  frameReadiness?.(); frameReadiness = undefined;
  pointerControls.update(canvas, false, preferences);
  rememberView(); stopHealth();
  restoringView = !!viewAnchor;
  viewing = false; connecting = true;
  scrollGesture = null;
  const previous = rfb, previousTransport = transport;
  transport = direct;
  networkDetails = null;
  transportName = direct ? 'direct' : 'relay';
  const url = new URL('/desktop/websockify', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('viewer', viewer);
  const instance = rfb = new RFB(screen, channel || (direct ? direct.video() : url.href), { shared: false });
  resizeReady = false;
  frameReadiness = afterFirstFrame(instance, () => {
    if (rfb !== instance || stopping) return;
    resizeReady = true; reportView();
  });
  if (channel) {
    const sendKey = instance.sendKey.bind(instance);
    instance.sendKey = (keysym, code, down) => {
      if (viewing && !instance.viewOnly && down !== undefined) {
        if (down && remoteKeys.size < 64) remoteKeys.set(code, keysym); else if (!down) remoteKeys.delete(code);
      }
      sendKey(keysym, code, down);
    };
  }
  if (previousTransport !== direct) previousTransport?.close();
  previous?.disconnect();
  instance.scaleViewport = true;
  instance.resizeSession = false;
  instance.viewOnly = preferences.pan || preferences.blocked;
  instance.qualityLevel = 6;
  instance.compressionLevel = 2;
  instance.addEventListener('connect', () => {
    if (rfb !== instance || stopping) return;
    connecting = false; viewing = true; status.hidden = true; lastReport = ''; applyView(); announce('connected'); reportControl();
    if (direct) directIssue = '';
    reportNetwork(); void refreshNetwork();
    clearTimeout(idleTimer); idleTimer = setTimeout(reportView, 850);
    if (switching) finishSwitch();
    frameHold.painted(screen.querySelector('canvas'));
    scheduleProbe(fastConnect && !direct ? 0 : probeDelay);
    monitorDirect();
  });
  instance.addEventListener('disconnect', () => {
    if (rfb !== instance || stopping) return;
    frameReadiness?.(); frameReadiness = undefined;
    stopHealth(); viewing = false; connecting = false;
    pointerControls.update(canvas, false, preferences);
    if (switching && switchingFrom === instance) return;
    if (switching) finishSwitch();
    if (direct) { directFailed = true; routes.changed(); }
    if (direct && !directIssue) directIssue = 'connection';
    networkDetails = null; reportNetwork();
    if (channel && streamClient?.socket === channel) { streamClient.close(); streamClient = undefined; streamPaused = false; }
    direct?.close();
    probeController?.abort(); clearTimeout(probeTimer); probeTimer = null;
    status.hidden = false;
    status.textContent = '连接已断开，正在等待恢复。桌面任务继续运行。';
    announce('disconnected');
    clearTimeout(retry); retry = setTimeout(connect, direct ? 0 : 2500);
  });
  direct?.viewerReady();
  return instance;
}
async function connect() {
  if (stopping || connecting || document.hidden || !navigator.onLine || !/^[a-f0-9-]{16,64}$/.test(viewer || '')) return;
  if (streamEnabled && !streamCsrf) return;
  clearTimeout(retry); retry = undefined;
  rememberView(); stopHealth(); connecting = true;
  const epoch = ++connectionEpoch;
  transportName = ''; viewing = false;
  announce('connecting');
  status.hidden = false; status.textContent = '正在连接独立桌面…';
  if (streamEnabled) {
    streamClient?.close();
    streamClient = createStreamClient({ viewer, csrf: streamCsrf, bootstrap: () => rtcConfig && ({ ...rtcConfig, csrf: streamCsrf }), idle: idleForSwitch,
      settled: () => !pressedKeys.size && !pressedPointers.size && !pointerControls.busy && performance.now() - lastInteraction >= 800,
      prepare: prepareSwitch,
      paused: value => {
        streamPaused = value;
        if (value) { releaseMouse ||= !!lastMouse.buttons; if (rfb) rfb.viewOnly = true; }
        pointerControls.update(canvas, viewing && !value, preferences);
        // A failed path may swallow key-up. Release only held state after the
        // new writer is acknowledged; never replay a key press or clipboard.
        if (!value && rfb && streamClient?.socket.readyState === 1) {
          rfb.viewOnly = false;
          for (const [code, keysym] of [...remoteKeys]) rfb.sendKey(keysym, code, false);
          remoteKeys.clear();
          if (releaseMouse && canvas) canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window, button: 0, buttons: 0, clientX: lastMouse.x, clientY: lastMouse.y }));
          releaseMouse = false;
        }
        if (rfb) rfb.viewOnly = value || preferences.pan || preferences.blocked;
        parent.postMessage({ type: 'codex-stream-state', frame, paused: value }, location.origin);
      },
      changed: () => {
        transport = streamClient?.transport; transportName = streamClient?.socket.direct ? 'direct' : 'relay'; networkDetails = null;
        if (streamClient?.socket.direct) directIssue = '';
        if (viewing) { announce('connected'); reportControl(); reportNetwork(); void refreshNetwork(); }
      }, issue: directFailure });
    attachViewer(null, streamClient.socket); streamClient.start(); return;
  }
  frameHold.capture(canvas);
  const direct = fastConnect || directFailed ? null : await desktopTransport(viewer, reportControl, { failed: directFailure });
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
  reportView(); clearTimeout(idleTimer); idleTimer = setTimeout(reportView, 850);
}, true);
for (const name of ['mousedown', 'mouseup', 'mousemove']) window.addEventListener(name, event => {
  if (event.target === canvas) lastMouse = { x: event.clientX, y: event.clientY, buttons: event.buttons };
}, true);
window.addEventListener('blur', () => { pressedKeys.clear(); pressedPointers.clear(); lastInteraction = performance.now(); reportView(); clearTimeout(idleTimer); idleTimer = setTimeout(reportView, 850); });
function networkChanged() {
  if (streamClient) { streamClient.wake(); return; }
  if (document.hidden || !navigator.onLine) { stopHealth(); if (!switching) probeController?.abort(); clearTimeout(probeTimer); probeTimer = null; return; }
  // NetworkInformation also emits RTT/downlink estimate changes. Once a fresh
  // network check is running, further events must not keep canceling its deadline.
  if (viewing && transport && !healthNetworkCheck) { monitorDirect(250); healthNetworkCheck = true; }
  if (!viewing && !connecting) { clearTimeout(retry); retry = setTimeout(connect, 0); }
  probeDelay = 15000; clearTimeout(probeTimer); probeTimer = null; scheduleProbe(1000);
}
window.addEventListener('online', networkChanged);
window.addEventListener('offline', networkChanged);
document.addEventListener('visibilitychange', networkChanged);
navigator.connection?.addEventListener('change', networkChanged);
window.addEventListener('pagehide', () => {
  stopping = true;
  frameReadiness?.(); frameReadiness = undefined;
  frameHold.clear();
  streamClient?.close();
  pointerControls.update(canvas, false, preferences);
  stopHealth();
  scrollGesture = null;
  clearTimeout(idleTimer);
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
