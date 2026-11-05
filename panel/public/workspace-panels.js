// The two panels share one visible slot. They never change a desktop process.
export function createWorkspacePanels({ tools, input, toolsButton, inputButton, close }) {
  let active = '';
  let viewportFrame = 0;
  const entries = { tools: toolsButton, input: inputButton };
  const panels = { tools, input };
  function render(next) {
    const previous = active;
    const restoreFocus = previous && previous !== next && panels[previous].contains(document.activeElement);
    active = next;
    for (const name of ['tools', 'input']) {
      panels[name].hidden = name !== active;
      entries[name].setAttribute('aria-expanded', String(name === active));
      entries[name].setAttribute('aria-pressed', String(name === active));
    }
    // Do not leave keyboard focus in a newly hidden panel.
    if (restoreFocus) entries[previous].focus({ preventScroll: true });
  }
  function focus() {
    if (active) panels[active].focus({ preventScroll: true });
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !active || document.querySelector('dialog[open], #shortcuts-button[aria-expanded="true"]')) return;
    event.preventDefault(); event.stopPropagation(); close(active);
  });
  function viewportChanged() {
    const visible = window.visualViewport;
    const height = Math.max(1, Math.min(20000, visible?.height ?? innerHeight));
    const bottom = Math.max(0, Math.min(20000, innerHeight - height - (visible?.offsetTop ?? 0)));
    document.documentElement.style.setProperty('--workspace-visible-height', `${height}px`);
    document.documentElement.style.setProperty('--workspace-keyboard-inset', `${bottom}px`);
    document.documentElement.classList.toggle('workspace-keyboard-open', bottom > 100);
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      if (active !== 'input') return;
      const body = input.querySelector('.assistant-body'), focused = document.activeElement;
      if (!body?.contains(focused)) return;
      const bounds = body.getBoundingClientRect(), rect = focused.getBoundingClientRect();
      if (rect.bottom > bounds.bottom) body.scrollTop += rect.bottom - bounds.bottom;
      else if (rect.top < bounds.top) body.scrollTop -= bounds.top - rect.top;
    });
  }
  window.addEventListener('resize', viewportChanged);
  window.visualViewport?.addEventListener('resize', viewportChanged);
  window.visualViewport?.addEventListener('scroll', viewportChanged);
  viewportChanged();
  return { render, focus, get active() { return active; } };
}

// One same-origin DOM panel and one placeholder. Adoption keeps the terminal's
// search/selection handlers local; no terminal text is copied into messages.
export function createHistoryToolsPortal({ frame, container, valid, opened, composing }) {
  let entry, layoutFrame = 0, moving = false;
  function notify() { entry?.panel.dispatchEvent(new Event('codex-history-layout')); }
  function restore() {
    if (!entry?.floating) return;
    const focused = entry.panel.contains(document.activeElement) ? document.activeElement : null;
    entry.panel.classList.remove('history-tools-floating', 'history-tools-short');
    for (const name of ['top', 'max-height', '--history-panel-height']) entry.panel.style.removeProperty(name);
    moving = true;
    try { if (entry.marker.parentNode) entry.marker.parentNode.insertBefore(entry.panel, entry.marker.nextSibling); else entry.panel.remove(); }
    finally { moving = false; }
    entry.floating = false; notify(); focused?.focus({ preventScroll: true });
  }
  function reset() {
    cancelAnimationFrame(layoutFrame);
    restore(); entry?.marker.remove(); entry = undefined; composing(false);
  }
  function layout() {
    if (!entry) return;
    if (!valid(entry.frame) || entry.marker.ownerDocument !== frame.contentDocument) return reset();
    if (!entry.floating) {
      const focused = entry.panel.contains(entry.panel.ownerDocument.activeElement) ? entry.panel.ownerDocument.activeElement : null;
      moving = true;
      try { container.append(entry.panel); } finally { moving = false; }
      entry.panel.classList.add('history-tools-floating'); entry.floating = true;
      if (focused) focused.focus({ preventScroll: true });
      else if (!entry.mounted) entry.panel.focus({ preventScroll: true });
      entry.mounted = true;
    }
    const visible = window.visualViewport;
    const boundary = frame.getBoundingClientRect().top + (frame.contentDocument.getElementById('history-up')?.getBoundingClientRect().top || 0);
    entry.panel.style.top = `calc(${Math.max(0, visible?.offsetTop || 0)}px + max(4px, env(safe-area-inset-top)))`;
    let top = entry.panel.getBoundingClientRect().top;
    if (top > boundary - 48) { top = Math.max(0, boundary - 48); entry.panel.style.top = `${top}px`; }
    const room = boundary - top, height = Math.max(44, Math.min(20000, Math.floor(room - (room >= 52 ? 4 : 0)), Math.floor((visible?.height || innerHeight) - 4)));
    entry.panel.style.maxHeight = `${height}px`; entry.panel.style.setProperty('--history-panel-height', `${height}px`);
    entry.panel.classList.toggle('history-tools-short', height < 96);
    notify(); composing(entry.panel.dataset.composing === 'true');
  }
  frame.addEventListener('codex-history-tools', event => {
    const detail = event.detail;
    if (moving || event.target !== frame || !detail || typeof detail.open !== 'boolean' || typeof detail.composing !== 'boolean' || !valid(detail.frame)) return;
    if (!detail.open) return reset();
    if (!entry) {
      const panel = frame.contentDocument?.getElementById('history-tools');
      if (!panel || panel.tagName !== 'SECTION') return;
      const marker = panel.ownerDocument.createComment('history tools'); panel.before(marker);
      entry = { panel, marker, frame: detail.frame, floating: false }; opened();
    }
    composing(detail.composing); layout();
  });
  const schedule = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layout); };
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  document.addEventListener('fullscreenchange', schedule);
  new ResizeObserver(schedule).observe(frame);
  return { reset, dismiss() { entry?.panel.querySelector('#history-tools-close').click(); }, get composing() { return entry?.panel.dataset.composing === 'true'; } };
}
