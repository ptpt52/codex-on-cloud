// One in-memory xterm buffer: at most 20,000 history rows and 500 columns.
// Local scrolling never sends input. Program paging is an explicit opt-in.
import { parseHistoryStyles, renderHistoryRuns, findHistoryMatches, captureHistoryBuffer, createHistoryGrid, historyText, historyMatchRanges, wrapHistoryRows, HISTORY_TEXT_LIMIT } from './terminal-history-style.js';

// Keep the fixed controls across reconnects even while their toolbar belongs
// to the outer sidebar. Never adopt the terminal host or its text buffer.
const historyControls = new Map([...document.getElementById('terminal-tools').querySelectorAll('[id]')].map(element => [element.id, element]));
const historyControl = id => historyControls.get(id);

export function createTerminalHistory(term, host, { allowed, navigate, read, changed, nativeWheel = () => false }) {
  const mode = historyControl('history-program'), up = historyControl('history-up');
  const down = historyControl('history-down'), latest = historyControl('history-latest'), state = historyControl('history-state');
  const toggle = historyControl('history-tools-toggle'), tools = historyControl('history-tools'), query = historyControl('history-query');
  const previousMatch = historyControl('history-find-prev'), nextMatch = historyControl('history-find-next'), findState = historyControl('history-find-state');
  const copySelection = historyControl('history-copy-selection'), copyAll = historyControl('history-copy-all'), copyState = historyControl('history-copy-state');
  const download = historyControl('history-download');
  const manual = historyControl('history-copy-manual'), copyText = historyControl('history-copy-text');
  const retryCopy = historyControl('history-copy-retry'), copyResult = historyControl('history-copy-result');
  const archive = document.createElement('pre'); archive.id = 'history-archive'; archive.hidden = true; archive.tabIndex = 0; archive.setAttribute('aria-label', '远端历史快照'); host.appendChild(archive);
  const grid = createHistoryGrid(term, host);
  const newer = document.createElement('button'); newer.id = 'history-new-output'; newer.type = 'button'; newer.hidden = true;
  newer.textContent = '有新输出 · 回到实时'; host.appendChild(newer);
  let program = false, reviewing = false, inputPaused = false, disposed = false, pixels = 0, lastPage = -Infinity, gesture, loading, notice = '';
  // Remote program scrolling is independent of the local buffer and toggle.
  // Keep a flag, never a queue or an automatically replayed return key.
  let programScrolled = false;
  let archiveOpen = false, archiveAlternate = false, archiveTruncated = false;
  let unseen = false, archiveStyled = false, archiveSimplified = false;
  let view, archiveLocal = false, toolsOpen = false, searchTimer, queryComposing = false, appliedQuery = '', matches = [], groups = [], current = -1, limited = false;
  let copying = false, copyGeneration = 0;
  let downloadURL, downloadTimer;
  const listeners = [], subscriptions = [];
  const listen = (target, name, handler, options) => { target.addEventListener(name, handler, options); listeners.push(() => target.removeEventListener(name, handler, options)); };
  const floating = () => tools.ownerDocument !== document;
  function placeTools(focus = false) {
    tools.dataset.composing = String(queryComposing);
    if (!window.frameElement) return;
    window.frameElement.dispatchEvent(new CustomEvent('codex-history-tools', { detail: {
      frame: new URLSearchParams(location.search).get('frame'), open: toolsOpen, composing: queryComposing, focus,
    } }));
  }
  // Respect alternate screens. Treating tmux's cursor-addressed redraws as
  // ordinary scrollback mixes screen fragments into the history. Its alternate
  // buffer has no scrollback, so an upward gesture reads one bounded snapshot.
  function update() {
    if (disposed) return;
    const buffer = term.buffer.active, next = archiveOpen || !!loading || buffer.viewportY < buffer.baseY;
    reviewing = next;
    // Opening the find/copy controls on the live terminal is an auxiliary
    // action. It must not turn the original text terminal into a read-only
    // history view. Only an actual history review pauses input.
    const paused = reviewing, different = paused !== inputPaused; inputPaused = paused;
    if (!reviewing) unseen = false;
    newer.hidden = !reviewing || !unseen;
    // Explicit paging controls can resume the program from a read-only view;
    // snapshot scroll limits must never disable those controls.
    const paging = program;
    mode.setAttribute('aria-pressed', String(program));
    up.title = paging ? '向程序发送 PageUp，保留查找工具和关键词' : '本地回看，每次最多 3 行；到顶后按需补取历史';
    down.title = paging ? '向程序发送 PageDown，保留查找工具和关键词' : '本地回看，每次最多 3 行';
    up.disabled = !!loading || (paging ? !allowed() : archiveOpen ? archive.scrollTop === 0 && (!archiveLocal || !allowed()) : buffer.viewportY === 0 && !allowed());
    down.disabled = !!loading || (paging ? !allowed() : archiveOpen ? archive.scrollTop >= archive.scrollHeight - archive.clientHeight : !reviewing);
    latest.disabled = !reviewing && !program && !programScrolled;
    let label = loading ? '正在按需补取历史，最多 1 MiB…' : archiveOpen ? archiveAlternate ? '当前画面快照，不含程序会话历史；可开启程序翻页' : `历史快照，输入暂停${archiveTruncated ? '（已截取最近 1 MiB）' : ''}` : notice || (reviewing ? '本地回看中，输入暂停' : program ? nativeWheel() ? '程序翻页：滚轮按程序原生方式滚动；按钮整页翻动' : '程序翻页：滚动发送 PageUp / PageDown' : buffer.type === 'alternate' ? '上翻按需读取历史；重绘画面不混入历史' : '本地回看；滚到顶部可按需补取历史');
    if (!loading && !archiveOpen && !notice && !reviewing && !program && programScrolled) label = '程序历史位置保留；点“回到实时”发送 Ctrl+End';
    if (archiveOpen) label += archiveSimplified ? ' · 部分样式已简化' : archiveStyled ? ' · 保留颜色与样式' : ' · 纯文本';
    if (archiveOpen && archiveLocal) label = `本地已加载快照，输入暂停${archiveTruncated ? '（最多 1 MiB）' : ''}`;
    if (program && reviewing) label += ' · 程序翻页已暂停，点上翻/下翻继续，保留查找工具';
    if (toolsOpen && !reviewing) label += ' · 查找复制已展开，终端仍可输入';
    if (reviewing && unseen) label += ' · 有新输出';
    if (state.textContent !== label) { state.textContent = label; state.title = label; }
    host.dataset.reviewing = String(inputPaused);
    updateTools();
    if (different) changed(inputPaused);
  }
  function cancelRead() { const current = loading; loading = undefined; current?.abort(); }
  function clearDownload() { clearTimeout(downloadTimer); if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = undefined; }
  function focusControl(element) {
    // These controls can be adopted into the parent page. Firefox needs its
    // browsing context focused before an iframe shortcut can focus the field.
    const owner = element.ownerDocument.defaultView;
    owner.focus(); owner.HTMLElement.prototype.focus.call(element, { preventScroll: true });
  }
  function clearCopy() { copyGeneration++; if (manual.open) manual.close(); manual.hidden = true; copyText.value = ''; copyState.textContent = ''; copyResult.textContent = '关闭窗口会清空这里的文字。'; }
  function selectCopy() { focusControl(copyText); copyText.select(); }
  function dismissCopy() { clearCopy(); updateTools(); }
  async function copyFromWindow() {
    if (copying || disposed || !toolsOpen || !manual.open || !copyText.value) return;
    const generation = copyGeneration, text = copyText.value;
    const current = () => !disposed && toolsOpen && manual.open && generation === copyGeneration && !document.hidden;
    copying = true; copyResult.textContent = '正在复制…'; updateTools();
    try {
      selectCopy();
      // The dialog may belong to the outer page. Copy its selected text in that
      // document, synchronously within this explicit click, including on HTTP.
      let copied = false;
      try { copied = copyText.ownerDocument.execCommand('copy'); } catch {}
      if (!copied) {
        const clipboard = copyText.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard?.writeText) throw new Error('clipboard unavailable');
        await clipboard.writeText(text);
      }
      if (current()) { copyResult.textContent = '已复制到本机剪贴板。'; copyState.textContent = '已复制到本机剪贴板'; }
    } catch {
      if (current()) { selectCopy(); copyResult.textContent = '复制未成功，文字已全选，请按 Ctrl/Cmd+C 或长按复制。'; }
    } finally { copying = false; updateTools(); }
  }
  function selectedText() {
    const selection = window.getSelection();
    if (archiveOpen && selection?.rangeCount && selection.rangeCount <= 8 && archive.contains(selection.anchorNode) && archive.contains(selection.focusNode)) {
      const visible = selection.toString();
      if (!visible || !view.parsed.softBreaks?.length) return visible;
      const ranges = [];
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index), prefix = range.cloneRange();
        prefix.selectNodeContents(archive); prefix.setEnd(range.startContainer, range.startOffset);
        ranges.push({ start: prefix.toString().length, text: range.toString() });
      }
      // Chromium can omit a terminal newline from the rendered selection.
      // Map only the text it actually selected, then remove display wraps;
      // raw Range text must never add characters to a user's selection.
      const raw = ranges.map(range => range.text).join(''), first = raw.indexOf(visible);
      if (first < 0) return visible;
      const last = first + visible.length; let offset = 0, text = '';
      for (const range of ranges) {
        const start = Math.max(0, first - offset), end = Math.min(range.text.length, last - offset);
        if (end > start) text += historyText(view.parsed, range.start + start, range.start + end);
        offset += range.text.length;
      }
      return text;
    }
    return !archiveOpen && term.hasSelection() ? term.getSelection() : '';
  }
  function updateTools() {
    if (disposed) return;
    toggle.setAttribute('aria-expanded', String(toolsOpen)); tools.hidden = !toolsOpen;
    if (floating()) {
      if (toggle.ownerDocument === tools.ownerDocument) toggle.setAttribute('aria-controls', 'history-tools'); else toggle.removeAttribute('aria-controls');
      toggle.setAttribute('aria-label', toolsOpen ? '收起查找与复制' : '查找与复制');
    }
    else { toggle.setAttribute('aria-controls', 'history-tools'); toggle.removeAttribute('aria-label'); }
    if (!toolsOpen) { archive.style.top = ''; return; }
    if (!floating()) {
      const height = `${Math.max(44, Math.min(280, host.clientHeight - 44, Math.floor(host.clientHeight * .6)))}px`;
      tools.style.maxHeight = height; tools.style.setProperty('--history-panel-height', height);
    }
    query.disabled = !view && !!loading;
    previousMatch.disabled = nextMatch.disabled = !matches.length && (!!view || !!loading || !query.value);
    const contentAvailable = view ? !!view.text.length : !loading;
    copyAll.disabled = copying || !contentAvailable; copySelection.disabled = copying || !selectedText();
    download.disabled = !contentAvailable;
    retryCopy.disabled = copying || !manual.open || !copyText.value;
    retryCopy.textContent = copying && manual.open ? '复制中…' : '复制到本机';
    const result = queryComposing ? '输入中…' : searchTimer !== undefined ? '查找中…' : !view && !loading ? query.value ? '回车查找当前画面' : '输入关键词查找当前画面' : !query.value ? '输入关键词' : !matches.length ? '无匹配' : `${current + 1}/${matches.length}${limited ? '+' : ''}`;
    const description = !view ? loading ? '等待历史读取完成' : `实时画面 · ${result}` : `${archiveLocal ? '本地已加载内容' : '远端历史快照'} · ${result}`;
    const feedback = !manual.hidden ? '手动复制窗口已打开' : copying ? '复制中…' : copyState.textContent;
    findState.textContent = floating() ? feedback || result : description;
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
      groups = renderHistoryRuns(archive, view.parsed, historyMatchRanges(view.parsed, matches), grid); archiveSimplified = view.parsed.simplified || grid.limited;
      archive.scrollTop = top; archive.scrollLeft = left;
      if (!view.parsed.runs.length) archive.textContent = '当前没有可回看的终端历史';
    } else groups = [];
    current = -1; setCurrent(matches.length ? 0 : -1, navigate && !!query.value);
  }
  function closeTools() {
    toolsOpen = false; queryComposing = false; query.value = ''; clearCopy(); clearDownload(); search(); update();
    placeTools();
  }
  function freezeLocal() {
    const parsed = captureHistoryBuffer(term);
    view = { parsed, text: historyText(parsed) }; archiveLocal = true; archiveStyled = true; archiveSimplified = parsed.simplified;
    archiveTruncated = parsed.truncated; archiveAlternate = false; archiveOpen = true; archive.hidden = false; pixels = 0; gesture = undefined; clearCopy(); search();
    const height = parseFloat(getComputedStyle(archive).lineHeight) || 20; archive.scrollTop = parsed.viewportRow * height; update();
  }
  function openTools(focus = false) {
    // A live terminal keeps accepting input while this auxiliary panel is
    // open. Preserve the read-only archive when the user is already reviewing
    // history or has left a program at an older remote position.
    // Capture live content only when a search/copy/export is requested. A
    // hidden snapshot would make matches invisible and copied output stale.
    if (!archiveOpen && !loading && (reviewing || programScrolled)) freezeLocal();
    toolsOpen = true; tools.hidden = false; placeTools(focus); update();
    if (!floating()) tools.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus && !query.disabled) focusControl(query);
  }
  function resetLocalView() {
    // The drawer and program preference are independent of the displayed view.
    // Returning to the program must not dismiss tools or discard the query.
    cancelRead(); clearCopy(); clearDownload(); view = undefined; matches = groups = []; current = -1; archive.replaceChildren();
    archiveOpen = false; archive.hidden = true; unseen = false; notice = '';
    pixels = 0; gesture = undefined; search(); term.scrollToBottom(); update();
  }
  function ensureView() {
    if (!toolsOpen || disposed || view || loading) return false;
    freezeLocal(); return true;
  }
  function findCurrent(navigate = false) {
    if (!toolsOpen || disposed) return;
    if (!ensureView()) search(navigate);
    else if (navigate && query.value) setCurrent(matches.length ? 0 : -1, true);
  }
  function live() {
    const returnProgram = program || programScrolled;
    resetLocalView();
    if (!returnProgram) return;
    // Ctrl+End returns Codex's owned transcript to its latest output. Plain
    // End moves the composer cursor; Escape can interrupt a running turn.
    if (!allowed() || !navigate('Ctrl+End')) {
      programScrolled = true;
      notice = '回到程序末尾的按键未发送；连接可用后请再点“回到实时”';
    } else {
      programScrolled = false;
      notice = '已向程序发送 Ctrl+End 回到末尾；未发送回车';
    }
    update();
  }
  async function copy(text, label, source) {
    if (disposed || !toolsOpen || copying || !text) return;
    if (text.length > HISTORY_TEXT_LIMIT || new TextEncoder().encode(text).length > HISTORY_TEXT_LIMIT) { copyState.textContent = '选区超过 1 MiB，请缩小选区'; return; }
    clearCopy(); const generation = copyGeneration; copying = true; updateTools();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!disposed && toolsOpen && generation === copyGeneration && !document.hidden) copyState.textContent = `已复制${label}`;
    } catch {
      if (!disposed && toolsOpen && generation === copyGeneration && !document.hidden) {
        copying = false; updateTools();
        focusControl(source);
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
      let parsed = parseHistoryStyles(value.text || '', archiveStyled);
      if (value.joined) parsed = wrapHistoryRows(parsed, value.cols, term._core.unicodeService);
      view = { parsed, text: historyText(parsed) }; archiveSimplified = parsed.simplified; search();
      archiveAlternate = value.alternate; archiveTruncated = value.truncated;
      archiveOpen = true; archive.hidden = false; updateTools();
      // Start a few rows above the latest view. A fixed two-screen jump used
      // to land at the very top whenever the snapshot was shorter than that.
      archive.scrollTop = Math.max(0, archive.scrollHeight - archive.clientHeight - back);
    } catch (error) { if (!disposed && loading === controller && !controller.signal.aborted) notice = error.message; }
    finally { if (loading === controller) { loading = undefined; update(); } }
  }
  function turn(direction, fullPage = false, explicit = false) {
    // Only an explicit toolbar action resumes remote paging. Wheel, touch and
    // keyboard navigation inside a frozen snapshot remain local.
    if (program && (explicit || !reviewing)) {
      const now = performance.now();
      if (!allowed() || (!explicit && now - lastPage < 160)) return;
      // Also cancel a queued local search when already live, so its timer
      // cannot freeze the previous page after this navigation was sent.
      resetLocalView(); lastPage = now;
      if (navigate(direction < 0 ? 'PageUp' : 'PageDown')) programScrolled = true;
      update(); return;
    }
    notice = '';
    if (archiveOpen && archiveLocal && direction < 0 && archive.scrollTop === 0) void fetchHistory(distance(fullPage));
    else if (archiveOpen) archive.scrollBy(0, direction * distance(fullPage));
    else if (direction < 0 && term.buffer.active.viewportY === 0) void fetchHistory(distance(fullPage));
    else if (fullPage) term.scrollPages(direction);
    else term.scrollLines(direction * buttonLines());
    update();
  }
  function scroll(delta, deltaMode = 0) {
    if (!Number.isFinite(delta) || !delta) return;
    const line = rowHeight();
    const amount = delta * (deltaMode === 1 ? line : deltaMode === 2 ? host.clientHeight : 1);
    const paging = program && !reviewing, step = paging ? 40 : line;
    pixels = Math.max(-host.clientHeight * 2, Math.min(host.clientHeight * 2, pixels + amount));
    const count = Math.trunc(pixels / step);
    if (!count) return;
    if (paging) { pixels = 0; turn(Math.sign(count)); }
    else if (count < 0 && term.buffer.active.viewportY === 0) { pixels = 0; void fetchHistory(Math.min(distance(true), -count * line)); }
    else { pixels -= count * step; term.scrollLines(Math.max(-term.rows, Math.min(term.rows, count))); update(); }
  }
  listen(mode, 'click', () => {
    const next = !program;
    if (toolsOpen) cancelRead(); else resetLocalView();
    program = next; pixels = 0; gesture = undefined; update();
  });
  listen(up, 'click', () => turn(-1, false, true)); listen(down, 'click', () => turn(1, false, true)); listen(latest, 'click', live);
  listen(newer, 'click', live);
  listen(toggle, 'click', () => { if (toolsOpen) closeTools(); else openTools(); });
  listen(historyControl('history-tools-close'), 'click', () => { closeTools(); toggle.focus({ preventScroll: true }); });
  const scheduleSearch = () => { if (!toolsOpen) return; clearCopy(); clearTimeout(searchTimer); searchTimer = setTimeout(() => findCurrent(true), 150); updateTools(); };
  listen(query, 'input', event => { if (!queryComposing && !event.isComposing) scheduleSearch(); });
  listen(query, 'compositionstart', () => { queryComposing = true; clearTimeout(searchTimer); searchTimer = undefined; updateTools(); placeTools(); });
  listen(query, 'compositionend', () => { queryComposing = false; scheduleSearch(); placeTools(); });
  listen(query, 'blur', () => { if (queryComposing) { queryComposing = false; scheduleSearch(); placeTools(); } });
  const moveMatch = direction => {
    if (!toolsOpen || disposed) return;
    clearCopy(); const fresh = ensureView(), edited = searchTimer !== undefined || query.value !== appliedQuery;
    if (edited) search();
    if (matches.length) setCurrent(fresh || edited ? direction < 0 ? matches.length - 1 : 0 : (current + direction + matches.length) % matches.length, true);
  };
  listen(previousMatch, 'click', () => moveMatch(-1)); listen(nextMatch, 'click', () => moveMatch(1));
  listen(query, 'keydown', event => { if (event.key === 'Enter' && !event.isComposing && !queryComposing && event.keyCode !== 229) { event.preventDefault(); event.stopImmediatePropagation(); moveMatch(event.shiftKey ? -1 : 1); } });
  const toolKeys = event => {
    if (event.isComposing || queryComposing || event.keyCode === 229) return;
    if (manual.open) return;
    if (event.key === 'Escape' && toolsOpen && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopImmediatePropagation(); closeTools(); toggle.focus({ preventScroll: true });
    } else if ((inputPaused || toolsOpen) && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopImmediatePropagation(); openTools(true);
    }
  };
  listen(window, 'keydown', toolKeys, true); listen(tools, 'keydown', toolKeys, true);
  listen(tools, 'codex-history-layout', updateTools);
  listen(tools, 'codex-history-reset', clearCopy);
  listen(window, 'pageshow', () => { if (toolsOpen) placeTools(); });
  listen(copySelection, 'mousedown', event => event.preventDefault());
  listen(copySelection, 'click', () => { const text = selectedText(); if (text) { ensureView(); void copy(text, '选区', copySelection); } });
  listen(copyAll, 'click', () => { ensureView(); void copy(view?.text || '', '当前快照', copyAll); });
  listen(download, 'click', () => {
    if (disposed || !toolsOpen) return;
    ensureView(); if (!view?.text) return;
    const blob = new Blob([view.text], { type: 'text/plain;charset=utf-8' });
    if (blob.size > HISTORY_TEXT_LIMIT) { copyState.textContent = '快照超过 1 MiB，无法下载'; updateTools(); return; }
    clearDownload();
    const link = download.ownerDocument.createElement('a');
    try {
      downloadURL = URL.createObjectURL(blob); link.href = downloadURL; link.download = 'codex-terminal-history.txt'; link.hidden = true;
      download.ownerDocument.body.appendChild(link); link.click();
      downloadTimer = setTimeout(clearDownload, 30000); copyState.textContent = '已导出当前快照';
    } catch { clearDownload(); copyState.textContent = '下载失败，可复制当前快照'; }
    finally { link.remove(); updateTools(); }
  });
  listen(historyControl('history-copy-dismiss'), 'click', dismissCopy);
  listen(historyControl('history-copy-select'), 'click', selectCopy);
  listen(retryCopy, 'click', () => { void copyFromWindow(); });
  listen(manual, 'cancel', event => { event.preventDefault(); dismissCopy(); });
  listen(document, 'selectionchange', updateTools);
  listen(archive, 'copy', event => {
    const text = selectedText();
    if (text && event.clipboardData) { event.preventDefault(); event.clipboardData.setData('text/plain', text); }
  });
  listen(host, 'wheel', event => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    if (archiveOpen) {
      if (archiveLocal && archive.scrollTop === 0 && event.deltaY < 0) { event.preventDefault(); event.stopImmediatePropagation(); void fetchHistory(); }
      return;
    }
    if (program && !reviewing && allowed() && nativeWheel() && term.element.contains(event.target)) {
      // Let xterm normalize fine wheel deltas and send the program its native
      // mouse scroll. PageUp per 40px made small gestures jump entire screens.
      if (view || loading || searchTimer !== undefined || notice || downloadURL) resetLocalView();
      if (!programScrolled) { programScrolled = true; update(); }
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
    if (inputPaused) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  listen(host, 'keydown', event => {
    if (!inputPaused || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!['PageUp', 'PageDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'PageUp') turn(-1, true);
    else if (event.key === 'PageDown') turn(1, true);
    else if (event.key === 'Home') { if (archiveOpen) archive.scrollTop = 0; else term.scrollToTop(); }
    else resetLocalView();
    update();
  }, { capture: true });
  listen(archive, 'scroll', update);
  subscriptions.push(term.onScroll(update), term.onSelectionChange(updateTools), term.onResize(updateTools), term.onWriteParsed(() => { if (reviewing) unseen = true; update(); }));
  update();
  return { update, resize() { if (grid.update() && view) search(); }, get reviewing() { return inputPaused; }, suspend() { gesture = undefined; pixels = 0; queryComposing = false; clearCopy(); clearDownload(); if (searchTimer !== undefined || query.value !== appliedQuery) findCurrent(); cancelRead(); update(); placeTools(); },
    dispose() { toolsOpen = false; queryComposing = false; placeTools(); disposed = true; clearTimeout(searchTimer); clearCopy(); clearDownload(); view = undefined; matches = groups = []; cancelRead(); archive.remove(); newer.remove(); for (const remove of listeners) remove(); for (const subscription of subscriptions) subscription.dispose(); } };
}
