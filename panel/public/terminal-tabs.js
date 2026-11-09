export function createTerminalTabs({ bar, tabs, mobileButton, mobileActions, dialog, list, choose, openActions, manage, changed }) {
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
            : focused === mobileActions ? active?.nextElementSibling : active || first;
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
    mobileActions.hidden = !currentTerminal;
    mobileActions.disabled = disabled || !currentTerminal;
    mobileActions.title = mobileActions.ariaLabel = currentTerminal ? `操作 ${currentTerminal.name}` : '当前终端操作';
    bar.dataset.closable = String(!!currentTerminal);
    fullLabel = invalid ? '原终端已失效 · 选择终端' : loading ? '正在核对终端…' : current?.name || '选择终端';
    shortLabel = invalid ? '选择终端' : loading ? '核对中…' : current?.id === 'main' && current.name === 'Codex 主终端' ? '主终端' : fullLabel;
    label();
    const next = JSON.stringify({ catalog, selected, disabled, invalid });
    if (signature === next) return;
    signature = next;
    const focused = tabs.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.terminalChoice, focusedActions = focused?.dataset.terminalActions;
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
          const actions = document.createElement('button'); actions.type = 'button'; actions.className = 'terminal-tab-actions';
          actions.dataset.terminalActions = terminal.id; actions.textContent = '⋯'; actions.title = `操作 ${terminal.name}`;
          actions.setAttribute('aria-label', actions.title); actions.setAttribute('aria-haspopup', 'dialog'); actions.setAttribute('aria-controls', 'terminal-action-menu');
          actions.disabled = disabled || !terminal.supported;
          actions.addEventListener('click', event => { event.stopPropagation(); if (!actions.disabled) openActions(terminal, actions); });
          row.addEventListener('contextmenu', event => {
            if (actions.disabled || event.pointerType === 'touch') return;
            event.preventDefault(); openActions(terminal, actions);
          });
          row.addEventListener('keydown', event => {
            if (!actions.disabled && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
              event.preventDefault(); event.stopPropagation(); openActions(terminal, actions);
            }
          });
          row.append(actions);
        }
        parent.append(row);
      }
    }
    if (!tabs.querySelector('[tabindex="0"]')) tabs.querySelector('button:not(:disabled)')?.setAttribute('tabindex', '0');
    if (focusedId || focusedActions) {
      const replacement = [...tabs.querySelectorAll('button')].find(button => focusedId ? button.dataset.terminalChoice === focusedId : button.dataset.terminalActions === focusedActions);
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
  mobileActions.addEventListener('click', () => { if (currentTerminal && !mobileActions.disabled) openActions(currentTerminal, mobileActions); });
  document.getElementById('close-terminal-switch').addEventListener('click', () => dialog.close());
  document.getElementById('terminal-switch-manage').addEventListener('click', () => { dialog.close(); manage(); });
  return { render };
}

export function createTerminalActions({ renameTerminal, closeTerminal, changed }) {
  const $ = id => document.getElementById(id);
  const menu = $('terminal-action-menu'), rename = $('terminal-rename-dialog'), field = $('terminal-rename-name');
  const status = $('terminal-rename-status'), save = $('terminal-rename-save'), cancel = $('terminal-rename-cancel');
  let catalog = [], disabled = true, visible = false, menuTarget, renameTarget, invoker;
  let saving = false, composing = false, uncertain = false, failure = '', generation = 0;
  const shown = element => !!element?.getClientRects().length;
  const current = target => target && catalog.find(item => item.id === target.id && item.token === target.token && item.supported && !item.available);
  function restore(target) {
    if (document.querySelector('dialog[open]:not(#terminal-switch-dialog)')) return;
    const replacement = [...document.querySelectorAll('[data-terminal-actions]')].find(button => button.dataset.terminalActions === target?.id && shown(button) && !button.disabled);
    const picker = $('terminal-session-button');
    const button = invoker?.isConnected && shown(invoker) && !invoker.disabled ? invoker : replacement || (shown(picker) && !picker.disabled ? picker : null);
    button?.focus({ preventScroll: true });
  }
  function updateRename() {
    const value = field.value.trim();
    const invalidName = !value ? '名称不能为空。' : [...value].length > 24 || /[\x00-\x1f\x7f]/.test(value) ? '名称需为 1–24 个字符，不含控制字符。' : '';
    field.disabled = cancel.disabled = saving;
    save.disabled = saving || composing || disabled || uncertain || !current(renameTarget) || !!invalidName;
    if (!saving) status.textContent = uncertain ? failure : !current(renameTarget) ? '终端已变化，请取消后重新选择。' : failure || invalidName || (disabled ? '当前暂时无法修改，请检查连接后手动保存。' : '');
  }
  function close() { if (menu.open) menu.close(); if (rename.open) rename.close(); }
  function open(target, anchor) {
    const terminal = current(target);
    if (disabled || !visible || !terminal || rename.open) return;
    menuTarget = { ...terminal }; invoker = anchor;
    $('terminal-action-title').textContent = terminal.name;
    const box = anchor.getBoundingClientRect(), view = window.visualViewport;
    const left = (view?.offsetLeft || 0) + 8, top = (view?.offsetTop || 0) + 8;
    const width = (view?.width || innerWidth) - 16, height = (view?.height || innerHeight) - 16;
    menu.style.width = `${Math.min(280, width)}px`; menu.style.maxHeight = `${height}px`;
    if (!menu.open) menu.showModal();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left, Math.min(box.right - rect.width, left + width - rect.width))}px`;
    menu.style.top = `${Math.max(top, Math.min(box.bottom + 6, top + height - rect.height))}px`;
    $('terminal-action-rename').focus({ preventScroll: true }); changed();
  }
  $('terminal-action-dismiss').addEventListener('click', () => menu.close());
  menu.addEventListener('click', event => {
    const box = menu.getBoundingClientRect();
    if (event.target === menu && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) menu.close();
  });
  menu.addEventListener('keydown', event => {
    event.stopPropagation();
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [$('terminal-action-rename'), $('terminal-action-end')];
    const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + 2) % 2].focus();
  });
  menu.addEventListener('close', () => { if (!menu.open) { const target = menuTarget; menuTarget = null; restore(target); } changed(); });
  $('terminal-action-end').addEventListener('click', () => {
    const target = current(menuTarget);
    if (disabled || !target) return;
    menu.close(); closeTerminal(target);
  });
  $('terminal-action-rename').addEventListener('click', () => {
    const target = current(menuTarget);
    if (disabled || !target) return;
    renameTarget = { ...target }; saving = composing = uncertain = false; failure = ''; generation++;
    menu.close(); $('terminal-switch-dialog').close();
    field.value = target.name; status.textContent = ''; updateRename();
    rename.showModal(); field.focus({ preventScroll: true }); field.select(); changed();
  });
  field.addEventListener('input', () => { if (!uncertain) failure = ''; updateRename(); });
  field.addEventListener('compositionstart', () => { composing = true; updateRename(); });
  field.addEventListener('compositionend', () => { composing = false; updateRename(); });
  rename.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.isComposing || composing || event.keyCode === 229)) event.preventDefault();
  });
  rename.addEventListener('cancel', event => { if (saving || composing) event.preventDefault(); });
  cancel.addEventListener('click', () => { if (!saving) rename.close(); });
  rename.addEventListener('close', () => {
    if (!rename.open) { const target = renameTarget; renameTarget = null; generation++; saving = composing = uncertain = false; restore(target); }
    changed();
  });
  $('terminal-rename-form').addEventListener('submit', async event => {
    event.preventDefault(); updateRename();
    if (save.disabled) return;
    const target = current(renameTarget), value = field.value.trim();
    if (value === target.name) { rename.close(); return; }
    const serial = ++generation;
    saving = true; updateRename(); status.textContent = '正在保存…';
    let result;
    try { result = await renameTerminal(target, value); }
    catch { result = { ok: false, outcome: 'unknown', message: '保存结果未知，请到终端管理刷新列表确认；不会自动重试。' }; }
    if (serial !== generation || !rename.open) return;
    saving = false;
    if (result?.ok) { rename.close(); return; }
    uncertain = result?.outcome === 'unknown';
    failure = result?.message || '当前无法修改，请检查连接后重新操作。'; updateRename();
  });
  window.addEventListener('resize', () => { if (menu.open) menu.close(); });
  return {
    open, close,
    get busy() { return menu.open || rename.open; },
    render(entries, state) {
      catalog = entries; disabled = state.disabled; visible = state.visible;
      if (!visible) { close(); return; }
      if (menu.open && (disabled || !current(menuTarget))) menu.close();
      if (rename.open) updateRename();
    },
  };
}
