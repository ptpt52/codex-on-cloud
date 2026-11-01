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
