import { createTerminalHealth } from './terminal-health.js';
import { terminalDirect, canTryDirect } from './terminal-rtc.js';
import { createTerminalHistory } from './terminal-history.js';
import { TERMINAL_THEME } from './terminal-history-style.js';

const query = new URLSearchParams(location.search), frame = query.get('frame'), viewer = query.get('viewer');
const terminalId = query.get('terminalId'), terminalToken = query.get('terminalToken');
const host = document.getElementById('terminal'), status = document.getElementById('terminal-status');
let term, fit, socket, csrf = '', ready = false, stopped = false, retry, sequence = 0, pending = null, layout = 0, retryDelay = 1000;
let blocked = true, busy = false, fontSize = 15, lastSize = '', lastReport = '', epoch = 0;
let widthMode = 'viewport', columnLimit = 500, layoutKey = '', fittedSize;
let health, connectingTimer, history;
let historyPending, historySequence = 0, historyFetchAt = -Infinity;
let historyStyles = false;
let candidateController, probeTimer, probeNetworkCheck = false, probeDelay = 15000, directFailed = false, directIssue = '', networkDetails = null, statsPending = false;
let switching = false, switchingFrom, switchApproval, switchSequence = 0, lastInteraction = 0, composing = false;
const pressedKeys = new Set(), pressedPointers = new Set();
const report = (state, extra = {}) => parent.postMessage({ type: 'codex-desktop', frame, state, transport: socket?.direct ? 'direct' : 'terminal', ...extra }, location.origin);
const controlState = () => parent.postMessage({ type: 'codex-control-state', frame, ready }, location.origin);
const reportNetwork = () => parent.postMessage({ type: 'codex-transport', frame, details: networkDetails, issue: directIssue }, location.origin);
function directFailure(reason) { directIssue = reason; reportNetwork(); }
async function refreshNetwork() {
  const current = socket;
  if (!ready || !current?.direct || statsPending || stopped) return;
  statsPending = true;
  try { const details = await current.stats(); if (socket === current && ready && !stopped) { networkDetails = details; reportNetwork(); } }
  catch {} finally { statsPending = false; }
}
function message(text) { status.textContent = text; status.hidden = false; }
function finish(value, error) {
  if (!pending) return;
  const request = pending; pending = null;
  parent.postMessage({ type: 'codex-control-result', frame, id: request.parentId, ok: !error, value,
    error: error ? { message: error.message || '终端操作结果未知', outcome: error.outcome || 'unknown' } : undefined }, location.origin);
}
function send(value) {
  if (!ready || switching || !navigator.onLine || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024 || sequence >= 2147483647) return false;
  socket.send(JSON.stringify({ ...value, id: ++sequence })); return sequence;
}
function finishHistory(error, value) {
  if (!historyPending) return;
  const current = historyPending; historyPending = undefined; clearTimeout(current.timer); current.signal.removeEventListener('abort', current.abort);
  error ? current.reject(error) : current.resolve(value);
}
function historyChunk(offset, signal) {
  if (signal.aborted || historyPending || !ready || blocked || busy || switching || pending || document.hidden || !navigator.onLine) return Promise.reject(new Error('当前连接或输入忙碌，请稍后重试'));
  if (offset === 0 && performance.now() - historyFetchAt < 1000) return Promise.reject(new Error('请稍后再补取历史'));
  return new Promise((resolve, reject) => {
    const styled = historyStyles, id = send({ type: 'history', offset, ...(styled ? { styled: true } : {}) }); if (!id) return reject(new Error('历史暂不可读取'));
    if (offset === 0) historyFetchAt = performance.now();
    historySequence = id;
    const abort = () => finishHistory(new Error('历史读取已取消'));
    historyPending = { id, offset, styled, resolve, reject, signal, abort, timer: setTimeout(() => finishHistory(new Error('历史读取超时，未自动重试')), 5000) };
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function readHistory(signal) {
  let offset = 0, text = ''; const decoder = new TextDecoder();
  for (let count = 0; count < 8; count++) {
    const value = await historyChunk(offset, signal); if (signal.aborted) throw new Error('历史读取已取消');
    text += decoder.decode(value.bytes, { stream: !value.done }); offset = value.next;
    if (value.done) return { text, styled: value.styled === true, alternate: value.alternate, truncated: value.truncated };
  }
  throw new Error('历史超过 64 KiB 上限');
}
function size() {
  cancelAnimationFrame(layout);
  if (stopped) return;
  layout = requestAnimationFrame(() => {
    if (stopped || !term || !fit || !host.clientWidth || !host.clientHeight) return;
    const key = `${host.clientWidth}:${host.clientHeight}:${fontSize}:${widthMode}:${columnLimit}:${devicePixelRatio}`;
    if (key !== layoutKey || !fittedSize) {
      term.options.fontSize = fontSize;
      let proposed = fit.proposeDimensions(); if (!proposed) return;
      // Enlarge the actual font instead of stretching a canvas: selection,
      // pointer coordinates, IME and the equal-width grid keep working.
      if (widthMode === 'scale' && proposed.cols > columnLimit) {
        term.options.fontSize = Math.round(Math.min(fontSize * 4, fontSize * (proposed.cols + 1) / (columnLimit + 1)) * 10) / 10;
        proposed = fit.proposeDimensions(); if (!proposed) return;
      }
      fittedSize = { cols: Math.max(2, Math.min(widthMode === 'scale' ? columnLimit : 500, proposed.cols)), rows: Math.max(1, Math.min(200, proposed.rows)), fontSize: term.options.fontSize };
      layoutKey = key;
    }
    const { cols, rows } = fittedSize;
    term.resize(cols, rows);
    host.style.setProperty('--terminal-font-size', `${fittedSize.fontSize}px`);
    host.style.setProperty('--terminal-font-family', term.options.fontFamily);
    const screenHeight = host.querySelector('.xterm-screen')?.getBoundingClientRect().height;
    if (screenHeight > 0) host.style.setProperty('--terminal-line-height', `${screenHeight / rows}px`);
    const sizeKey = `${cols}:${rows}:${widthMode}`;
    if (ready && lastSize !== sizeKey && send({ type: 'resize', cols, rows, geometry: true, viewport: widthMode === 'viewport' })) lastSize = sizeKey;
    const reportKey = `${cols}:${rows}:${fittedSize.fontSize}`;
    if (lastReport !== reportKey) { lastReport = reportKey; parent.postMessage({ type: 'codex-terminal-size', frame, ...fittedSize }, location.origin); }
  });
}
function raw(data) {
  if (!ready || switching || !data) return;
  // Keep terminal query replies alive while reviewing, without accepting edits.
  if (history?.reviewing && !/^\x1b(?:\[[?>=]?\d*(?:;\d*)*[cRn]|\]\d+;[^\x00-\x1f]{0,256}(?:\x07|\x1b\\)|P[^\x00-\x1f]{0,256}\x1b\\)$/.test(data)) return;
  lastInteraction = performance.now();
  if (data.length > 32768 || new TextEncoder().encode(data).length > 32768) { message('一次输入不能超过 32 KiB，请分段发送。'); return; }
  let chunk = '', bytes = 0;
  for (const char of data) {
    const length = new TextEncoder().encode(char).length;
    if (bytes + length > 4096) { if (!send({ type: 'input', data: chunk })) return retire(socket, 0); chunk = ''; bytes = 0; }
    chunk += char; bytes += length;
  }
  if (chunk && !send({ type: 'input', data: chunk })) retire(socket, 0);
}
function createTerminal() {
  if (term) { size(); return; }
  host.replaceChildren();
  term = new Terminal({ fontSize, fontFamily: 'ui-monospace, "Noto Sans Mono CJK SC", monospace', scrollback: 2000,
    scrollOnUserInput: false, scrollOnEraseInDisplay: false,
    cursorBlink: true, allowProposedApi: false, disableStdin: blocked || busy || !ready || document.hidden || !navigator.onLine, theme: TERMINAL_THEME });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); term.onData(raw);
  // Applications may not silently write the browser's clipboard via OSC 52.
  term.parser.registerOscHandler(52, () => true);
  history = createTerminalHistory(term, host, { allowed: () => ready && !blocked && !busy && !switching && !pending && !document.hidden && navigator.onLine,
    read: readHistory,
    page: direction => { lastInteraction = performance.now(); if (!send({ type: 'input', data: direction < 0 ? '\x1b[5~' : '\x1b[6~' })) retire(socket, 0); },
    changed: reviewing => { inputState(); parent.postMessage({ type: 'codex-terminal-history', frame, reviewing }, location.origin); } });
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC' && term.hasSelection()) {
      const text = term.getSelection(); navigator.clipboard?.writeText(text).catch(() => {}); return false;
    }
    if (history?.reviewing) { event.preventDefault(); return false; }
    return true;
  });
  size();
}
function inputState() {
  if (term) { term.options.disableStdin = blocked || busy || switching || !ready || document.hidden || !navigator.onLine; if (term.textarea) term.textarea.readOnly = history?.reviewing === true; }
  history?.update();
}
function reconnectLater(delay) {
  clearTimeout(retry); retry = undefined;
  if (!stopped && navigator.onLine && !document.hidden) retry = setTimeout(connect, delay);
}
function retire(current, delay = retryDelay) {
  if (!current || socket !== current) return;
  // Clear the logical connection before close(): a blackholed TCP connection
  // may never deliver a close event, and late events must not touch its successor.
  socket = null; ready = false; health?.close(); health = undefined;
  if (current.direct) { directFailed = true; if (!directIssue) directFailure('connection'); }
  stopProbe(); finishSwitch(); networkDetails = null; reportNetwork();
  clearTimeout(connectingTimer); connectingTimer = undefined;
  finish(null, { outcome: 'unknown' }); inputState(); controlState(); report('disconnected');
  finishHistory(new Error('连接已中断，历史读取不会自动重试'));
  message(navigator.onLine ? '终端连接已断开，任务继续运行。正在重新连接；已发送输入不会重发。' : '等待网络恢复。原终端任务继续运行，已发送输入不会重发。');
  current.close();
  if (delay !== null) { reconnectLater(delay); retryDelay = Math.min(8000, retryDelay * 2); }
}
async function connect() {
  clearTimeout(retry); retry = undefined;
  if (stopped || socket || candidateController || !csrf || !navigator.onLine || document.hidden) return;
  message('正在连接原有终端…'); report('connecting');
  if (!directFailed && canTryDirect()) {
    const controller = candidateController = new AbortController(); let candidate;
    try {
      candidate = await makeCandidate(controller); if (!candidate) throw new Error('直连未就绪');
      await candidate.start(); await candidate.ping();
      if (controller.signal.aborted || stopped || document.hidden || !navigator.onLine) throw new Error('连接已取消');
      await candidate.activate();
      if (controller.signal.aborted || stopped) throw new Error('连接已取消');
      attachSocket(candidate.socket); candidate.attach(); return;
    } catch {
      candidate?.close();
      if (controller.signal.aborted) { if (!stopped && !document.hidden && navigator.onLine) reconnectLater(0); return; }
      directFailed = true; if (!directIssue) directFailure('negotiation');
    } finally { if (candidateController === controller) candidateController = null; }
  } else if (!canTryDirect() && !directIssue) directFailure('unsupported');
  if (stopped || document.hidden || !navigator.onLine) return;
  const url = new URL('/terminal/connect', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries({ viewer, terminalId, terminalToken })) url.searchParams.set(key, value);
  attachSocket(new WebSocket(url));
}
function attachSocket(current) {
  const previous = socket;
  socket = current; health?.close(); clearTimeout(connectingTimer);
  const currentEpoch = ++epoch;
  ready = false; sequence = 0; historySequence = 0; lastSize = ''; lastReport = ''; createTerminal(); message('正在连接原有终端…'); report('connecting');
  previous?.close(); networkDetails = null; reportNetwork();
  connectingTimer = setTimeout(() => { if (socket === current && !ready) retire(current); }, 12000);
  current.addEventListener('open', () => { if (socket === current && !current.direct) current.send(JSON.stringify({ type: 'auth', csrf })); });
  current.addEventListener('message', event => {
    if (socket !== current || currentEpoch !== epoch) return current.close();
    if (typeof event.data !== 'string' || event.data.length > 24576) return retire(current);
    let value; try { value = JSON.parse(event.data); } catch { return retire(current); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return retire(current);
    if (value.type === 'ready') {
      if (ready) return retire(current);
      clearTimeout(connectingTimer); connectingTimer = undefined;
      ready = true; historyStyles = value.historyStyles === true; retryDelay = 1000; status.hidden = true; inputState(); report('connected'); controlState(); size();
      if (current.direct) directIssue = '';
      finishSwitch(); reportNetwork(); void refreshNetwork(); scheduleProbe();
      health = createTerminalHealth(nonce => {
        if (socket !== current || current.readyState !== WebSocket.OPEN || current.bufferedAmount > 64 * 1024) return false;
        current.send(JSON.stringify({ type: 'health', nonce })); return true;
      }, () => { if (socket === current) { if (current.direct) directFailure('heartbeat'); retire(current, 0); } });
      if (!document.hidden && navigator.onLine) health.start();
      return;
    }
    if (value.type === 'health' && ready) { health?.receive(value.nonce); void refreshNetwork(); return; }
    if (value.type === 'geometry' && ready) {
      if (!Number.isInteger(value.maxCols) || value.maxCols < 2 || value.maxCols > 500) return retire(current);
      if (columnLimit !== value.maxCols) { columnLimit = value.maxCols; size(); }
      return;
    }
    if (value.type === 'history' && ready) {
      if (value.id !== historyPending?.id) { if (Number.isSafeInteger(value.id) && value.id <= historySequence) return; return retire(current); }
      if (value.ok !== true) { finishHistory(new Error('当前终端历史不可读取')); return; }
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return retire(current); }
      if (bytes.length > 8192 || value.offset !== historyPending.offset || value.next !== value.offset + bytes.length || value.next > 65536 || typeof value.done !== 'boolean' || (!value.done && bytes.length !== 8192) || typeof value.alternate !== 'boolean' || typeof value.truncated !== 'boolean') return retire(current);
      if ((value.styled === true) !== historyPending.styled || (value.styled !== undefined && typeof value.styled !== 'boolean')) return retire(current);
      finishHistory(null, { ...value, bytes }); return;
    }
    if (value.type === 'output' && ready && typeof value.data === 'string' && value.data.length <= 11000) {
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return retire(current); }
      term.write(bytes, () => { if (socket === current && current.readyState === WebSocket.OPEN && bytes.length) current.send(JSON.stringify({ type: 'ack', bytes: bytes.length })); }); return;
    }
    if (value.type === 'result' && pending?.id === value.id) {
      finish(value.ok ? { outcome: 'success' } : null, value.ok ? null : { message: value.message || '终端目标已变化，本次输入未发送', outcome: value.outcome || 'unknown' }); return;
    }
    retire(current);
  });
  current.addEventListener('close', () => { if (!switching || current !== switchingFrom) retire(current, current.direct ? 0 : retryDelay); });
  current.addEventListener('error', () => { if (!switching || current !== switchingFrom) retire(current, current.direct ? 0 : retryDelay); });
}
function needsProbe() { return ready && socket && !socket.direct && !stopped && canTryDirect(); }
function nativeIdle() { return !composing && !pressedKeys.size && !pressedPointers.size && performance.now() - lastInteraction >= 800; }
function idleForSwitch() { return !blocked && !busy && !pending && !switching && !history?.reviewing && nativeIdle(); }
function stopProbe() {
  clearTimeout(probeTimer); probeTimer = undefined;
  probeNetworkCheck = false;
  candidateController?.abort(); switchApproval?.finish(false);
}
function scheduleProbe(delay = probeDelay, network = false) {
  if (!needsProbe() || candidateController || document.hidden || !navigator.onLine) return;
  if (probeTimer !== undefined && (!network || probeNetworkCheck)) return;
  clearTimeout(probeTimer); probeNetworkCheck = network;
  probeTimer = setTimeout(() => { probeTimer = undefined; probeNetworkCheck = false; void probeDirect(); }, delay);
}
function makeCandidate(controller) {
  return terminalDirect(viewer, { terminalId, terminalToken }, { signal: controller.signal,
    failed: reason => { if (!stopped && candidateController === controller && !controller.signal.aborted) directFailure(reason); } });
}
function finishSwitch(force = false) {
  if (!switching && !force) return;
  switching = false; switchingFrom = undefined; inputState();
  parent.postMessage({ type: 'codex-direct-finished', frame }, location.origin);
}
function prepareSwitch(signal) {
  return new Promise(resolve => {
    const id = ++switchSequence;
    const finish = allowed => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (switchApproval?.id === id) switchApproval = undefined; resolve(allowed); };
    const abort = () => finish(false), timer = setTimeout(abort, 2000);
    switchApproval = { id, finish }; signal.addEventListener('abort', abort, { once: true });
    parent.postMessage({ type: 'codex-direct-prepare', frame, id }, location.origin);
    if (signal.aborted) abort();
  });
}
function waitStable(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('探测已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
async function probeDirect() {
  if (!needsProbe() || candidateController || document.hidden || !navigator.onLine) return;
  if (!idleForSwitch()) { scheduleProbe(5000); return; }
  const controller = candidateController = new AbortController(), previous = socket, currentEpoch = epoch;
  let candidate, requested = false, promoted = false;
  try {
    candidate = await makeCandidate(controller); if (!candidate) throw new Error('直连未就绪');
    await candidate.start(); await candidate.ping(); await waitStable(controller.signal); await candidate.ping();
    if (!needsProbe() || epoch !== currentEpoch || socket !== previous || !idleForSwitch() || controller.signal.aborted) return;
    requested = true;
    if (!await prepareSwitch(controller.signal) || epoch !== currentEpoch || socket !== previous || stopped || document.hidden || !navigator.onLine || controller.signal.aborted || !nativeIdle() || pending || history?.reviewing) return;
    switching = true; switchingFrom = previous; health?.suspend(); inputState();
    await candidate.activate();
    if (epoch !== currentEpoch || socket !== previous || stopped || controller.signal.aborted) return;
    attachSocket(candidate.socket); candidate.attach(); promoted = true; probeDelay = 15000;
  } catch { if (!controller.signal.aborted) { probeDelay = Math.min(60000, probeDelay * 2); if (!directIssue) directFailure('negotiation'); } }
  finally {
    if (!promoted) candidate?.close();
    if (candidateController === controller) candidateController = null;
    if (requested && !promoted) {
      finishSwitch(true);
      if (socket === previous && previous.readyState !== WebSocket.OPEN) retire(previous, 0);
      else if (ready && !document.hidden && navigator.onLine) health?.wake();
    }
    scheduleProbe();
  }
}
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent) return;
  if (value?.type === 'codex-direct-approved' && value.frame === frame && switchApproval?.id === value.id) { switchApproval.finish(value.allowed === true); return; }
  if (value?.type === 'codex-desktop-options') {
    blocked = value.blocked !== false; busy = value.busy === true;
    if (Number.isInteger(value.terminalFontSize) && value.terminalFontSize >= 10 && value.terminalFontSize <= 28) fontSize = value.terminalFontSize;
    if (['viewport', 'scale', 'manual'].includes(value.terminalWidthMode)) widthMode = value.terminalWidthMode;
    inputState();
    if (typeof value.csrf === 'string' && value.csrf.length <= 256 && value.csrf && !csrf) { csrf = value.csrf; connect(); }
    size(); return;
  }
  if (value?.frame !== frame || !Number.isSafeInteger(value.id)) return;
  if (value.type === 'codex-control-cancel') { retire(socket, 0); return; }
  if (value.type !== 'codex-control-request') return;
  const body = value.body;
  let error;
  if (!ready || blocked || switching || pending || history?.reviewing || document.hidden || !navigator.onLine) error = { message: '终端暂不可输入，请先回到实时画面；本次操作未发送', outcome: 'rejected' };
  else if (!body || typeof body !== 'object' || Array.isArray(body)) error = { message: '终端输入参数无效', outcome: 'rejected' };
  else if (body?.terminalId && (body.terminalId !== terminalId || body.terminalToken !== terminalToken)) error = { message: '输入目标与当前终端不一致，请重新选择', outcome: 'rejected' };
  else if (!['paste', 'key'].includes(value.action)) error = { message: '该操作不通过终端通道执行', outcome: 'rejected' };
  if (error) { parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: false, error }, location.origin); return; }
  const id = send({ type: 'control', action: value.action, text: body.text, key: body.key, bracketed: term.modes.bracketedPasteMode });
  if (!id) { parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: false, error: { outcome: 'rejected', message: '终端繁忙，本次操作未发送' } }, location.origin); return; }
  pending = { id, parentId: value.id };
});
new ResizeObserver(size).observe(host);
document.fonts?.ready.then(() => { layoutKey = ''; size(); });
document.fonts?.addEventListener('loadingdone', () => { layoutKey = ''; size(); });
window.visualViewport?.addEventListener('resize', size);
function resume(replaceConnecting = false) {
  inputState();
  if (stopped || document.hidden || !navigator.onLine) return;
  if (socket && ready) health?.wake();
  else if (socket && replaceConnecting) retire(socket, 0);
  else if (candidateController && replaceConnecting && !socket) candidateController.abort();
  else if (!socket) connect();
  probeDelay = 15000; scheduleProbe(1000, true);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return resume(true);
  health?.suspend(); history?.suspend(); stopProbe(); clearTimeout(retry); retry = undefined; clearTimeout(connectingTimer); connectingTimer = undefined; inputState();
});
window.addEventListener('online', () => resume());
window.addEventListener('offline', () => { health?.suspend(); stopProbe(); clearTimeout(retry); retry = undefined; retire(socket, null); inputState(); });
navigator.connection?.addEventListener('change', () => resume());
window.addEventListener('pagehide', event => { stopped = true; history?.suspend(); stopProbe(); clearTimeout(retry); cancelAnimationFrame(layout); retire(socket, null); health?.close(); clearTimeout(connectingTimer); if (!event.persisted) { history?.dispose(); history = undefined; term?.dispose(); term = fit = undefined; } });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; resume(true); } });
for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(name, event => {
  lastInteraction = performance.now();
  if (name === 'keydown' && pressedKeys.size < 64) pressedKeys.add(event.code || event.key);
  if (name === 'keyup') pressedKeys.delete(event.code || event.key);
  if (name === 'pointerdown' && pressedPointers.size < 8) pressedPointers.add(event.pointerId);
  if (name === 'pointerup' || name === 'pointercancel') pressedPointers.delete(event.pointerId);
}, true);
window.addEventListener('compositionstart', () => { composing = true; lastInteraction = performance.now(); }, true);
window.addEventListener('compositionend', () => { composing = false; lastInteraction = performance.now(); }, true);
window.addEventListener('blur', () => { pressedKeys.clear(); pressedPointers.clear(); composing = false; lastInteraction = performance.now(); });
report('ready');
