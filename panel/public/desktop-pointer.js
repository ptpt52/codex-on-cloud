import { releaseCapture } from './novnc/core/util/events.js';

// Relative touch input is translated into ordinary canvas mouse events. noVNC
// retains its normal RFB encoder and transport; no second input queue is used.
export function createDesktopPointer({ viewport, screen, cursor, controls, changed, chooseScroll }) {
  const $ = id => document.getElementById(id);
  let canvas, ready = false, options = { pointerMode: 'touch', scrollTarget: 'viewport', pan: false, blocked: true };
  let position, geometry = '', gesture = null, dragging = false, shown = false;
  const available = () => ready && canvas?.isConnected && !options.pan && !options.blocked && !document.hidden && navigator.onLine;
  const scale = () => canvas?.width ? canvas.getBoundingClientRect().width / canvas.width : 0;
  const clamp = (value, maximum) => Math.max(0, Math.min(maximum - 1, value));
  function locate() {
    const factor = scale();
    if (!factor) return false;
    if (!position) {
      const rect = canvas.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      position = { x: clamp((bounds.left + bounds.width / 2 - rect.left) / factor, canvas.width), y: clamp((bounds.top + bounds.height / 2 - rect.top) / factor, canvas.height) };
    }
    return true;
  }
  function renderCursor() {
    cursor.hidden = !available() || options.pointerMode !== 'trackpad' || !shown || !position;
    if (cursor.hidden) return;
    const rect = canvas.getBoundingClientRect(), factor = scale();
    cursor.style.left = `${rect.left + position.x * factor}px`;
    cursor.style.top = `${rect.top + position.y * factor}px`;
  }
  function render() {
    controls.hidden = !available();
    const trackpad = options.pointerMode === 'trackpad';
    for (const id of ['pointer-left', 'pointer-right', 'pointer-drag']) $(id).hidden = !trackpad;
    $('pointer-drag').setAttribute('aria-pressed', String(dragging));
    $('pointer-drag').textContent = dragging ? '结束拖动' : '拖动';
    $('pointer-scroll').textContent = options.scrollTarget === 'remote' ? '滚动程序' : '滚动画面';
    $('pointer-scroll').setAttribute('aria-label', options.scrollTarget === 'remote' ? '滚动目标：远程程序，点击切换到整张桌面画面' : '滚动目标：整张桌面画面，点击切换到远程程序');
    renderCursor();
  }
  function mouse(type, buttons = 0, button = 0) {
    if (!canvas?.isConnected || !locate()) return;
    const rect = canvas.getBoundingClientRect(), factor = scale();
    canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons, button,
      clientX: rect.left + position.x * factor, clientY: rect.top + position.y * factor }));
    // Our touch sequence owns capture. noVNC's mouse proxy must not obscure
    // touch controls while a synthetic drag is held.
    if (type === 'mousedown' || type === 'mouseup') releaseCapture();
  }
  function reset() {
    const wasBusy = dragging || !!gesture;
    if (dragging) mouse('mouseup');
    dragging = false; gesture = null; shown = false;
    render();
    // A connection handoff briefly blocks input. Merely hiding an idle cursor
    // must not turn that handoff into a new user interaction and veto itself.
    if (wasBusy) changed();
  }
  function click(button = 0) {
    if (!available() || !locate()) return;
    if (dragging) { reset(); return; }
    shown = true;
    mouse('mousedown', button === 2 ? 2 : 1, button);
    mouse('mouseup', 0, button);
    renderCursor();
  }
  function wheel(dx, dy) {
    if (options.scrollTarget === 'viewport') {
      viewport.scrollLeft += dx; viewport.scrollTop += dy;
    } else if (available() && locate()) {
      const rect = canvas.getBoundingClientRect(), factor = scale();
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy,
        clientX: rect.left + position.x * factor, clientY: rect.top + position.y * factor }));
    }
  }
  function follow() {
    const bounds = viewport.getBoundingClientRect(), rect = canvas.getBoundingClientRect(), factor = scale();
    const x = rect.left + position.x * factor, y = rect.top + position.y * factor;
    if (x < bounds.left + 24) viewport.scrollLeft -= bounds.left + 24 - x;
    if (x > bounds.right - 24) viewport.scrollLeft += x - bounds.right + 24;
    if (y < bounds.top + 24) viewport.scrollTop -= bounds.top + 24 - y;
    if (y > bounds.bottom - 68) viewport.scrollTop += y - bounds.bottom + 68;
  }
  const center = touches => ({ x: [...touches].reduce((sum, touch) => sum + touch.clientX, 0) / touches.length,
    y: [...touches].reduce((sum, touch) => sum + touch.clientY, 0) / touches.length });
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) viewport.addEventListener(type, event => {
    if (options.pointerMode !== 'trackpad' && !gesture) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!available() || type === 'touchcancel' || event.touches.length > 2) { reset(); return; }
    const count = event.touches.length;
    if (type === 'touchstart') {
      if (!locate()) return;
      const point = center(event.touches);
      if (!gesture) gesture = { start: performance.now(), max: count, count, last: point, distance: 0, cancelled: false };
      else { gesture.max = Math.max(gesture.max, count); gesture.count = count; gesture.last = point; }
      canvas.focus({ preventScroll: true }); shown = true; renderCursor(); changed();
    } else if (type === 'touchmove' && gesture && count && !gesture.cancelled) {
      const point = center(event.touches), dx = point.x - gesture.last.x, dy = point.y - gesture.last.y;
      gesture.distance += Math.hypot(dx, dy); gesture.last = point;
      if (gesture.max === 2 && count === 2) {
        if (dragging) reset(); else wheel(-dx, -dy);
      } else if (gesture.max === 1) {
        const factor = scale();
        if (!factor) return;
        position.x = clamp(position.x + dx / factor, canvas.width);
        position.y = clamp(position.y + dy / factor, canvas.height);
        follow(); mouse('mousemove', dragging ? 1 : 0); renderCursor();
      }
    } else if (type === 'touchend' && gesture) {
      if (count) { gesture.cancelled = true; return; }
      const finished = gesture; gesture = null;
      if (!dragging && finished.distance < 8 && performance.now() - finished.start < 500) click(finished.max === 2 ? 2 : 0);
      changed();
    }
  }, { capture: true, passive: false });
  $('pointer-left').addEventListener('click', () => click());
  $('pointer-right').addEventListener('click', () => click(2));
  $('pointer-drag').addEventListener('click', () => {
    if (!available() || !locate()) return;
    if (dragging) reset();
    else { dragging = true; shown = true; mouse('mousedown', 1); render(); changed(); }
  });
  $('pointer-scroll').addEventListener('click', () => {
    reset(); chooseScroll(options.scrollTarget === 'viewport' ? 'remote' : 'viewport');
  });
  viewport.addEventListener('scroll', renderCursor);
  screen.addEventListener('mousemove', event => { if (event.isTrusted && shown) { shown = false; renderCursor(); } }, true);
  window.addEventListener('blur', reset);
  window.addEventListener('pagehide', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  window.addEventListener('offline', reset);
  return {
    reset,
    update(nextCanvas, nextReady, nextOptions) {
      const nextGeometry = `${nextCanvas?.width}:${nextCanvas?.height}`;
      if (canvas !== nextCanvas || geometry !== nextGeometry || ready !== nextReady || ['pointerMode', 'scrollTarget', 'pan', 'blocked'].some(key => options[key] !== nextOptions[key])) reset();
      if (canvas !== nextCanvas || geometry !== nextGeometry) position = undefined;
      geometry = nextGeometry;
      canvas = nextCanvas; ready = nextReady; options = { ...nextOptions };
      render();
    },
    get busy() { return !!gesture || dragging; },
  };
}
