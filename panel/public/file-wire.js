import { LEGACY_TRANSFER_WINDOW, validTransferWindow } from './transfer-window.js';
export const FILE_CHUNK = 16380;
export const FILE_MAX = 50 * 1024 * 1024;
const BUFFER = 512 * 1024;
const DATA_BUFFER = BUFFER - 4096; // Keep one maximum control message available.
// Coalesce arbitrarily small network reads into at most 800 blocks (50 MiB).
export function createFileBuffer(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_MAX) throw Error('文件大小无效');
  const parts = []; let loaded = 0, block, used = 0;
  return {
    append(bytes) {
      if (!(bytes instanceof Uint8Array) || loaded + bytes.length > size) throw Error('文件大小已变化，请刷新列表');
      for (let offset = 0; offset < bytes.length;) {
        if (!block || used === block.length) { block = new Uint8Array(Math.min(65536, size - loaded)); parts.push(block); used = 0; }
        const length = Math.min(block.length - used, bytes.length - offset);
        block.set(bytes.subarray(offset, offset + length), used); offset += length; loaded += length; used += length;
      }
    },
    blob() { if (loaded !== size) throw Error('文件下载不完整，请手动重试'); return new Blob(parts, { type: 'application/octet-stream' }); },
  };
}
// One ordered stream in each direction, with a negotiated 4/8/16-chunk window.
// Sequence numbers last for the channel, so old chunks/ACKs cannot be replayed.
export function createFileWire(channel, { control, chunk, failed }) {
  let ended = false, sent = 0, received = 0, queued = 0, chain = Promise.resolve(), window = LEGACY_TRANSFER_WINDOW, writable;
  const pending = new Map();
  channel.binaryType = 'arraybuffer';
  const failure = message => Object.assign(Error(message || '文件直连已断开；请检查文件状态后手动重试'), { outcome: 'unknown' });
  function finishWritable(error) {
    if (!writable) return;
    const entry = writable; writable = undefined; clearTimeout(entry.timer); clearTimeout(entry.deadline);
    error ? entry.reject(error) : entry.resolve();
  }
  function checkWritable() {
    if (!writable) return;
    clearTimeout(writable.timer);
    if (ended || channel.readyState !== 'open') { finishWritable(failure()); return; }
    if (channel.bufferedAmount + writable.length + 4 <= DATA_BUFFER) { finishWritable(); return; }
    // Native adapters may not expose bufferedamountlow; retain one bounded poll.
    writable.timer = setTimeout(checkWritable, 25);
  }
  channel.bufferedAmountLowThreshold = BUFFER / 2;
  channel.addEventListener('bufferedamountlow', checkWritable);
  function close(reason = failure()) {
    if (ended) return; ended = true;
    finishWritable(reason);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(reason); } pending.clear();
    channel.close(); failed(reason);
  }
  function send(value) {
    const text = JSON.stringify(value);
    const size = new TextEncoder().encode(text).length;
    if (ended || channel.readyState !== 'open' || size > 4096 || channel.bufferedAmount + size > BUFFER) throw failure();
    channel.send(text);
  }
  channel.addEventListener('message', event => {
    if (ended) return;
    try {
      if (typeof event.data === 'string') {
        if (event.data.length > 4096 || new TextEncoder().encode(event.data).length > 4096) throw failure('文件消息过大');
        const value = JSON.parse(event.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('文件消息格式无效');
        if (value.type === 'ack') {
          if (Object.keys(value).sort().join(',') !== 'seq,type' || !pending.size || pending.keys().next().value !== value.seq) throw failure('文件确认序号无效');
          const item = pending.get(value.seq); pending.delete(value.seq); clearTimeout(item.timer); item.resolve();
        } else Promise.resolve(control(value)).catch(close);
        return;
      }
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : ArrayBuffer.isView(event.data) ? new Uint8Array(event.data.buffer,event.data.byteOffset,event.data.byteLength) : null;
      if (!bytes || bytes.length < 5 || bytes.length > FILE_CHUNK + 4 || queued >= window) throw failure('文件分块大小或窗口无效');
      const seq = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
      if (seq !== received + 1 || seq > 2147483647) throw failure('文件分块序号无效'); received = seq; queued++;
      chain = chain.then(async () => { if (ended) return; await chunk(bytes.subarray(4)); if (!ended) send({type:'ack',seq}); }).catch(close).finally(() => { queued--; });
    } catch (err) { close(err); }
  });
  channel.addEventListener('close', () => close()); channel.addEventListener('error', () => close());
  return { close, send, get ready() { return !ended && channel.readyState === 'open'; }, get window() { return window; },
    setWindow(value) {
      if (!validTransferWindow(value) || ended || value !== window && (pending.size || queued)) throw failure('文件窗口协商无效');
      window = value;
    },
    waitWritable(length) {
      if (ended || channel.readyState !== 'open' || writable || !Number.isInteger(length) || length <= 0 || length > FILE_CHUNK) return Promise.reject(failure('文件发送窗口暂不可用'));
      if (channel.bufferedAmount + length + 4 <= DATA_BUFFER) return Promise.resolve();
      return new Promise((resolve, reject) => {
        writable = { length, resolve, reject, deadline: setTimeout(() => close(failure('文件发送缓冲等待超时')), 15000) };
        checkWritable();
      });
    },
    data(bytes) {
      if (ended || channel.readyState !== 'open' || !bytes.length || bytes.length > FILE_CHUNK || pending.size >= window || sent >= 2147483647 || channel.bufferedAmount + bytes.length + 4 > DATA_BUFFER) return Promise.reject(failure('文件发送窗口暂不可用'));
      const seq=++sent, frame=new Uint8Array(bytes.length+4);new DataView(frame.buffer).setUint32(0,seq);frame.set(bytes,4);
      return new Promise((resolve,reject)=>{
        pending.set(seq,{resolve,reject,timer:setTimeout(()=>close(failure('文件分块确认超时')),15000)});
        try{channel.send(frame);}catch(err){close(err);}
      });
    },
  };
}
export async function sendFileChunks(source, wire, valid = () => true, progress) {
  const pending=[];
  for await(const bytes of source) for(let offset=0;offset<bytes.length;offset+=FILE_CHUNK){
    if(!valid())throw Error('文件传输已取消');
    if(pending.length===(wire.window || LEGACY_TRANSFER_WINDOW))await pending.shift();
    const part=bytes.subarray(offset,offset+FILE_CHUNK);
    if(wire.waitWritable)await wire.waitWritable(part.length);
    if(!valid())throw Error('文件传输已取消');
    const result=wire.data(part);
    const sent=progress?result.then(()=>{if(valid())progress(part.length);}):result;void sent.catch(()=>{});pending.push(sent);
  }
  await Promise.all(pending);
}
