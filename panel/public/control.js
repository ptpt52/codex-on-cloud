export const CONTROL_LIMIT = 256 * 1024;
export const CONTROL_TRACE_ACTIONS = Object.freeze(['ping', 'promote', 'activate', 'state', 'diagnostics', 'files', 'file-delete', 'forward-list', 'clipboard', 'paste', 'key', 'edit', 'terminal', 'terminals', 'create-terminal', 'open-terminal']);
const failureReasons = Object.freeze({ rpc_timeout: 'rpc-timeout', local_http_timeout: 'local-http-timeout', local_http_error: 'local-http-error', peer_closed: 'peer-closed', channel_error: 'channel-error', control_protocol: 'control-protocol', control_send: 'control-send' });
const CHUNK = 16 * 1024;

// A single bounded JSON record, framed over reliable, ordered binary messages.
export function sendControl(channel, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > CONTROL_LIMIT || channel.readyState !== 'open' || channel.bufferedAmount + bytes.length > 512 * 1024) throw new Error('直连控制通道暂不可用');
  const frame = new Uint8Array(bytes.length + 4);
  new DataView(frame.buffer).setUint32(0, bytes.length);
  frame.set(bytes, 4);
  for (let offset = 0; offset < frame.length; offset += CHUNK) channel.send(frame.subarray(offset, offset + CHUNK));
}

export function controlDecoder(receive, fail) {
  let record, offset = 0;
  const reset = () => { record = undefined; offset = 0; };
  return { reset, push(data) {
    try {
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else throw new Error('需要二进制消息');
      if (!bytes.length || bytes.length > CHUNK) throw new Error('控制消息大小无效');
      if (!record) {
        if (bytes.length < 4) throw new Error('控制消息头无效');
        const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        if (!size || size > CONTROL_LIMIT) throw new Error('控制消息过大');
        record = new Uint8Array(size); bytes = bytes.subarray(4);
      }
      if (offset + bytes.length > record.length) throw new Error('控制消息长度无效');
      record.set(bytes, offset); offset += bytes.length;
      if (offset !== record.length) return;
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record));
      reset();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('控制消息格式无效');
      receive(value);
    } catch { reset(); fail(); }
  } };
}

export function createControlClient(channel, changed, { keepOnTimeout = false, trace = () => {} } = {}) {
  channel.binaryType = 'arraybuffer';
  let pending, disposed = false, sequence = 0, draining;
  const unavailable = code => Object.assign(new Error('直连操作结果未知，请先查看桌面确认'), { outcome: 'unknown', ...(code ? { code } : {}) });
  const report = (type, entry, detail) => { try { trace(type, { path: 'direct', ...(entry?.action ? { action: entry.action } : {}),
    ...(entry ? { durationMs: Math.max(0, Math.round(performance.now() - entry.at)) } : {}), ...detail }); } catch {} };
  const finish = (error, value) => {
    if (!pending) return;
    const current = pending; pending = undefined;
    clearTimeout(current.timer);
    if (error) report('rpc-failed', current, { reason: Object.hasOwn(failureReasons, error.code) ? failureReasons[error.code] : error.status ? 'http-status' : 'closed',
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}), outcome: ['rejected', 'unknown', 'canceled'].includes(error.outcome) ? error.outcome : 'unknown' });
    error ? current.reject(error) : current.resolve(value);
  };
  const close = (reason = 'closed') => {
    if (disposed) return;
    disposed = true; draining = undefined; decoder.reset(); finish(unavailable(Object.keys(failureReasons).find(code => failureReasons[code] === reason)));
    if (reason !== 'closed') report('control-closed', undefined, { reason });
    channel.close(); changed(false);
  };
  const decoder = controlDecoder(value => {
    // Keep one ID and fixed diagnostic metadata, never the body or callbacks.
    // A late reply restores admission without changing the settled outcome.
    if (draining && value.id === draining.id && typeof value.ok === 'boolean') { report('rpc-recovered', draining, { reason: 'late-reply' }); draining = undefined; changed(true); return; }
    if (!pending || value.id !== pending.id || typeof value.ok !== 'boolean') { close('control-protocol'); return; }
    finish(value.ok ? null : Object.assign(new Error(value.error?.message || '直连操作失败'), { status: value.error?.status, outcome: value.error?.outcome || 'unknown', code: value.error?.code }), value.value);
  }, () => close('control-protocol'));
  channel.addEventListener('message', event => { if (!disposed) decoder.push(event.data); });
  channel.addEventListener('open', () => { if (!disposed) changed(true); });
  channel.addEventListener('close', () => close('peer-closed'));
  channel.addEventListener('error', () => close('channel-error'));
  return { close, get draining() { return !!draining; }, get ready() { return !disposed && !draining && channel.readyState === 'open'; },
    request(action, body) {
      if (pending || draining || disposed || channel.readyState !== 'open' || sequence >= 2147483647) return Promise.reject(Object.assign(new Error('直连控制通道繁忙或未就绪，本次操作未发送'), { outcome: 'rejected' }));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject, at: performance.now(), action: CONTROL_TRACE_ACTIONS.includes(action) ? action : undefined, timer: setTimeout(() => {
          if (!keepOnTimeout) { close('rpc-timeout'); return; }
          draining = { id, action: pending.action, at: pending.at }; finish(unavailable('rpc_timeout')); changed(false);
        }, 8000) };
        try { sendControl(channel, { id, action, body }); } catch { close('control-send'); }
      });
    },
  };
}

// Fixed operations, one pending request per operation, no replay queue.
// The parent verifies source + frame generation again before using any result.
export function createPanelBridge({ frame, current, connected, canSwitch = () => false, canOpen = () => false, attachmentState = () => current()?.attachmentState }) {
  const pending = new Map();
  const report = () => parent.postMessage({ type: 'codex-panel-state', frame, ready: connected() && current()?.panelReady === true,
    terminalSwitch: connected() && current()?.terminalSwitch === true, terminalCreate: connected() && current()?.terminalCreate === true,
    terminalOpen: connected() && current()?.terminalOpen === true,
    terminalAttachment: connected() && current()?.terminalAttachment === true, attachmentState: attachmentState() }, location.origin);
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.origin !== location.origin || event.source !== parent || value?.frame !== frame || !Number.isSafeInteger(value.id) || value.id < 1) return;
    if (value.type === 'codex-panel-cancel') { pending.get(value.id)?.controller.abort(); return; }
    if (value.type !== 'codex-panel-request') return;
    const source = current(), action = value.action;
    const reject = () => parent.postMessage({ type: 'codex-panel-result', frame, id: value.id, ok: false, error: { message: '连接操作未就绪或仍在处理，本次未发送', status: 409, outcome: 'rejected',
      ...(action === 'switch-terminal' ? { code: 'terminal_switch_busy' } : {}) } }, location.origin);
    const capable = action === 'switch-terminal' ? source?.terminalSwitch && canSwitch() : action === 'open-terminal' ? source?.terminalOpen && canOpen() : action === 'create-terminal' ? source?.terminalCreate : source?.panelReady;
    if (!['state', 'terminals', 'switch-terminal', 'create-terminal', 'open-terminal'].includes(action) || pending.has(value.id) || !connected() || !capable || [...pending.values()].some(p => p.action === action)) { reject(); return; }
    const entry = { action, controller: new AbortController() }; pending.set(value.id, entry);
    void source.panelRequest(action, value.body, entry.controller.signal).then(result => {
      if (entry.controller.signal.aborted || source !== current()) return;
      parent.postMessage({ type: 'codex-panel-result', frame, id: value.id, ok: true, value: result }, location.origin);
    }, error => {
      if (!entry.controller.signal.aborted) parent.postMessage({ type: 'codex-panel-result', frame, id: value.id, ok: false, error: { message: error.message, status: error.status, outcome: error.outcome || 'unknown', code: error.code } }, location.origin);
    }).finally(() => pending.delete(value.id));
  });
  window.addEventListener('pagehide', () => { for (const entry of pending.values()) entry.controller.abort(); pending.clear(); });
  return { report };
}
