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
    for (const name of ['top', 'left', 'width', 'max-height', '--history-panel-height', '--history-copy-top', '--history-copy-height']) entry.panel.style.removeProperty(name);
    moving = true;
    try { if (entry.marker.parentNode) entry.marker.parentNode.insertBefore(entry.panel, entry.marker.nextSibling); else entry.panel.remove(); }
    finally { moving = false; }
    entry.floating = false; notify(); focused?.focus({ preventScroll: true });
  }
  function reset() {
    cancelAnimationFrame(layoutFrame);
    entry?.panel.removeEventListener('pointerdown', focusField, true);
    entry?.panel.removeEventListener('focusin', focusField);
    entry?.panel.dispatchEvent(new Event('codex-history-reset'));
    restore(); entry?.marker.remove(); entry = undefined; composing(false);
  }
  function layout(focus = false) {
    if (!entry) return;
    if (!valid(entry.frame) || entry.marker.ownerDocument !== frame.contentDocument) return reset();
    if (!entry.floating) {
      const focused = entry.panel.contains(entry.panel.ownerDocument.activeElement) ? entry.panel.ownerDocument.activeElement : null;
      moving = true;
      try { container.append(entry.panel); } finally { moving = false; }
      entry.panel.classList.add('history-tools-floating'); entry.floating = true;
      entry.focus = focused || (!entry.mounted ? entry.panel : null);
      entry.mounted = true;
    }
    const visible = window.visualViewport;
    const copyHeight = Math.max(1, Math.min(520, (visible?.height || innerHeight) - 16));
    entry.panel.style.setProperty('--history-copy-height', `${copyHeight}px`);
    entry.panel.style.setProperty('--history-copy-top', `${Math.max(0, visible?.offsetTop || 0) + Math.max(8, ((visible?.height || innerHeight) - copyHeight) / 2)}px`);
    const frameBox = frame.getBoundingClientRect();
    const visibleTop = Math.max(0, visible?.offsetTop || 0), visibleBottom = visibleTop + (visible?.height || innerHeight);
    const boundary = Math.max(visibleTop + 44, Math.min(frameBox.top, visibleBottom));
    const height = Math.max(44, Math.min(180, Math.floor(boundary - visibleTop)));
    entry.panel.style.left = `${frameBox.left}px`; entry.panel.style.width = `${frameBox.width}px`;
    entry.panel.style.maxHeight = `${height}px`; entry.panel.style.setProperty('--history-panel-height', `${height}px`);
    entry.panel.classList.toggle('history-tools-short', height < 96);
    // Grow upward from the terminal's top edge. The existing history controls
    // and every terminal row stay in place below the attached drawer.
    entry.panel.style.top = `${boundary - entry.panel.getBoundingClientRect().height}px`;
    notify(); composing(entry.panel.dataset.composing === 'true');
    // Firefox ignores focus while adoption is still inside the iframe's click
    // handler. Use the same bounded layout callback after that event completes.
    if (entry.focus && focus) {
      const target = entry.focus; entry.focus = null;
      if (target.getClientRects().length && !entry.panel.contains(document.activeElement)) {
        window.focus();
        HTMLElement.prototype.focus.call(target, { preventScroll: true });
      }
    } else if (entry.focus) schedule();
  }
  function focusField(event) {
    if (!entry?.floating || !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    // Repair focus in the parent document's animation callback. An iframe
    // callback cannot reliably activate an adopted input's context in Firefox.
    entry.focus = event.target; schedule();
  }
  const onTools = event => {
    const detail = event.detail;
    if (moving || event.target !== frame || !detail || typeof detail.open !== 'boolean' || typeof detail.composing !== 'boolean' || !valid(detail.frame)) return;
    if (!detail.open) return reset();
    if (!entry) {
      const panel = frame.contentDocument?.getElementById('history-tools');
      if (!panel || panel.tagName !== 'SECTION') return;
      const marker = panel.ownerDocument.createComment('history tools'); panel.before(marker);
      entry = { panel, marker, frame: detail.frame, floating: false };
      panel.addEventListener('pointerdown', focusField, true); panel.addEventListener('focusin', focusField); opened();
    }
    if (detail.focus === true) entry.focus = entry.panel.querySelector('#history-query');
    composing(detail.composing); layout();
  };
  frame.addEventListener('codex-history-tools', onTools);
  const schedule = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(true); }); };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  document.addEventListener('fullscreenchange', schedule);
  const observer = new ResizeObserver(schedule); observer.observe(frame);
  return { reset, setFrame(next) {
    if (next === frame) return;
    reset(); frame.removeEventListener('codex-history-tools', onTools); observer.disconnect();
    frame = next; frame.addEventListener('codex-history-tools', onTools); observer.observe(frame);
  }, dismiss() { entry?.panel.querySelector('#history-tools-close').click(); }, get composing() { return entry?.panel.dataset.composing === 'true'; } };
}
