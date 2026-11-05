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
