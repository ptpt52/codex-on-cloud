// One in-memory xterm buffer: 2,000 history rows, at most 500 columns.
// Local scrolling never sends input. Program paging is an explicit opt-in.
export function createTerminalHistory(term, host, { allowed, page, read, changed }) {
  const mode = document.getElementById('history-program'), up = document.getElementById('history-up');
  const down = document.getElementById('history-down'), latest = document.getElementById('history-latest'), state = document.getElementById('history-state');
  const archive = document.createElement('pre'); archive.id = 'history-archive'; archive.hidden = true; archive.tabIndex = 0; archive.setAttribute('aria-label', '远端历史快照'); host.appendChild(archive);
  let program = false, reviewing = false, disposed = false, pixels = 0, lastPage = -Infinity, gesture, loading, notice = '';
  let archiveOpen = false, archiveAlternate = false, archiveTruncated = false;
  const listeners = [], subscriptions = [];
  const listen = (target, name, handler, options) => { target.addEventListener(name, handler, options); listeners.push(() => target.removeEventListener(name, handler, options)); };
  // tmux already owns the application's normal/alternate screens. Keep its
  // outer client in the browser's normal buffer so scrolled rows are retained.
  for (const final of ['h', 'l']) subscriptions.push(term.parser.registerCsiHandler({ prefix: '?', final }, params =>
    params.length > 0 && params.every(value => [47, 1047, 1049].includes(value))));
  function update() {
    if (disposed) return;
    const buffer = term.buffer.active, next = archiveOpen || !!loading || buffer.viewportY < buffer.baseY;
    const different = next !== reviewing; reviewing = next;
    mode.setAttribute('aria-pressed', String(program));
    up.disabled = !!loading || (program ? !allowed() : archiveOpen ? archive.scrollTop === 0 : buffer.viewportY === 0 && !allowed());
    down.disabled = !!loading || (program ? !allowed() : archiveOpen ? archive.scrollTop >= archive.scrollHeight - archive.clientHeight : !reviewing);
    latest.disabled = !reviewing && !program;
    state.textContent = loading ? '正在按需补取历史，最多 64 KiB…' : archiveOpen ? archiveAlternate ? '全屏程序快照；应用历史请开启程序翻页' : `历史快照，输入暂停${archiveTruncated ? '（已截取最近 64 KiB）' : ''}` : notice || (reviewing ? '本地回看中，输入暂停' : program ? '程序翻页：滚动发送 PageUp / PageDown' : '本地回看；滚到顶部可按需补取历史');
    host.dataset.reviewing = String(reviewing);
    if (different) changed(reviewing);
  }
  function cancelRead() { const current = loading; loading = undefined; current?.abort(); }
  function live() { cancelRead(); archiveOpen = false; archive.hidden = true; notice = ''; program = false; pixels = 0; term.scrollToBottom(); update(); }
  async function fetchHistory() {
    if (loading || !allowed()) return;
    const controller = loading = new AbortController(); notice = ''; update();
    try {
      const value = await read(controller.signal);
      if (disposed || loading !== controller || controller.signal.aborted) return;
      archive.textContent = value.text || '当前没有可回看的终端历史'; archiveAlternate = value.alternate; archiveTruncated = value.truncated;
      archiveOpen = true; archive.hidden = false; archive.scrollTop = Math.max(0, archive.scrollHeight - archive.clientHeight * 2);
    } catch (error) { if (!disposed && loading === controller && !controller.signal.aborted) notice = error.message; }
    finally { if (loading === controller) { loading = undefined; update(); } }
  }
  function turn(direction) {
    notice = '';
    if (!program) {
      if (archiveOpen) archive.scrollBy(0, direction * Math.max(1, archive.clientHeight - 24));
      else if (direction < 0 && term.buffer.active.viewportY === 0) void fetchHistory();
      else term.scrollPages(direction);
      update(); return;
    }
    const now = performance.now();
    if (!allowed() || reviewing || now - lastPage < 160) return;
    lastPage = now; page(direction);
  }
  function scroll(delta, deltaMode = 0) {
    if (!Number.isFinite(delta) || !delta) return;
    const line = Math.max(1, host.clientHeight / term.rows);
    const amount = delta * (deltaMode === 1 ? line : deltaMode === 2 ? host.clientHeight : 1);
    const step = program ? 40 : line;
    pixels = Math.max(-host.clientHeight * 2, Math.min(host.clientHeight * 2, pixels + amount));
    const count = Math.trunc(pixels / step);
    if (!count) return;
    if (program) { pixels = 0; turn(Math.sign(count)); }
    else if (count < 0 && term.buffer.active.viewportY === 0) { pixels = 0; void fetchHistory(); }
    else { pixels -= count * step; term.scrollLines(Math.max(-term.rows, Math.min(term.rows, count))); update(); }
  }
  listen(mode, 'click', () => { const next = !program; live(); program = next; update(); });
  listen(up, 'click', () => turn(-1)); listen(down, 'click', () => turn(1)); listen(latest, 'click', live);
  listen(host, 'wheel', event => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    if (archiveOpen) return;
    event.preventDefault(); event.stopImmediatePropagation(); scroll(event.deltaY, event.deltaMode);
  }, { capture: true, passive: false });
  listen(host, 'touchstart', event => {
    if (archiveOpen) return;
    gesture = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, vertical: false } : undefined;
  }, { capture: true, passive: true });
  listen(host, 'touchmove', event => {
    if (archiveOpen) return;
    if (!gesture || event.touches.length !== 1) { gesture = undefined; return; }
    const touch = event.touches[0], dx = touch.clientX - gesture.x, dy = gesture.y - touch.clientY;
    if (!gesture.vertical && (Math.abs(dy) < 8 || Math.abs(dy) <= Math.abs(dx))) return;
    gesture.vertical = true; gesture.x = touch.clientX; gesture.y = touch.clientY;
    event.preventDefault(); event.stopImmediatePropagation(); scroll(dy);
  }, { capture: true, passive: false });
  for (const name of ['touchend', 'touchcancel']) listen(host, name, () => { gesture = undefined; pixels = 0; }, { capture: true });
  for (const name of ['paste', 'beforeinput', 'input', 'compositionstart']) listen(host, name, event => {
    if (reviewing) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  listen(host, 'keydown', event => {
    if (!reviewing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!['PageUp', 'PageDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'PageUp') turn(-1);
    else if (event.key === 'PageDown') turn(1);
    else if (event.key === 'Home') { if (archiveOpen) archive.scrollTop = 0; else term.scrollToTop(); }
    else live();
    update();
  }, { capture: true });
  listen(archive, 'scroll', update);
  subscriptions.push(term.onScroll(update), term.onWriteParsed(update));
  update();
  return { update, get reviewing() { return reviewing; }, suspend() { gesture = undefined; pixels = 0; cancelRead(); update(); },
    dispose() { disposed = true; cancelRead(); archive.remove(); for (const remove of listeners) remove(); for (const subscription of subscriptions) subscription.dispose(); } };
}
