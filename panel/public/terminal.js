const query = new URLSearchParams(location.search), frame = query.get('frame'), viewer = query.get('viewer');
const terminalId = query.get('terminalId'), terminalToken = query.get('terminalToken');
const host = document.getElementById('terminal'), status = document.getElementById('terminal-status');
let term, fit, socket, csrf = '', ready = false, stopped = false, retry, sequence = 0, pending = null, layout = 0, retryDelay = 1000;
let blocked = true, busy = false, fontSize = 15, lastSize = '', lastReport = '', epoch = 0;
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
  if (!ready || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024 || sequence >= 2147483647) return false;
  socket.send(JSON.stringify({ ...value, id: ++sequence })); return sequence;
}
function size() {
  cancelAnimationFrame(layout);
  layout = requestAnimationFrame(() => {
    if (!term || !fit || !host.clientWidth || !host.clientHeight) return;
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
    if (bytes + length > 4096) { if (!send({ type: 'input', data: chunk })) return socket?.close(); chunk = ''; bytes = 0; }
    chunk += char; bytes += length;
  }
  if (chunk && !send({ type: 'input', data: chunk })) socket?.close();
}
function createTerminal() {
  term?.dispose(); host.replaceChildren();
  term = new Terminal({ fontSize, fontFamily: 'ui-monospace, "Noto Sans Mono CJK SC", monospace', scrollback: 2000,
    cursorBlink: true, allowProposedApi: false, disableStdin: blocked || busy, theme: { background: '#151d1a', foreground: '#e7eee9', cursor: '#a8d8b7', selectionBackground: '#3e6652' } });
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
function connect() {
  clearTimeout(retry);
  if (stopped || !csrf || !navigator.onLine || document.hidden) return;
  const currentEpoch = ++epoch;
  ready = false; sequence = 0; lastSize = ''; lastReport = ''; createTerminal(); message('正在连接原有终端…'); report('connecting');
  const url = new URL('/terminal/connect', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries({ viewer, terminalId, terminalToken })) url.searchParams.set(key, value);
  const current = new WebSocket(url); socket = current;
  current.addEventListener('open', () => { if (socket === current) current.send(JSON.stringify({ type: 'auth', csrf })); });
  current.addEventListener('message', event => {
    if (socket !== current || currentEpoch !== epoch || typeof event.data !== 'string' || event.data.length > 24576) return current.close();
    let value; try { value = JSON.parse(event.data); } catch { return current.close(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return current.close();
    if (value.type === 'ready') {
      ready = true; retryDelay = 1000; status.hidden = true; report('connected'); controlState(); size(); return;
    }
    if (value.type === 'output' && ready && typeof value.data === 'string' && value.data.length <= 11000) {
      let bytes; try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { return current.close(); }
      term.write(bytes, () => { if (socket === current && current.readyState === WebSocket.OPEN && bytes.length) current.send(JSON.stringify({ type: 'ack', bytes: bytes.length })); }); return;
    }
    if (value.type === 'result' && pending?.id === value.id) {
      finish(value.ok ? { outcome: 'success' } : null, value.ok ? null : { message: value.message || '终端目标已变化，本次输入未发送', outcome: value.outcome || 'unknown' }); return;
    }
    current.close();
  });
  current.addEventListener('close', () => {
    if (socket !== current) return;
    socket = null; ready = false; finish(null, { outcome: 'unknown' }); controlState(); report('disconnected');
    message('终端连接已断开，任务继续运行。正在重新连接；已发送输入不会重发。');
    if (!stopped && navigator.onLine && !document.hidden) { retry = setTimeout(connect, retryDelay); retryDelay = Math.min(8000, retryDelay * 2); }
  });
  current.addEventListener('error', () => current.close());
}
window.addEventListener('message', event => {
  const value = event.data;
  if (event.origin !== location.origin || event.source !== parent) return;
  if (value?.type === 'codex-desktop-options') {
    blocked = value.blocked !== false; busy = value.busy === true;
    if (Number.isInteger(value.terminalFontSize) && value.terminalFontSize >= 10 && value.terminalFontSize <= 28) fontSize = value.terminalFontSize;
    if (term) term.options.disableStdin = blocked || busy;
    if (typeof value.csrf === 'string' && value.csrf.length <= 256 && value.csrf && !csrf) { csrf = value.csrf; connect(); }
    size(); return;
  }
  if (value?.frame !== frame || !Number.isSafeInteger(value.id)) return;
  if (value.type === 'codex-control-cancel') { finish(null, { outcome: 'unknown' }); socket?.close(); return; }
  if (value.type !== 'codex-control-request') return;
  const body = value.body;
  let error;
  if (!ready || blocked || pending) error = { message: '终端暂不可输入，本次操作未发送', outcome: 'rejected' };
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && !socket) connect(); });
window.addEventListener('online', () => { if (!socket) connect(); });
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retry); cancelAnimationFrame(layout); finish(null, { outcome: 'unknown' }); socket?.close(); term?.dispose(); });
report('ready');
