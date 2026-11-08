export function createTerminalTabs({ bar, tabs, mobileButton, dialog, list, choose, manage, changed }) {
  let signature = '';
  function render(catalog, selected, { visible, disabled, invalid, loading }) {
    bar.hidden = !visible;
    mobileButton.disabled = disabled;
    const current = catalog.find(item => item.id === selected && item.supported);
    mobileButton.textContent = invalid ? '原终端已失效 · 选择终端 ▾' : loading ? '正在核对终端…' : `${current?.available ? '已关闭 · 新开终端' : current?.name || '选择终端'} ▾`;
    mobileButton.title = current?.name || '选择终端';
    const next = JSON.stringify({ catalog, selected, disabled, invalid });
    if (signature === next) return;
    signature = next;
    const focusedId = tabs.contains(document.activeElement) ? document.activeElement?.dataset.terminalChoice : null;
    tabs.replaceChildren(); list.replaceChildren();
    for (const terminal of catalog) {
      const active = terminal.id === selected && !invalid;
      for (const [parent, compact] of [[tabs, true], [list, false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = compact ? 'terminal-tab view-button' : 'terminal-choice';
        button.dataset.terminalChoice = terminal.id; button.dataset.available = String(!!terminal.available); button.title = terminal.available ? `新开 ${terminal.name}` : terminal.name;
        button.disabled = disabled || !terminal.supported;
        const slotLabel = terminal.id === 'main' ? '＋ 主终端' : `＋ 新开 ${terminal.id.slice(3)}`;
        button.textContent = terminal.available ? (compact ? slotLabel : `${terminal.name} · 新开 ＋`) : terminal.name;
        if (terminal.available) button.setAttribute('aria-label', `新开 ${terminal.name}`);
        if (compact) { button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
        else {
          button.setAttribute('aria-pressed', String(active));
          const note = document.createElement('small'); note.textContent = terminal.available ? '空闲位置 · 点击新开 shell' : !terminal.supported ? '当前布局不可用' : active ? '当前查看和输入目标' : terminal.command || '已有终端'; button.append(note);
        }
        button.addEventListener('click', () => { if (choose(terminal.id)) dialog.close(); });
        parent.append(button);
      }
    }
    if (!tabs.querySelector('[tabindex="0"]')) tabs.querySelector('button:not(:disabled)')?.setAttribute('tabindex', '0');
    if (focusedId) {
      const replacement = [...tabs.children].find(button => button.dataset.terminalChoice === focusedId);
      if (replacement && !replacement.disabled && replacement.getClientRects().length) replacement.focus({ preventScroll: true });
    }
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tabs.querySelectorAll('button:not(:disabled)')]; if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  mobileButton.addEventListener('click', () => { dialog.showModal(); changed(); });
  document.getElementById('close-terminal-switch').addEventListener('click', () => dialog.close());
  document.getElementById('terminal-switch-manage').addEventListener('click', () => { dialog.close(); manage(); });
  return { render };
}
