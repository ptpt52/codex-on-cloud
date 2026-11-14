// Touch controls live beside the IME field so a button can focus it within the
// original user gesture. Keys share the existing bounded desktop input queue.
export function createDesktopTouchInput({ input, field, root, allowed, action }) {
  const toggle = root.querySelector('#desktop-touch-keyboard'), panel = root.querySelector('#desktop-touch-panel');
  const more = root.querySelector('#desktop-touch-more'), menu = root.querySelector('#desktop-touch-menu');
  const coarse = matchMedia('(any-pointer: coarse)');
  const host = parent === window ? window : parent, frame = window.frameElement;
  let layoutFrame = 0, destroyed = false;
  const touchDevice = () => coarse.matches || navigator.maxTouchPoints > 0;
  function layout() {
    layoutFrame = 0;
    if (destroyed || root.hidden) return;
    const visible = host.visualViewport, box = frame?.getBoundingClientRect() || { left: 0, top: 0 };
    const left = Math.max(0, (visible?.offsetLeft || 0) - box.left) + 8;
    const right = Math.min(innerWidth, (visible?.offsetLeft || 0) + (visible?.width || host.innerWidth) - box.left) - 8;
    const top = Math.max(0, (visible?.offsetTop || 0) - box.top) + 8;
    const bottom = Math.min(innerHeight, (visible?.offsetTop || 0) + (visible?.height || host.innerHeight) - box.top) - 8;
    const width = Math.max(0, Math.min(540, right - left)), height = Math.max(44, bottom - top);
    root.style.width = `${width}px`; root.style.left = `${Math.max(left, right - width)}px`;
    root.style.maxHeight = `${height}px`;
    root.classList.toggle('compact', width < 520); root.classList.toggle('short', height < 150);
    root.style.top = `${Math.max(top, bottom - root.getBoundingClientRect().height)}px`;
    document.documentElement.style.setProperty('--desktop-touch-inset', `${Math.max(0, innerHeight - bottom)}px`);
    document.documentElement.style.setProperty('--desktop-touch-height', `${root.getBoundingClientRect().height}px`);
    if (input.touch && !input.composing) {
      field.style.left = root.style.left; field.style.top = `${Math.max(top, parseFloat(root.style.top) - 32)}px`;
    }
  }
  function schedule() { if (!destroyed) { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layout); } }
  function update() {
    const available = touchDevice() && allowed();
    if (!available && input.touch) input.closeTouch();
    root.hidden = !available;
    panel.hidden = !input.touch; toggle.hidden = input.touch;
    toggle.setAttribute('aria-expanded', String(input.touch));
    document.documentElement.classList.toggle('desktop-touch-typing', input.touch);
    if (!input.touch) { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
    for (const button of root.querySelectorAll('[data-touch-key], [data-touch-action]')) {
      button.disabled = input.composing || button.hasAttribute('data-touch-action') && input.busy;
    }
    schedule();
  }
  toggle.addEventListener('click', () => { if (allowed() && input.openTouch()) update(); });
  root.querySelector('#desktop-touch-close').addEventListener('click', () => { input.closeTouch(); update(); });
  // Keep the soft keyboard open while using keys or expanding the menu.
  root.addEventListener('pointerdown', event => { if (input.touch && event.target.closest('button')) event.preventDefault(); });
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-touch-key], [data-touch-action]');
    if (!button || button.disabled || !allowed() || !input.touch) return;
    if (button.dataset.touchKey) input.press(button.dataset.touchKey);
    else if (!input.busy && !input.composing) {
      input.closeTouch(); update(); action(button.dataset.touchAction);
    }
  });
  more.addEventListener('click', () => {
    menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); schedule();
  });
  const observer = new ResizeObserver(schedule); observer.observe(root); if (frame) observer.observe(frame);
  coarse.addEventListener('change', update);
  host.addEventListener('resize', schedule); host.addEventListener('scroll', schedule, { passive: true });
  host.visualViewport?.addEventListener('resize', schedule); host.visualViewport?.addEventListener('scroll', schedule);
  host.document.addEventListener('fullscreenchange', schedule);
  function destroy() {
    destroyed = true; cancelAnimationFrame(layoutFrame); observer.disconnect();
    coarse.removeEventListener('change', update);
    host.removeEventListener('resize', schedule); host.removeEventListener('scroll', schedule);
    host.visualViewport?.removeEventListener('resize', schedule); host.visualViewport?.removeEventListener('scroll', schedule);
    host.document.removeEventListener('fullscreenchange', schedule);
  }
  window.addEventListener('pagehide', destroy, { once: true });
  update();
  return { update, destroy };
}
