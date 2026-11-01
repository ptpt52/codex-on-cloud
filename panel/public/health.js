// One read-only probe at a time, independent of the single in-flight input.
export function createHealthClient(channel) {
  let pending, sequence = 0, ended = false;
  channel.binaryType = 'arraybuffer';
  const reject = message => {
    if (!pending) return;
    const current = pending; pending = undefined;
    clearTimeout(current.timer); current.reject(new Error(message));
  };
  const close = () => {
    if (ended) return;
    ended = true; reject('直连心跳已关闭'); channel.close();
  };
  const send = () => {
    if (!pending || channel.readyState !== 'open') return;
    try {
      if (channel.bufferedAmount > 4096) throw new Error();
      const bytes = new ArrayBuffer(4);
      new DataView(bytes).setUint32(0, pending.id);
      channel.send(bytes);
    } catch { close(); }
  };
  channel.addEventListener('open', send);
  channel.addEventListener('close', close);
  channel.addEventListener('error', close);
  channel.addEventListener('message', event => {
    if (ended) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 4) { close(); return; }
    const id = new DataView(event.data).getUint32(0);
    if (!id || id > sequence) { close(); return; }
    // A canceled/backgrounded probe can arrive late; it cannot satisfy a new one.
    if (id !== pending?.id) return;
    const current = pending; pending = undefined;
    clearTimeout(current.timer); current.resolve();
  });
  return {
    close,
    cancel() { reject('直连心跳已取消'); },
    ping() {
      if (ended || pending || channel.readyState === 'closed' || channel.readyState === 'closing' || sequence >= 2147483647) return Promise.reject(new Error('直连心跳不可用'));
      return new Promise((resolve, rejectProbe) => {
        pending = { id: ++sequence, resolve, reject: rejectProbe, timer: setTimeout(() => reject('直连心跳超时'), 2000) };
        send();
      });
    },
  };
}
