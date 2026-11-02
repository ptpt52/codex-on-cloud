import { createTerminalHealth } from './terminal-health.js';

const query = new URLSearchParams(location.search), frame = query.get('frame'), viewer = query.get('viewer');
const terminalId = query.get('terminalId'), terminalToken = query.get('terminalToken');
const host = document.getElementById('terminal'), status = document.getElementById('terminal-status');
let term, fit, socket, csrf = '', ready = false, stopped = false, retry, sequence = 0, pending = null, layout = 0, retryDelay = 1000;
let blocked = true, busy = false, fontSize = 15, lastSize = '', lastReport = '', epoch = 0;
let health, connectingTimer;
const report = (state, extra = {}) => parent.postMessage({ type: 'codex-desktop', frame, state, transport: 'terminal', ...extra }, location.origin);
const controlState = () => parent.postMessage({ type: 'codex-control-state', frame, ready }, location.origin);
function message(text) { status.textContent = text; status.hidden = false; }
function finish(value, error) {
  if (!pending) return;
  const request = pending; pending = null;
  parent.postMessage({ type: 'codex-control-result', frame, id: request.parentId, ok: !error, value,
    error: error ? { message: error.message || '终端操作结果未知', outcome: error.outcome || 'unknown' } : undefined }, location.origin);
}
function send(value) {
  if (!ready || !navigator.onLine || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024 || sequence >= 2147483647) return false;
  socket.send(JSON.stringify({ ...value, id: ++sequence })); return sequence;
}
function size() {
  cancelAnimationFrame(layout);
  if (stopped) return;
  layout = requestAnimationFrame(() => {
    if (stopped || !term || !fit || !host.clientWidth || !host.clientHeight) return;
    term.options.fontSize = fontSize;
    const proposed = fit.proposeDimensions(); if (!proposed) return;
    const cols = Math.max(2, Math.min(500, proposed.cols)), rows = Math.max(1, Math.min(200, proposed.rows));
    term.resize(cols, rows);
    if (ready && lastSize !== `${cols}:${rows}` && send({ type: 'resize', cols, rows })) lastSize = `${cols}:${rows}`;
    if (lastReport !== `${cols}:${rows}`) { lastReport = `${cols}:${rows}`; parent.postMessage({ type: 'codex-terminal-size', frame, cols, rows }, location.origin); }
  });
}
function raw(data) {
  if (!ready || !data) return;
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
  term?.dispose(); host.replaceChildren();
  term = new Terminal({ fontSize, fontFamily: 'ui-monospace, "Noto Sans Mono CJK SC", monospace', scrollback: 2000,
    cursorBlink: true, allowProposedApi: false, disableStdin: blocked || busy || !ready || document.hidden || !navigator.onLine, theme: { background: '#151d1a', foreground: '#e7eee9', cursor: '#a8d8b7', selectionBackground: '#3e6652' } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); term.onData(raw);
  // Applications may not silently write the browser's clipboard via OSC 52.
  term.parser.registerOscHandler(52, () => true);
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC' && term.hasSelection()) {
      const text = term.getSelection(); navigator.clipboard?.writeText(text).catch(() => {}); return false;
    }
    return true;
  });
  size();
}
function inputState() { if (term) term.options.disableStdin = blocked || busy || !ready || document.hidden || !navigator.onLine; }
function reconnectLater(delay) {
  clearTimeout(retry); retry = undefined;
  if (!stopped && navigator.onLine && !document.hidden) retry = setTimeout(connect, delay);
}
function retire(current, delay = retryDelay) {
  if (!current || socket !== current) return;
  // Clear the logical connection before close(): a blackholed TCP connection
  // may never deliver a close event, and late events must not touch its successor.
  socket = null; ready = false; health?.close(); health = undefined;
  clearTimeout(connectingTimer); connectingTimer = undefined;
  finish(null, { outcome: 'unknown' }); inputState(); controlState(); report('disconnected');
  message(navigator.onLine ? '终端连接已断开，任务继续运行。正在重新连接；已发送输入不会重发。' : '等待网络恢复。原终端任务继续运行，已发送输入不会重发。');
  current.close();
  if (delay !== null) { reconnectLater(delay); retryDelay = Math.min(8000, retryDelay * 2); }
}
function connect() {
  clearTimeout(retry); retry = undefined;
  if (stopped || socket || !csrf || !navigator.onLine || document.hidden) return;
  const currentEpoch = ++epoch;
  ready = false; sequence = 0; lastSize = ''; lastReport = ''; createTerminal(); message('正在连接原有终端…'); report('connecting');
  const url = new URL('/terminal/connect', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries({ viewer, terminalId, terminalToken })) url.searchParams.set(key, value);
  const current = new WebSocket(url); socket = current;
  connectingTimer = setTimeout(() => { if (socket === current && !ready) retire(current); }, 12000);
  current.addEventListener('open', () => { if (socket === current) current.send(JSON.stringify({ type: 'auth', csrf })); });
  current.addEventListener('message', event => {
    if (socket !== current || currentEpoch !== epoch) return current.close();
    if (typeof event.data !== 'string' || event.data.length > 24576) return retire(current);
    let value; try { value = JSON.parse(event.data); } catch { return retire(current); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return retire(current);
    if (value.type === 'ready') {
      if (ready) return retire(current);
      clearTimeout(connectingTimer); connectingTimer = undefined;
      ready = true; retryDelay = 1000; status.hidden = true; inputState(); report('connected'); controlState(); size();
      health = createTerminalHealth(nonce => {
        if (socket !== current || current.readyState !== WebSocket.OPEN || current.bufferedAmount > 64 * 1024) return false;
        current.send(JSON.stringify({ type: 'health', nonce })); return true;
      }, () => { if (socket === current) retire(current, 0); });
      if (!document.hidden && navigator.onLine) health.start();
      return;
    }
    if (value.type === 'health' && ready) { health?.receive(value.nonce); return; }
    if (value.type === 'output' && ready && typeof value.data === 'string' && value.data.length <= 11000) {
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return retire(current); }
      term.write(bytes, () => { if (socket === current && current.readyState === WebSocket.OPEN && bytes.length) current.send(JSON.stringify({ type: 'ack', bytes: bytes.length })); }); return;
    }
    if (value.type === 'result' && pending?.id === value.id) {
      finish(value.ok ? { outcome: 'success' } : null, value.ok ? null : { message: value.message || '终端目标已变化，本次输入未发送', outcome: value.outcome || 'unknown' }); return;
    }
    retire(current);
  });
  current.addEventListener('close', () => retire(current));
  current.addEventListener('error', () => retire(current));
}
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent) return;
  if (value?.type === 'codex-desktop-options') {
    blocked = value.blocked !== false; busy = value.busy === true;
    if (Number.isInteger(value.terminalFontSize) && value.terminalFontSize >= 10 && value.terminalFontSize <= 28) fontSize = value.terminalFontSize;
    inputState();
    if (typeof value.csrf === 'string' && value.csrf.length <= 256 && value.csrf && !csrf) { csrf = value.csrf; connect(); }
    size(); return;
  }
  if (value?.frame !== frame || !Number.isSafeInteger(value.id)) return;
  if (value.type === 'codex-control-cancel') { retire(socket, 0); return; }
  if (value.type !== 'codex-control-request') return;
  const body = value.body;
  let error;
  if (!ready || blocked || pending || document.hidden || !navigator.onLine) error = { message: '终端暂不可输入，本次操作未发送', outcome: 'rejected' };
  else if (!body || typeof body !== 'object' || Array.isArray(body)) error = { message: '终端输入参数无效', outcome: 'rejected' };
  else if (body?.terminalId && (body.terminalId !== terminalId || body.terminalToken !== terminalToken)) error = { message: '输入目标与当前终端不一致，请重新选择', outcome: 'rejected' };
  else if (!['paste', 'key'].includes(value.action)) error = { message: '该操作不通过终端通道执行', outcome: 'rejected' };
  if (error) { parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: false, error }, location.origin); return; }
  const id = send({ type: 'control', action: value.action, text: body.text, key: body.key, bracketed: term.modes.bracketedPasteMode });
  if (!id) { parent.postMessage({ type: 'codex-control-result', frame, id: value.id, ok: false, error: { outcome: 'rejected', message: '终端繁忙，本次操作未发送' } }, location.origin); return; }
  pending = { id, parentId: value.id };
});
new ResizeObserver(size).observe(host);
window.visualViewport?.addEventListener('resize', size);
function resume(replaceConnecting = false) {
  inputState();
  if (stopped || document.hidden || !navigator.onLine) return;
  if (socket && ready) health?.wake();
  else if (socket && replaceConnecting) retire(socket, 0);
  else if (!socket) connect();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return resume(true);
  health?.suspend(); clearTimeout(retry); retry = undefined; clearTimeout(connectingTimer); connectingTimer = undefined; inputState();
});
window.addEventListener('online', () => resume());
window.addEventListener('offline', () => { health?.suspend(); clearTimeout(retry); retry = undefined; retire(socket, null); inputState(); });
navigator.connection?.addEventListener('change', () => resume());
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retry); cancelAnimationFrame(layout); retire(socket, null); health?.close(); clearTimeout(connectingTimer); term?.dispose(); term = fit = undefined; });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; resume(true); } });
report('ready');
