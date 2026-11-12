// Move controls, never the live iframe. Markers preserve the original compact
// layout and listeners; no reconnect or synthetic input is needed on resize.
export function createWorkspaceLayout({ workspace, sidebar, preference, changed }) {
  const wide = matchMedia('(min-width: 1200px)');
  const moves = [
    ['.topbar .brand', 'sidebar-brand'], ['.mode-switch', 'sidebar-mode'],
    ['#view-title', 'sidebar-title'], ['#terminal-session-bar', 'sidebar-terminals'],
    ['#toggle-controls-button', 'sidebar-actions'], ['#toggle-input-button', 'sidebar-actions'],
    ['#files-button', 'sidebar-actions'], ['#forward-button', 'sidebar-actions'],
    ['#connection-button', 'sidebar-actions'], ['#fullscreen-button', 'sidebar-actions'],
    ['#connection-status', 'sidebar-status'], ['#user-label', 'sidebar-user'],
    ['#logout-button', 'sidebar-logout'], ['.workspace-footer', 'sidebar-footer'],
  ].map(([selector, id]) => {
    const element = workspace.querySelector(selector), target = document.getElementById(id);
    const marker = document.createComment('workspace layout'); element.before(marker);
    return { element, target, marker };
  });
  function render() {
    const active = wide.matches && preference() === 'sidebar';
    if (workspace.dataset.workspaceLayout === (active ? 'sidebar' : 'top')) return;
    const focused = document.activeElement;
    workspace.dataset.workspaceLayout = active ? 'sidebar' : 'top'; workspace.classList.toggle('sidebar-layout', active); sidebar.hidden = !active;
    for (const { element, target, marker } of moves) {
      if (active) target.append(element); else marker.after(element);
    }
    document.getElementById('terminal-tabs').setAttribute('aria-orientation', active ? 'vertical' : 'horizontal');
    if (focused !== document.body && moves.some(({ element }) => element === focused || element.contains(focused))) focused.focus({ preventScroll: true });
    changed();
  }
  wide.addEventListener('change', render);
  return { render };
}

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
  let toolbar;
  const sidebar = container.querySelector('#sidebar-history');
  const sidebarActive = () => !!container.closest('.sidebar-layout');
  function restoreToolbar() {
    if (!toolbar) return;
    const focused = toolbar.element.contains(document.activeElement) ? document.activeElement : null;
    toolbar.marker.after(toolbar.element); toolbar.marker.remove(); toolbar = undefined;
    focused?.focus({ preventScroll: true });
  }
  function syncToolbar() {
    const source = frame.contentDocument;
    // Module initialization still needs these controls in the iframe. A poll
    // or resize may arrive before its load event, or during a new navigation.
    const current = source?.readyState === 'complete' && source.URL === frame.src && valid(new URL(source.URL).searchParams.get('frame'));
    if (!sidebarActive() || !current || toolbar && toolbar.source !== source) restoreToolbar();
    if (!sidebarActive() || !current || toolbar) return;
    const element = source.getElementById('terminal-tools');
    if (!element) return;
    const focused = source.activeElement;
    const marker = source.createComment('terminal toolbar'); element.before(marker);
    toolbar = { element, marker, source }; sidebar.append(element);
    if (element.contains(focused)) focused.focus({ preventScroll: true });
  }
  function notify() { entry?.panel.dispatchEvent(new Event('codex-history-layout')); }
  function restore() {
    if (!entry?.floating) return;
    const focused = entry.panel.contains(document.activeElement) ? document.activeElement : null;
    entry.panel.classList.remove('history-tools-floating', 'history-tools-short', 'history-tools-sidebar');
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
    if (!valid(entry.frame) || entry.source !== frame.contentDocument) return reset();
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
    entry.panel.classList.toggle('history-tools-sidebar', sidebarActive());
    if (sidebarActive()) {
      const top = Math.max(visibleTop + 8, frameBox.top + 8);
      const panelHeight = Math.max(44, Math.min(280, visibleBottom - top - 8));
      entry.panel.style.left = `${frameBox.left + 8}px`; entry.panel.style.width = `${Math.min(660, Math.max(1, frameBox.width - 16))}px`;
      entry.panel.style.top = `${top}px`; entry.panel.style.maxHeight = `${panelHeight}px`;
      entry.panel.style.setProperty('--history-panel-height', `${panelHeight}px`);
      entry.panel.classList.toggle('history-tools-short', panelHeight < 96);
    }
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
      const panel = (toolbar?.element || frame.contentDocument)?.querySelector('#history-tools');
      if (!panel || panel.tagName !== 'SECTION') return;
      const marker = panel.ownerDocument.createComment('history tools'); panel.before(marker);
      entry = { panel, marker, source: frame.contentDocument, frame: detail.frame, floating: false };
      panel.addEventListener('pointerdown', focusField, true); panel.addEventListener('focusin', focusField); opened();
    }
    if (detail.focus === true) entry.focus = entry.panel.querySelector('#history-query');
    composing(detail.composing); layout();
  };
  frame.addEventListener('codex-history-tools', onTools);
  const schedule = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(true); }); };
  const refreshLayout = () => { syncToolbar(); schedule(); };
  frame.addEventListener('load', refreshLayout);
  window.addEventListener('resize', refreshLayout);
  window.addEventListener('scroll', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  document.addEventListener('fullscreenchange', schedule);
  const observer = new ResizeObserver(schedule); observer.observe(frame);
  return { reset() { reset(); restoreToolbar(); }, layout: refreshLayout, setFrame(next) {
    if (next === frame) return;
    reset(); restoreToolbar(); frame.removeEventListener('codex-history-tools', onTools); frame.removeEventListener('load', refreshLayout); observer.disconnect();
    frame = next; frame.addEventListener('codex-history-tools', onTools); frame.addEventListener('load', refreshLayout); observer.observe(frame); refreshLayout();
  }, dismiss() { entry?.panel.querySelector('#history-tools-close').click(); }, get composing() { return entry?.panel.dataset.composing === 'true'; } };
}
