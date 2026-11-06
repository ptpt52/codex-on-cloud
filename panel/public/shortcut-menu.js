import { SHORTCUTS, SHORTCUT_BY_KEY } from './shortcuts.js';

export function createShortcutMenu({ button, menu, list, canSend, send, changed, available = () => true }) {
  let open = false, layout = 0;
  const native = typeof menu.showPopover === 'function';
  if (!native) menu.removeAttribute('popover');
  let group;
  for (const shortcut of SHORTCUTS) {
    if (group?.getAttribute('aria-label') !== shortcut.group) {
      group = document.createElement('div'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', shortcut.group);
      const title = document.createElement('p'); title.className = 'shortcuts-group-title'; title.textContent = shortcut.group;
      group.append(title); list.append(group);
    }
    const item = document.createElement('button'); item.type = 'button'; item.className = 'shortcut-option'; item.tabIndex = -1;
    item.setAttribute('role', 'menuitem'); item.setAttribute('aria-label', `${shortcut.key} · ${shortcut.label}`);
    item.dataset.shortcut = shortcut.key; item.dataset.confirm = String(shortcut.confirm === true); item.title = shortcut.description;
    const label = document.createElement('span'), keys = document.createElement('kbd');
    label.textContent = shortcut.label; keys.textContent = shortcut.key === 'Escape Escape' ? 'Esc → Esc' : shortcut.key;
    item.append(label, keys); group.append(item);
  }
  function close(restoreFocus = false) {
    if (!open && menu.hidden) return;
    open = false;
    cancelAnimationFrame(layout);
    if (native && menu.matches(':popover-open')) menu.hidePopover();
    menu.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !button.disabled) button.focus({ preventScroll: true });
    changed();
  }
  function position() {
    if (!open) return;
    cancelAnimationFrame(layout);
    layout = requestAnimationFrame(() => {
      if (!open) return;
      const rect = button.getBoundingClientRect(), view = window.visualViewport;
      const top = (view?.offsetTop || 0) + 12, left = (view?.offsetLeft || 0) + 12;
      const height = Math.max(100, (view?.height || window.innerHeight) - 24), width = Math.max(100, (view?.width || window.innerWidth) - 24);
      menu.style.width = `${Math.min(370, width)}px`; menu.style.maxHeight = `${Math.min(520, height)}px`;
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(left, Math.min(rect.left, left + width - box.width))}px`;
      menu.style.top = `${Math.max(top, Math.min(rect.bottom + 6 + box.height <= top + height ? rect.bottom + 6 : rect.top - box.height - 6, top + height - box.height))}px`;
    });
  }
  button.addEventListener('click', () => {
    if (open) { close(true); return; }
    if (button.disabled || !canSend()) return;
    for (const item of list.querySelectorAll('[data-shortcut]')) item.hidden = !available(item.dataset.shortcut);
    for (const group of list.querySelectorAll('[role="group"]')) group.hidden = ![...group.querySelectorAll('[data-shortcut]')].some(item => !item.hidden);
    open = true; menu.hidden = false; button.setAttribute('aria-expanded', 'true');
    if (native) menu.showPopover();
    menu.focus({ preventScroll: true }); position(); changed();
  });
  menu.addEventListener('toggle', event => { if (event.newState === 'closed' && open) close(); });
  menu.addEventListener('click', event => {
    const item = event.target.closest('[data-shortcut]');
    if (!open || !item || !list.contains(item) || item.disabled || !canSend() || !SHORTCUT_BY_KEY.has(item.dataset.shortcut) || !available(item.dataset.shortcut)) return;
    const key = item.dataset.shortcut;
    close(); send(key);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } close(true); return; }
    if (event.target === menu && ['Enter', ' '].includes(event.key)) { event.preventDefault(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...list.querySelectorAll('[data-shortcut]:not(:disabled)')].filter(item => available(item.dataset.shortcut)), index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index + items.length - 1) % items.length);
    items[next]?.focus();
  });
  document.addEventListener('pointerdown', event => { if (open && !menu.contains(event.target) && !button.contains(event.target)) close(); }, true);
  window.addEventListener('resize', position); window.visualViewport?.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  window.addEventListener('blur', () => close());
  window.addEventListener('pagehide', () => close());
  return { close, get open() { return open; } };
}
