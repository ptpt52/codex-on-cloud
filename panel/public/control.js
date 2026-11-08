export const CONTROL_LIMIT = 256 * 1024;
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

export function createControlClient(channel, changed) {
  channel.binaryType = 'arraybuffer';
  let pending, disposed = false, sequence = 0;
  const unavailable = () => Object.assign(new Error('直连操作结果未知，请先查看桌面确认'), { outcome: 'unknown' });
  const finish = (error, value) => {
    if (!pending) return;
    const current = pending; pending = undefined;
    clearTimeout(current.timer);
    error ? current.reject(error) : current.resolve(value);
  };
  const close = () => {
    if (disposed) return;
    disposed = true; decoder.reset(); finish(unavailable()); channel.close(); changed(false);
  };
  const decoder = controlDecoder(value => {
    if (!pending || value.id !== pending.id || typeof value.ok !== 'boolean') { close(); return; }
    finish(value.ok ? null : Object.assign(new Error(value.error?.message || '直连操作失败'), { status: value.error?.status, outcome: value.error?.outcome || 'unknown' }), value.value);
  }, close);
  channel.addEventListener('message', event => { if (!disposed) decoder.push(event.data); });
  channel.addEventListener('open', () => { if (!disposed) changed(true); });
  channel.addEventListener('close', close);
  channel.addEventListener('error', close);
  return { close, get ready() { return !disposed && channel.readyState === 'open'; },
    request(action, body) {
      if (pending || disposed || channel.readyState !== 'open' || sequence >= 2147483647) return Promise.reject(Object.assign(new Error('直连控制通道繁忙或未就绪，本次操作未发送'), { outcome: 'rejected' }));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject, timer: setTimeout(close, 8000) };
        try { sendControl(channel, { id, action, body }); } catch { close(); }
      });
    },
  };
}

// Three fixed operations, one pending request per operation, no replay queue.
// The parent verifies source + frame generation again before using any result.
export function createPanelBridge({ frame, current, connected, canSwitch = () => false }) {
  const pending = new Map();
  const report = () => parent.postMessage({ type: 'codex-panel-state', frame, ready: connected() && current()?.panelReady === true,
    terminalSwitch: connected() && current()?.terminalSwitch === true }, location.origin);
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.origin !== location.origin || event.source !== parent || value?.frame !== frame || !Number.isSafeInteger(value.id) || value.id < 1) return;
    if (value.type === 'codex-panel-cancel') { pending.get(value.id)?.controller.abort(); return; }
    if (value.type !== 'codex-panel-request') return;
    const source = current(), action = value.action;
    const reject = () => parent.postMessage({ type: 'codex-panel-result', frame, id: value.id, ok: false, error: { message: '连接操作未就绪或仍在处理，本次未发送', status: 409, outcome: 'rejected',
      ...(action === 'switch-terminal' ? { code: 'terminal_switch_busy' } : {}) } }, location.origin);
    const capable = action === 'switch-terminal' ? source?.terminalSwitch && canSwitch() : source?.panelReady;
    if (!['state', 'terminals', 'switch-terminal'].includes(action) || pending.has(value.id) || !connected() || !capable || [...pending.values()].some(p => p.action === action)) { reject(); return; }
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
