// One in-memory xterm buffer: 2,000 history rows, at most 500 columns.
// Local scrolling never sends input. Program paging is an explicit opt-in.
import { parseHistoryStyles, renderHistoryRuns, findHistoryMatches, captureHistoryBuffer, HISTORY_TEXT_LIMIT } from './terminal-history-style.js';

export function createTerminalHistory(term, host, { allowed, page, read, changed }) {
  const mode = document.getElementById('history-program'), up = document.getElementById('history-up');
  const down = document.getElementById('history-down'), latest = document.getElementById('history-latest'), state = document.getElementById('history-state');
  const toggle = document.getElementById('history-tools-toggle'), tools = document.getElementById('history-tools'), query = document.getElementById('history-query');
  const previousMatch = document.getElementById('history-find-prev'), nextMatch = document.getElementById('history-find-next'), findState = document.getElementById('history-find-state');
  const copySelection = document.getElementById('history-copy-selection'), copyAll = document.getElementById('history-copy-all'), copyState = document.getElementById('history-copy-state');
  const manual = document.getElementById('history-copy-manual'), copyText = document.getElementById('history-copy-text');
  const archive = document.createElement('pre'); archive.id = 'history-archive'; archive.hidden = true; archive.tabIndex = 0; archive.setAttribute('aria-label', '远端历史快照'); host.appendChild(archive);
  const newer = document.createElement('button'); newer.id = 'history-new-output'; newer.type = 'button'; newer.hidden = true;
  newer.textContent = '有新输出 · 回到实时'; host.appendChild(newer);
  let program = false, reviewing = false, disposed = false, pixels = 0, lastPage = -Infinity, gesture, loading, notice = '';
  let archiveOpen = false, archiveAlternate = false, archiveTruncated = false;
  let unseen = false, archiveStyled = false, archiveSimplified = false;
  let view, archiveLocal = false, toolsOpen = false, searchTimer, queryComposing = false, appliedQuery = '', matches = [], groups = [], current = -1, limited = false;
  let copying = false, copyGeneration = 0;
  const listeners = [], subscriptions = [];
  const listen = (target, name, handler, options) => { target.addEventListener(name, handler, options); listeners.push(() => target.removeEventListener(name, handler, options)); };
  const floating = () => tools.ownerDocument !== document;
  function placeTools() {
    tools.dataset.composing = String(queryComposing);
    if (!window.frameElement) return;
    window.frameElement.dispatchEvent(new CustomEvent('codex-history-tools', { detail: {
      frame: new URLSearchParams(location.search).get('frame'), open: toolsOpen, composing: queryComposing,
    } }));
  }
  // Respect alternate screens. Treating tmux's cursor-addressed redraws as
  // ordinary scrollback mixes screen fragments into the history. Its alternate
  // buffer has no scrollback, so an upward gesture reads one bounded snapshot.
  function update() {
    if (disposed) return;
    const buffer = term.buffer.active, next = archiveOpen || !!loading || buffer.viewportY < buffer.baseY;
    const different = next !== reviewing; reviewing = next;
    if (!reviewing) unseen = false;
    newer.hidden = !reviewing || !unseen;
    mode.setAttribute('aria-pressed', String(program));
    up.disabled = !!loading || (program ? !allowed() : archiveOpen ? archive.scrollTop === 0 && (!archiveLocal || !allowed()) : buffer.viewportY === 0 && !allowed());
    down.disabled = !!loading || (program ? !allowed() : archiveOpen ? archive.scrollTop >= archive.scrollHeight - archive.clientHeight : !reviewing);
    latest.disabled = !reviewing && !program;
    let label = loading ? '正在按需补取历史，最多 64 KiB…' : archiveOpen ? archiveAlternate ? '当前画面快照，不含程序会话历史；可开启程序翻页' : `历史快照，输入暂停${archiveTruncated ? '（已截取最近 64 KiB）' : ''}` : notice || (reviewing ? '本地回看中，输入暂停' : program ? '程序翻页：滚动发送 PageUp / PageDown' : buffer.type === 'alternate' ? '上翻按需读取历史；重绘画面不混入历史' : '本地回看；滚到顶部可按需补取历史');
    if (archiveOpen) label += archiveSimplified ? ' · 部分样式已简化' : archiveStyled ? ' · 保留颜色与样式' : ' · 纯文本';
    if (archiveOpen && archiveLocal) label = `本地已加载快照，输入暂停${archiveTruncated ? '（最多 64 KiB）' : ''}`;
    if (reviewing && unseen) label += ' · 有新输出';
    if (state.textContent !== label) { state.textContent = label; state.title = label; }
    host.dataset.reviewing = String(reviewing);
    updateTools();
    if (different) changed(reviewing);
  }
  function cancelRead() { const current = loading; loading = undefined; current?.abort(); }
  function clearCopy() { copyGeneration++; if (manual.open) manual.close(); manual.hidden = true; copyText.value = ''; copyState.textContent = ''; }
  function selectCopy() { copyText.focus({ preventScroll: true }); copyText.select(); }
  function dismissCopy() { clearCopy(); updateTools(); }
  function selectedText() {
    const selection = window.getSelection();
    if (archiveOpen && selection?.rangeCount && selection.rangeCount <= 8 && archive.contains(selection.anchorNode) && archive.contains(selection.focusNode)) return selection.toString();
    return !archiveOpen && term.hasSelection() ? term.getSelection() : '';
  }
  function updateTools() {
    if (disposed) return;
    toggle.setAttribute('aria-expanded', String(toolsOpen)); tools.hidden = !toolsOpen;
    if (floating()) { toggle.removeAttribute('aria-controls'); toggle.setAttribute('aria-label', '收起顶部查找与复制'); }
    else { toggle.setAttribute('aria-controls', 'history-tools'); toggle.removeAttribute('aria-label'); }
    if (!toolsOpen) { archive.style.top = ''; return; }
    if (!floating()) {
      const height = `${Math.max(44, Math.min(280, host.clientHeight - 44, Math.floor(host.clientHeight * .6)))}px`;
      tools.style.maxHeight = height; tools.style.setProperty('--history-panel-height', height);
    }
    query.disabled = !view; previousMatch.disabled = nextMatch.disabled = !matches.length;
    copyAll.disabled = copying || !view?.text.length; copySelection.disabled = copying || !selectedText();
    const result = queryComposing ? '输入中…' : searchTimer !== undefined ? '查找中…' : !query.value ? '输入关键词' : !matches.length ? '无匹配' : `${current + 1}/${matches.length}${limited ? '+' : ''}`;
    const description = !view ? '等待历史读取完成' : `${archiveLocal ? '本地已加载内容' : '远端历史快照'} · ${result}`;
    const feedback = !manual.hidden ? '手动复制窗口已打开' : copying ? '复制中…' : copyState.textContent;
    findState.textContent = floating() && view ? feedback || result : description;
    findState.title = feedback || description; findState.setAttribute('aria-label', feedback || description);
    // Only the read-only view yields space to these tools. The live terminal's
    // size stays fixed, avoiding a remote redraw when searching or copying.
    archive.style.top = floating() ? '' : `${Math.max(0, Math.min(host.clientHeight - 44, tools.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 6))}px`;
  }
  function setCurrent(index, navigate = false) {
    for (const mark of groups[current] || []) delete mark.dataset.current;
    current = index;
    for (const mark of groups[current] || []) mark.dataset.current = 'true';
    updateTools();
    if (navigate && groups[current]?.length) {
      const rect = groups[current][0].getBoundingClientRect(), box = archive.getBoundingClientRect();
      const covered = toolsOpen && !floating() ? Math.min(archive.clientHeight - 20, Math.max(0, tools.getBoundingClientRect().bottom - box.top + 6)) : 0;
      if (rect.top < box.top + covered || rect.bottom > box.bottom) archive.scrollTop += rect.top - box.top - covered - 8;
      if (rect.left < box.left || rect.right > box.right) archive.scrollLeft += rect.left - box.left - 8;
    }
  }
  function search(navigate = false) {
    clearTimeout(searchTimer); searchTimer = undefined;
    query.value = query.value.slice(0, 128).replace(/[\uD800-\uDBFF]$/, '');
    appliedQuery = query.value;
    const found = findHistoryMatches(view?.text || '', query.value); matches = found.matches; limited = found.limited;
    if (view) {
      const top = archive.scrollTop, left = archive.scrollLeft;
      groups = renderHistoryRuns(archive, view.parsed, matches); archive.scrollTop = top; archive.scrollLeft = left;
      if (!view.parsed.runs.length) archive.textContent = '当前没有可回看的终端历史';
    } else groups = [];
    current = -1; setCurrent(matches.length ? 0 : -1, navigate && !!query.value);
  }
  function closeTools() {
    toolsOpen = false; queryComposing = false; query.value = ''; clearCopy(); search(); updateTools();
    placeTools();
  }
  function freezeLocal() {
    const parsed = captureHistoryBuffer(term);
    view = { parsed, text: parsed.runs.map(run => run.text).join('') }; archiveLocal = true; archiveStyled = true; archiveSimplified = parsed.simplified;
    archiveTruncated = parsed.truncated; archiveAlternate = false; archiveOpen = true; archive.hidden = false; program = false; clearCopy(); search();
    const height = parseFloat(getComputedStyle(archive).lineHeight) || 20; archive.scrollTop = parsed.viewportRow * height; update();
  }
  function openTools(focus = false) {
    if (!archiveOpen && !loading) freezeLocal();
    toolsOpen = true; tools.hidden = false; placeTools(); updateTools();
    if (!floating()) tools.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus && !query.disabled) query.focus({ preventScroll: true });
  }
  function live() {
    cancelRead(); closeTools(); view = undefined; matches = groups = []; current = -1; archive.replaceChildren();
    archiveOpen = false; archive.hidden = true; unseen = false; notice = ''; program = false; pixels = 0; term.scrollToBottom(); update();
  }
  async function copy(text, label, source) {
    if (copying || !text) return;
    if (text.length > HISTORY_TEXT_LIMIT || new TextEncoder().encode(text).length > HISTORY_TEXT_LIMIT) { copyState.textContent = '选区超过 64 KiB，请缩小选区'; return; }
    clearCopy(); const generation = copyGeneration; copying = true; updateTools();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!disposed && toolsOpen && generation === copyGeneration && !document.hidden) copyState.textContent = `已复制${label}`;
    } catch {
      if (!disposed && toolsOpen && generation === copyGeneration && !document.hidden) {
        copying = false; updateTools();
        source.focus({ preventScroll: true });
        manual.hidden = false; copyText.value = text; copyState.textContent = '请手动复制窗口内已选中的文字';
        manual.showModal(); selectCopy();
      }
    } finally { copying = false; updateTools(); }
  }
  function rowHeight() { return Math.max(1, parseFloat(getComputedStyle(archive).lineHeight) || host.clientHeight / term.rows); }
  function buttonLines() { return Math.max(1, Math.min(3, Math.floor((archiveOpen ? archive.clientHeight : host.clientHeight) / rowHeight() / 2))); }
  function distance(fullPage = false) {
    const line = rowHeight();
    return fullPage ? Math.max(line, (archiveOpen ? archive.clientHeight : host.clientHeight) - line) : buttonLines() * line;
  }
  async function fetchHistory(back = distance()) {
    if (loading || !allowed()) return;
    const controller = loading = new AbortController(); notice = ''; update();
    try {
      const value = await read(controller.signal);
      if (disposed || loading !== controller || controller.signal.aborted) return;
      clearCopy(); archiveStyled = value.styled === true; archiveLocal = false;
      const parsed = parseHistoryStyles(value.text || '', archiveStyled);
      view = { parsed, text: parsed.runs.map(run => run.text).join('') }; archiveSimplified = parsed.simplified; search();
      archiveAlternate = value.alternate; archiveTruncated = value.truncated;
      archiveOpen = true; archive.hidden = false; updateTools();
      // Start a few rows above the latest view. A fixed two-screen jump used
      // to land at the very top whenever the snapshot was shorter than that.
      archive.scrollTop = Math.max(0, archive.scrollHeight - archive.clientHeight - back);
    } catch (error) { if (!disposed && loading === controller && !controller.signal.aborted) notice = error.message; }
    finally { if (loading === controller) { loading = undefined; update(); } }
  }
  function turn(direction, fullPage = false) {
    notice = '';
    if (!program) {
      if (archiveOpen && archiveLocal && direction < 0 && archive.scrollTop === 0) void fetchHistory(distance(fullPage));
      else if (archiveOpen) archive.scrollBy(0, direction * distance(fullPage));
      else if (direction < 0 && term.buffer.active.viewportY === 0) void fetchHistory(distance(fullPage));
      else if (fullPage) term.scrollPages(direction);
      else term.scrollLines(direction * buttonLines());
      update(); return;
    }
    const now = performance.now();
    if (!allowed() || reviewing || now - lastPage < 160) return;
    lastPage = now; page(direction);
  }
  function scroll(delta, deltaMode = 0) {
    if (!Number.isFinite(delta) || !delta) return;
    const line = rowHeight();
    const amount = delta * (deltaMode === 1 ? line : deltaMode === 2 ? host.clientHeight : 1);
    const step = program ? 40 : line;
    pixels = Math.max(-host.clientHeight * 2, Math.min(host.clientHeight * 2, pixels + amount));
    const count = Math.trunc(pixels / step);
    if (!count) return;
    if (program) { pixels = 0; turn(Math.sign(count)); }
    else if (count < 0 && term.buffer.active.viewportY === 0) { pixels = 0; void fetchHistory(Math.min(distance(true), -count * line)); }
    else { pixels -= count * step; term.scrollLines(Math.max(-term.rows, Math.min(term.rows, count))); update(); }
  }
  listen(mode, 'click', () => { const next = !program; live(); program = next; update(); });
  listen(up, 'click', () => turn(-1)); listen(down, 'click', () => turn(1)); listen(latest, 'click', live);
  listen(newer, 'click', live);
  listen(toggle, 'click', () => { if (toolsOpen) closeTools(); else openTools(); });
  listen(document.getElementById('history-tools-close'), 'click', () => { closeTools(); toggle.focus({ preventScroll: true }); });
  const scheduleSearch = () => { clearCopy(); clearTimeout(searchTimer); searchTimer = setTimeout(() => search(true), 150); updateTools(); };
  listen(query, 'input', event => { if (!queryComposing && !event.isComposing) scheduleSearch(); });
  listen(query, 'compositionstart', () => { queryComposing = true; clearTimeout(searchTimer); searchTimer = undefined; updateTools(); placeTools(); });
  listen(query, 'compositionend', () => { queryComposing = false; scheduleSearch(); placeTools(); });
  listen(query, 'blur', () => { if (queryComposing) { queryComposing = false; scheduleSearch(); placeTools(); } });
  const moveMatch = direction => { clearCopy(); if (searchTimer !== undefined) search(); if (matches.length) setCurrent((current + direction + matches.length) % matches.length, true); };
  listen(previousMatch, 'click', () => moveMatch(-1)); listen(nextMatch, 'click', () => moveMatch(1));
  listen(query, 'keydown', event => { if (event.key === 'Enter' && !event.isComposing && !queryComposing && event.keyCode !== 229) { event.preventDefault(); event.stopImmediatePropagation(); moveMatch(event.shiftKey ? -1 : 1); } });
  const toolKeys = event => {
    if (event.isComposing || queryComposing || event.keyCode === 229) return;
    if (manual.open) return;
    if (event.key === 'Escape' && toolsOpen && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopImmediatePropagation(); closeTools(); toggle.focus({ preventScroll: true });
    } else if (reviewing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopImmediatePropagation(); openTools(true);
    }
  };
  listen(window, 'keydown', toolKeys, true); listen(tools, 'keydown', toolKeys, true);
  listen(tools, 'codex-history-layout', updateTools);
  listen(tools, 'codex-history-reset', clearCopy);
  listen(window, 'pageshow', () => { if (toolsOpen) placeTools(); });
  listen(copySelection, 'mousedown', event => event.preventDefault());
  listen(copySelection, 'click', () => { void copy(selectedText(), '选区', copySelection); });
  listen(copyAll, 'click', () => { void copy(view?.text || '', '当前快照', copyAll); });
  listen(document.getElementById('history-copy-dismiss'), 'click', dismissCopy);
  listen(document.getElementById('history-copy-select'), 'click', selectCopy);
  listen(manual, 'cancel', event => { event.preventDefault(); dismissCopy(); });
  listen(document, 'selectionchange', updateTools);
  listen(host, 'wheel', event => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    if (archiveOpen) {
      if (archiveLocal && archive.scrollTop === 0 && event.deltaY < 0) { event.preventDefault(); event.stopImmediatePropagation(); void fetchHistory(); }
      return;
    }
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
    if (event.key === 'PageUp') turn(-1, true);
    else if (event.key === 'PageDown') turn(1, true);
    else if (event.key === 'Home') { if (archiveOpen) archive.scrollTop = 0; else term.scrollToTop(); }
    else live();
    update();
  }, { capture: true });
  listen(archive, 'scroll', update);
  subscriptions.push(term.onScroll(update), term.onSelectionChange(updateTools), term.onResize(updateTools), term.onWriteParsed(() => { if (reviewing) unseen = true; update(); }));
  update();
  return { update, get reviewing() { return reviewing; }, suspend() { gesture = undefined; pixels = 0; queryComposing = false; clearCopy(); if (searchTimer !== undefined || query.value !== appliedQuery) search(); cancelRead(); update(); placeTools(); },
    dispose() { toolsOpen = false; queryComposing = false; placeTools(); disposed = true; clearTimeout(searchTimer); clearCopy(); view = undefined; matches = groups = []; cancelRead(); archive.remove(); newer.remove(); for (const remove of listeners) remove(); for (const subscription of subscriptions) subscription.dispose(); } };
}
