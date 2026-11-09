export function createTerminalTabs({ bar, tabs, mobileButton, mobileClose, dialog, list, choose, closeTerminal, manage, changed }) {
  let signature = '', currentTerminal;
  let layoutFrame = 0;
  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      const focused = document.activeElement;
      // Measure with the entire bar available to the tabs, even when the
      // previous layout used the picker. Both changes happen before paint.
      bar.dataset.overflow = 'false';
      bar.dataset.overflow = String(tabs.getClientRects().length > 0 && tabs.scrollWidth > tabs.clientWidth + 1);
      if (tabs.contains(focused) && !tabs.getClientRects().length) mobileButton.focus({ preventScroll: true });
      else if (focused === mobileButton || focused === mobileClose) {
        const target = focused.getClientRects().length ? focused
          : focused === mobileClose ? tabs.querySelector('[aria-selected=true] + [data-terminal-close]')
          : tabs.querySelector('[tabindex="0"]');
        target?.focus({ preventScroll: true });
      }
    });
  }
  new ResizeObserver(scheduleLayout).observe(bar);
  const narrow = matchMedia('(max-width: 420px)');
  let fullLabel = '选择终端', shortLabel = fullLabel;
  const label = () => { mobileButton.textContent = `${narrow.matches ? shortLabel : fullLabel} ▾`; mobileButton.setAttribute('aria-label', fullLabel + ' ▾'); };
  narrow.addEventListener('change', label);
  function render(catalog, selected, { visible, disabled, invalid, loading }) {
    bar.hidden = !visible;
    mobileButton.disabled = disabled;
    const current = catalog.find(item => item.id === selected);
    scheduleLayout();
    currentTerminal = !invalid && current?.supported && !current.available ? current : null;
    mobileClose.hidden = !currentTerminal;
    mobileClose.disabled = disabled || !currentTerminal;
    mobileClose.title = mobileClose.ariaLabel = currentTerminal ? `结束 ${currentTerminal.name}` : '结束当前终端';
    bar.dataset.closable = String(!!currentTerminal);
    fullLabel = invalid ? '原终端已失效 · 选择终端' : loading ? '正在核对终端…' : current?.name || '选择终端';
    shortLabel = invalid ? '选择终端' : loading ? '核对中…' : current?.id === 'main' && current.name === 'Codex 主终端' ? '主终端' : fullLabel;
    label();
    mobileButton.title = current?.name || '选择终端';
    const next = JSON.stringify({ catalog, selected, disabled, invalid });
    if (signature === next) return;
    signature = next;
    const focused = tabs.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.terminalChoice, focusedClose = focused?.dataset.terminalClose;
    tabs.replaceChildren(); list.replaceChildren();
    for (const terminal of catalog) {
      const active = terminal.id === selected && !invalid;
      for (const [parent, compact] of [[tabs, true], [list, false]]) {
        const row = document.createElement('div'); row.className = compact ? 'terminal-tab-item' : 'terminal-choice-row'; row.dataset.available = String(!!terminal.available);
        if (compact) row.setAttribute('role', 'presentation');
        const button = document.createElement('button'); button.type = 'button'; button.className = compact ? 'terminal-tab view-button' : 'terminal-choice';
        button.dataset.terminalChoice = terminal.id; button.dataset.available = String(!!terminal.available);
        button.title = terminal.available && !terminal.supported ? '终端数量已达上限，请先结束不用的终端' : terminal.name;
        button.disabled = disabled || !terminal.supported;
        button.textContent = terminal.available ? '＋ 新开终端' : terminal.name;
        if (compact) { button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
        else {
          button.setAttribute('aria-pressed', String(active));
          const note = document.createElement('small'); note.textContent = terminal.available ? terminal.supported ? '点击创建新的 shell' : '已达到终端数量上限' : !terminal.supported ? '当前布局不可用' : active ? '当前查看和输入目标' : terminal.command || '已有终端'; button.append(note);
        }
        button.addEventListener('click', () => { if (choose(terminal.id)) dialog.close(); });
        row.append(button);
        if (!terminal.available) {
          // Sibling buttons: closing a tab never activates its terminal or
          // bubbles through a nested interactive element.
          const close = document.createElement('button'); close.type = 'button'; close.className = 'terminal-tab-close';
          close.dataset.terminalClose = terminal.id; close.textContent = '×'; close.title = `结束 ${terminal.name}`;
          close.setAttribute('aria-label', close.title); close.disabled = disabled || !terminal.supported;
          close.addEventListener('click', event => { event.stopPropagation(); closeTerminal(terminal); });
          row.append(close);
        }
        parent.append(row);
      }
    }
    if (!tabs.querySelector('[tabindex="0"]')) tabs.querySelector('button:not(:disabled)')?.setAttribute('tabindex', '0');
    if (focusedId || focusedClose) {
      const replacement = [...tabs.querySelectorAll('button')].find(button => focusedId ? button.dataset.terminalChoice === focusedId : button.dataset.terminalClose === focusedClose);
      if (replacement && !replacement.disabled && replacement.getClientRects().length) replacement.focus({ preventScroll: true });
    }
  }
  tabs.addEventListener('keydown', event => {
    if (!event.target.matches('[data-terminal-choice]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tabs.querySelectorAll('[data-terminal-choice]:not(:disabled)')]; if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  mobileButton.addEventListener('click', () => { dialog.showModal(); changed(); });
  mobileClose.addEventListener('click', () => { if (currentTerminal) closeTerminal(currentTerminal); });
  document.getElementById('close-terminal-switch').addEventListener('click', () => dialog.close());
  document.getElementById('terminal-switch-manage').addEventListener('click', () => { dialog.close(); manage(); });
  return { render };
}
