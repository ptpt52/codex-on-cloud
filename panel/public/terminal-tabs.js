export function createTerminalTabs({ bar, tabs, mobileButton, mobileClose, dialog, list, choose, closeTerminal, manage, changed }) {
  let signature = '', currentTerminal;
  let layoutFrame = 0, overflowCount = 0, currentOverflow = false, dialogMode = 'all', pickerDialog = false, focusedControl;
  const compact = matchMedia('(max-width: 1000px)');
  const shown = element => !!element?.getClientRects().length;
  document.addEventListener('focusin', event => { focusedControl = bar.contains(event.target) ? event.target : null; });
  function filterList() {
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    [...list.children].forEach((row, index) => { row.hidden = dialogMode === 'overflow' && !tabs.children[index]?.hidden; });
    document.getElementById('terminal-switch-title').textContent = dialogMode === 'overflow' ? '更多终端' : '选择终端';
    if (dialog.open && focused && !shown(focused)) {
      const first = [...list.querySelectorAll('[data-terminal-choice]:not(:disabled)')].find(shown);
      (first || document.getElementById('close-terminal-switch')).focus({ preventScroll: true });
    }
  }
  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      // Media queries can hide the focused mobile control before the resize
      // observer runs. Keep that control until focus moves somewhere else.
      const focused = document.activeElement === document.body && focusedControl ? focusedControl : document.activeElement;
      const rows = [...tabs.children];
      // First measure the full list. Only reserve picker space when needed,
      // then keep the longest prefix that fits at the tabs' minimum widths.
      rows.forEach(row => { row.hidden = false; });
      bar.dataset.overflow = 'false';
      overflowCount = 0;
      if (!compact.matches && shown(tabs) && tabs.scrollWidth > tabs.clientWidth + 1) {
        bar.dataset.overflow = 'true';
        const available = tabs.clientWidth, gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
        let used = 0, fits = true;
        for (const [index, row] of rows.entries()) {
          const width = row.dataset.available === 'true' ? row.getBoundingClientRect().width : parseFloat(getComputedStyle(row).minWidth);
          used += width + (index ? gap : 0);
          fits &&= used <= available + 1;
          row.hidden = !fits;
          if (row.hidden) overflowCount++;
        }
      }
      currentOverflow = rows.some(row => row.hidden && row.querySelector('[aria-selected=true]'));
      label();
      const buttons = [...tabs.querySelectorAll('[data-terminal-choice]')];
      buttons.forEach(button => { button.tabIndex = shown(button) && button.getAttribute('aria-selected') === 'true' ? 0 : -1; });
      const first = buttons.find(button => shown(button) && !button.disabled);
      if (!buttons.some(button => button.tabIndex === 0) && first) first.tabIndex = 0;
      if (dialog.open && pickerDialog) {
        if (compact.matches) dialogMode = 'all';
        else if (overflowCount) dialogMode = 'overflow';
        else dialog.close();
      }
      filterList();
      if (bar.contains(focused) && !dialog.open) {
        let target = focused;
        if (!shown(target)) {
          const active = buttons.find(button => shown(button) && button.getAttribute('aria-selected') === 'true');
          target = compact.matches || tabs.contains(focused) ? mobileButton
            : focused === mobileClose ? active?.nextElementSibling : active || first;
          if (!shown(target)) target = shown(mobileButton) ? mobileButton : first;
        }
        if (target && !target.disabled && document.activeElement !== target) target.focus({ preventScroll: true });
      }
    });
  }
  new ResizeObserver(scheduleLayout).observe(bar);
  compact.addEventListener('change', scheduleLayout);
  const narrow = matchMedia('(max-width: 420px)');
  const pickerLabel = document.createElement('span'), pickerArrow = document.createElement('span');
  pickerArrow.textContent = ' ▾'; pickerArrow.setAttribute('aria-hidden', 'true');
  mobileButton.replaceChildren(pickerLabel, pickerArrow);
  let fullLabel = '选择终端', shortLabel = fullLabel;
  const label = () => {
    const more = !compact.matches && overflowCount > 0;
    pickerLabel.textContent = more && !currentOverflow ? `更多终端 (${overflowCount})` : narrow.matches ? shortLabel : fullLabel;
    mobileButton.setAttribute('aria-label', (more ? `更多终端（${overflowCount} 项）${currentOverflow ? `，当前：${fullLabel}` : ''}` : fullLabel) + ' ▾');
    mobileButton.title = more ? currentOverflow ? `更多终端 · 当前：${fullLabel}` : '更多终端' : fullLabel;
    mobileButton.dataset.active = String(more && currentOverflow);
  };
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
    const buttons = [...tabs.querySelectorAll('[data-terminal-choice]:not(:disabled)')].filter(shown); if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  mobileButton.addEventListener('click', () => { pickerDialog = true; dialogMode = compact.matches ? 'all' : 'overflow'; filterList(); dialog.showModal(); changed(); });
  dialog.addEventListener('close', () => {
    pickerDialog = false; dialogMode = 'all'; filterList();
    if (!shown(mobileButton) && document.activeElement === document.body) tabs.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  });
  mobileClose.addEventListener('click', () => { if (currentTerminal) closeTerminal(currentTerminal); });
  document.getElementById('close-terminal-switch').addEventListener('click', () => dialog.close());
  document.getElementById('terminal-switch-manage').addEventListener('click', () => { dialog.close(); manage(); });
  return { render };
}
