import { createTerminalHealth } from './terminal-health.js';
import { terminalDirect, canTryDirect } from './terminal-rtc.js';
import { createTerminalHistory } from './terminal-history.js';
import { TERMINAL_THEME } from './terminal-history-style.js';
import { HISTORY_ROWS, DEFAULT_HISTORY_ROWS, HISTORY_BYTES, HISTORY_CHUNK } from './terminal-history-limits.js';
import { routePolicy, STABLE_ROUTE } from '/desktop/transport-policy.js';
import { createStreamClient } from '/desktop/stream-client.js';
import { createPanelBridge } from '/control.js';
import { rtcHints } from '/rtc-hints.js';

const query = new URLSearchParams(location.search), frame = query.get('frame'), viewer = query.get('viewer');
const fastConnect = query.get('fast') === '1', routes = routePolicy();
let probed = false;
const streamEnabled = query.get('stream') === '1';
let streamClient, streamPaused = false, pendingWrites = 0, pendingOutputAck = 0;
let terminalId = query.get('terminalId'), terminalToken = query.get('terminalToken'), rtcConfig;
const host = document.getElementById('terminal'), status = document.getElementById('terminal-status');
let term, fit, socket, csrf = '', ready = false, stopped = false, retry, sequence = 0, pending = null, layout = 0, retryDelay = 1000;
let blocked = true, busy = false, standby = false, fontSize = 15, lastSize = '', lastReport = '', epoch = 0;
let widthMode = 'viewport', columnLimit = 500, layoutKey = '', fittedSize;
let health, connectingTimer, history;
let historyPending, historySequence = 0, historyFetchAt = -Infinity;
let historyStyles = false;
let historyRows = DEFAULT_HISTORY_ROWS;
let candidateController, probeTimer, probeNetworkCheck = false, probeDelay = 15000, directFailed = false, directIssue = '', networkDetails = null, statsPending = false;
let switching = false, switchingFrom, switchApproval, switchSequence = 0, lastInteraction = -Infinity, composing = false;
const pressedKeys = new Set(), pressedPointers = new Set();
const report = (state, extra = {}) => parent.postMessage({ type: 'codex-desktop', frame, state, transport: socket?.direct ? 'direct' : 'terminal', ...extra }, location.origin);
const controlState = () => { parent.postMessage({ type: 'codex-control-state', frame, ready }, location.origin); panelBridge.report(); };
const targetInputIdle = () => !composing && !pressedKeys.size && !pressedPointers.size && !pending;
const targetIdle = () => targetInputIdle() && pendingWrites === 0;
const panelBridge = createPanelBridge({ frame, current: () => socket, connected: () => ready && !stopped,
  canSwitch: () => ready && !blocked && !switching && !streamPaused && targetInputIdle() });
const reportNetwork = () => {
  const rttMs = ready && !streamPaused && !document.hidden && navigator.onLine ? socket?.session ? socket.rttMs : health?.rttMs ?? null : null;
  parent.postMessage({ type: 'codex-transport', frame, details: networkDetails, rttMs, issue: directIssue }, location.origin);
};
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
  try { socket.send(JSON.stringify({ ...value, id: ++sequence })); return sequence; } catch { return false; }
}
function finishHistory(error, value) {
  if (!historyPending) return;
  const current = historyPending; historyPending = undefined; clearTimeout(current.timer); current.signal.removeEventListener('abort', current.abort);
  error ? current.reject(error) : current.resolve(value);
}
function historyChunk(offset, signal, timeout) {
  if (signal.aborted || historyPending || !ready || blocked || busy || switching || pending || document.hidden || !navigator.onLine) return Promise.reject(new Error('当前连接或输入忙碌，请稍后重试'));
  if (offset === 0 && performance.now() - historyFetchAt < 1000) return Promise.reject(new Error('请稍后再补取历史'));
  return new Promise((resolve, reject) => {
    const styled = historyStyles, id = send({ type: 'history', offset, limit: HISTORY_BYTES, ...(styled ? { styled: true } : {}) }); if (!id) return reject(new Error('历史暂不可读取'));
    if (offset === 0) historyFetchAt = performance.now();
    historySequence = id;
    const abort = () => finishHistory(new Error('历史读取已取消'));
    historyPending = { id, offset, styled, resolve, reject, signal, abort, timer: setTimeout(() => finishHistory(new Error('历史读取超时，未自动重试')), Math.min(5000, timeout)) };
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function readHistory(signal) {
  let offset = 0, text = ''; const decoder = new TextDecoder();
  const deadline = performance.now() + 60000;
  for (let count = 0; count < HISTORY_BYTES / HISTORY_CHUNK; count++) {
    if (performance.now() >= deadline) throw new Error('历史读取超时，未自动重试');
    const value = await historyChunk(offset, signal, deadline - performance.now()); if (signal.aborted) throw new Error('历史读取已取消');
    text += decoder.decode(value.bytes, { stream: !value.done }); offset = value.next;
    if (value.done) return { text, styled: value.styled === true, alternate: value.alternate, truncated: value.truncated };
  }
  throw new Error('历史超过 1 MiB 上限');
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
    if (ready && !standby && lastSize !== sizeKey && send({ type: 'resize', cols, rows, geometry: true, viewport: widthMode === 'viewport' })) lastSize = sizeKey;
    const reportKey = `${cols}:${rows}:${fittedSize.fontSize}`;
    if (lastReport !== reportKey) { lastReport = reportKey; parent.postMessage({ type: 'codex-terminal-size', frame, ...fittedSize }, location.origin); }
  });
}
function raw(data) {
  if (!ready || switching || !data) return;
  // Keep query replies alive during standby, handoffs and review, without edits.
  if ((standby || streamPaused || history?.reviewing) && !/^\x1b(?:\[[?>=]?\d*(?:;\d*)*[cRn]|\]\d+;[^\x00-\x1f]{0,256}(?:\x07|\x1b\\)|P[^\x00-\x1f]{0,256}\x1b\\)$/.test(data)) return;
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
  term = new Terminal({ fontSize, fontFamily: 'ui-monospace, "Noto Sans Mono CJK SC", monospace', scrollback: historyRows,
    scrollOnUserInput: false, scrollOnEraseInDisplay: false,
    cursorBlink: true, allowProposedApi: false, disableStdin: blocked || busy || !ready || document.hidden || !navigator.onLine, theme: TERMINAL_THEME });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); term.onData(raw);
  // Applications may not silently write the browser's clipboard via OSC 52.
  term.parser.registerOscHandler(52, () => true);
  history = createTerminalHistory(term, host, { allowed: () => ready && !blocked && !busy && !switching && !streamPaused && !pending && !document.hidden && navigator.onLine,
    read: readHistory,
    navigate: key => {
      const data = { PageUp: '\x1b[5~', PageDown: '\x1b[6~', 'Ctrl+End': '\x1b[1;5F' }[key];
      if (!data) return false;
      lastInteraction = performance.now();
      if (!send({ type: 'input', data })) { retire(socket, 0); return false; }
      return true;
    },
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
  if (term) { term.options.disableStdin = blocked || busy || switching || streamPaused || !ready || document.hidden || !navigator.onLine; if (term.textarea) term.textarea.readOnly = history?.reviewing === true; }
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
  if (current.session) { streamClient?.close(); streamClient = undefined; streamPaused = false; }
  pendingOutputAck = 0;
  if (current.direct) { directFailed = true; routes.changed(); if (!directIssue) directFailure('connection'); }
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
  if (streamEnabled) {
    streamClient = createStreamClient({ viewer, standby: new URLSearchParams(location.search).get('standby') === '1', csrf, terminal: { terminalId, terminalToken }, bootstrap: () => rtcConfig && ({ ...rtcConfig, csrf }), targetIdle,
      canSwitchTarget: () => ready && !blocked && !switching && targetInputIdle(), idle: idleForSwitch,
      settled: () => nativeIdle() && !pending && !history?.reviewing && pendingWrites === 0,
      prepare: prepareSwitch,
      paused: (value, { terminalSwitch = false } = {}) => {
        streamPaused = value;
        if (value) health?.suspend();
        else { if (pendingOutputAck && socket) acknowledgeOutput(socket, 0); health?.wake(); size(); }
        inputState(); parent.postMessage({ type: 'codex-stream-state', frame, paused: value, terminalSwitch }, location.origin);
      },
      changed: () => { networkDetails = null; if (streamClient?.socket.direct) directIssue = ''; if (ready) { report('connected'); reportNetwork(); controlState(); void refreshNetwork(); } },
      measured: () => { reportNetwork(); void refreshNetwork(); }, issue: directFailure });
    attachSocket(streamClient.socket); streamClient.start(); return;
  }
  if (!fastConnect && !directFailed && canTryDirect()) {
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
  connectingTimer = setTimeout(() => { if (socket === current && !ready) retire(current); }, current.session ? 45000 : 12000);
  current.addEventListener('target', event => {
    if (socket !== current || currentEpoch !== epoch) return;
    terminalId = event.data.terminalId; terminalToken = event.data.terminalToken;
    health?.close(); health = undefined;
    ready = false; sequence = historySequence = 0; lastSize = lastReport = layoutKey = ''; fittedSize = undefined; pendingOutputAck = 0;
    finishHistory(new Error('已切换终端，历史读取已取消')); history?.dispose(); history = undefined; term?.dispose(); term = undefined;
    createTerminal(); message('正在附加所选终端…'); report('connecting'); controlState();
    clearTimeout(connectingTimer); connectingTimer = setTimeout(() => { if (socket === current && !ready) retire(current); }, 12000);
  });
  current.addEventListener('open', () => { if (socket === current && !current.direct && !current.session) current.send(JSON.stringify({ type: 'auth', csrf })); });
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
      finishSwitch(); reportNetwork(); void refreshNetwork(); scheduleProbe(fastConnect && !probed ? 0 : probeDelay); probed = true;
      health = createTerminalHealth(nonce => {
        if (socket !== current || current.readyState !== WebSocket.OPEN || current.bufferedAmount > 64 * 1024) return false;
        current.send(JSON.stringify({ type: 'health', nonce })); return true;
      }, () => { if (socket === current) { if (current.direct) directFailure('heartbeat'); if (current.session) current.reconnect(); else retire(current, 0); } });
      if (!document.hidden && navigator.onLine) health.start();
      return;
    }
    if (value.type === 'health' && ready) { health?.receive(value.nonce); reportNetwork(); void refreshNetwork(); return; }
    if (value.type === 'geometry' && ready) {
      if (!Number.isInteger(value.maxCols) || value.maxCols < 2 || value.maxCols > 500) return retire(current);
      if (columnLimit !== value.maxCols) { columnLimit = value.maxCols; size(); }
      return;
    }
    if (value.type === 'history' && ready) {
      if (value.id !== historyPending?.id) { if (Number.isSafeInteger(value.id) && value.id <= historySequence) return; return retire(current); }
      if (value.ok !== true) { finishHistory(new Error('当前终端历史不可读取')); return; }
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return retire(current); }
      if (bytes.length > HISTORY_CHUNK || value.offset !== historyPending.offset || value.next !== value.offset + bytes.length || value.next > HISTORY_BYTES || typeof value.done !== 'boolean' || (!value.done && (bytes.length !== HISTORY_CHUNK || value.next === HISTORY_BYTES)) || typeof value.alternate !== 'boolean' || typeof value.truncated !== 'boolean') return retire(current);
      if ((value.styled === true) !== historyPending.styled || (value.styled !== undefined && typeof value.styled !== 'boolean')) return retire(current);
      finishHistory(null, { ...value, bytes }); return;
    }
    if (value.type === 'output' && ready && typeof value.data === 'string' && value.data.length <= 11000) {
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return retire(current); }
      pendingWrites++;
      term.write(bytes, () => { pendingWrites--; if (socket === current && current.readyState === WebSocket.OPEN && bytes.length) acknowledgeOutput(current, bytes.length); }); return;
    }
    if (value.type === 'result' && pending?.id === value.id) {
      finish(value.ok ? { outcome: 'success' } : null, value.ok ? null : { message: value.message || '终端目标已变化，本次输入未发送', outcome: value.outcome || 'unknown' }); return;
    }
    retire(current);
  });
  current.addEventListener('close', () => { if (!switching || current !== switchingFrom) retire(current, current.direct ? 0 : retryDelay); });
  current.addEventListener('error', () => { if (!switching || current !== switchingFrom) retire(current, current.direct ? 0 : retryDelay); });
}
function acknowledgeOutput(current, bytes) {
  pendingOutputAck += bytes;
  if (pendingOutputAck > 192 * 1024) return retire(current, 0);
  if (!pendingOutputAck) return;
  try { current.send(JSON.stringify({ type: 'ack', bytes: pendingOutputAck })); pendingOutputAck = 0; } catch {}
}
function needsProbe() { return ready && socket && !socket.session && !socket.direct && !stopped && canTryDirect(); }
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
  probeTimer = setTimeout(() => { probeTimer = undefined; probeNetworkCheck = false; void probeDirect(); }, fastConnect ? Math.max(delay, routes.remaining()) : delay);
}
function makeCandidate(controller) {
  return terminalDirect(viewer, { terminalId, terminalToken }, { signal: controller.signal, bootstrap: () => rtcConfig && ({ ...rtcConfig, csrf }),
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
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, fastConnect ? STABLE_ROUTE : 500);
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
    attachSocket(candidate.socket); candidate.attach(); promoted = true; probeDelay = 15000; routes.changed();
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
  if (value?.type === 'codex-direct-probe' && value.frame === frame) { resume(); return; }
  if (value?.type === 'codex-direct-approved' && value.frame === frame && switchApproval?.id === value.id) { switchApproval.finish(value.allowed === true); return; }
  if (value?.type === 'codex-desktop-options') {
    if (value.frame !== frame) return;
    if (value.rtc && typeof value.rtc.webrtc === 'boolean' && typeof value.rtc.rtcStunUrl === 'string' && value.rtc.rtcStunUrl.length <= 256) {
      try { rtcConfig = { webrtc: value.rtc.webrtc, rtcStunUrl: value.rtc.rtcStunUrl, hints: rtcHints(value.rtc.hints) }; } catch {}
    }
    const wasStandby = standby; standby = value.standby === true;
    blocked = standby || value.blocked !== false; busy = standby || value.busy === true;
    if (wasStandby !== standby) { lastReport = ''; controlState(); reportNetwork(); }
    if (Number.isInteger(value.terminalFontSize) && value.terminalFontSize >= 10 && value.terminalFontSize <= 28) fontSize = value.terminalFontSize;
    if (['viewport', 'scale', 'manual'].includes(value.terminalWidthMode)) widthMode = value.terminalWidthMode;
    if (HISTORY_ROWS.includes(value.terminalHistoryRows)) {
      historyRows = value.terminalHistoryRows;
      if (term && term.options.scrollback !== historyRows) term.options.scrollback = historyRows;
    }
    inputState();
    if (typeof value.csrf === 'string' && value.csrf.length <= 256 && value.csrf && !csrf) { csrf = value.csrf; connect(); }
    size(); return;
  }
  if (value?.frame !== frame || !Number.isSafeInteger(value.id)) return;
  if (value.type === 'codex-control-cancel') { retire(socket, 0); return; }
  if (value.type !== 'codex-control-request') return;
  const body = value.body;
  let error;
  if (!ready || blocked || switching || streamPaused || pending || history?.reviewing || document.hidden || !navigator.onLine) error = { message: '终端暂不可输入，请先回到实时画面；本次操作未发送', outcome: 'rejected' };
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
  streamClient?.wake();
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
window.addEventListener('offline', () => { health?.suspend(); stopProbe(); clearTimeout(retry); retry = undefined; if (!socket?.session) retire(socket, null); inputState(); });
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
function reportComposition() { parent.postMessage({ type: 'codex-terminal-composition', frame, composing }, location.origin); }
window.addEventListener('compositionstart', () => { composing = true; lastInteraction = performance.now(); reportComposition(); }, true);
window.addEventListener('compositionend', () => { composing = false; lastInteraction = performance.now(); reportComposition(); }, true);
window.addEventListener('blur', () => { pressedKeys.clear(); pressedPointers.clear(); composing = false; lastInteraction = performance.now(); reportComposition(); });
report('ready');
