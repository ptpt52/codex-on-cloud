export const FILE_CHUNK = 16380;
export const FILE_MAX = 50 * 1024 * 1024;
const WINDOW = 4;
// One ordered stream in each direction, four acknowledged chunks in flight.
// Sequence numbers last for the channel, so old chunks/ACKs cannot be replayed.
export function createFileWire(channel, { control, chunk, failed }) {
  let ended = false, sent = 0, received = 0, queued = 0, chain = Promise.resolve();
  const pending = new Map();
  channel.binaryType = 'arraybuffer';
  const failure = message => Object.assign(Error(message || '文件直连已断开；请检查文件状态后手动重试'), { outcome: 'unknown' });
  function close(reason = failure()) {
    if (ended) return; ended = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(reason); } pending.clear();
    channel.close(); failed(reason);
  }
  function send(value) {
    const text = JSON.stringify(value);
    const size = new TextEncoder().encode(text).length;
    if (ended || channel.readyState !== 'open' || size > 4096 || channel.bufferedAmount + size > 256 * 1024) throw failure();
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
      if (!bytes || bytes.length < 5 || bytes.length > FILE_CHUNK + 4 || queued >= WINDOW) throw failure('文件分块大小或窗口无效');
      const seq = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
      if (seq !== received + 1 || seq > 2147483647) throw failure('文件分块序号无效'); received = seq; queued++;
      chain = chain.then(async () => { if (ended) return; await chunk(bytes.subarray(4)); if (!ended) send({type:'ack',seq}); }).catch(close).finally(() => { queued--; });
    } catch (err) { close(err); }
  });
  channel.addEventListener('close', () => close()); channel.addEventListener('error', () => close());
  return { close, send, get ready() { return !ended && channel.readyState === 'open'; },
    data(bytes) {
      if (ended || channel.readyState !== 'open' || !bytes.length || bytes.length > FILE_CHUNK || pending.size >= WINDOW || sent >= 2147483647 || channel.bufferedAmount + bytes.length + 4 > 256 * 1024) return Promise.reject(failure('文件发送窗口暂不可用'));
      const seq=++sent, frame=new Uint8Array(bytes.length+4);new DataView(frame.buffer).setUint32(0,seq);frame.set(bytes,4);
      return new Promise((resolve,reject)=>{
        pending.set(seq,{resolve,reject,timer:setTimeout(()=>close(failure('文件分块确认超时')),15000)});
        try{channel.send(frame);}catch(err){close(err);}
      });
    },
  };
}
export async function sendFileChunks(source, wire, valid = () => true) {
  const pending=[];
  for await(const bytes of source) for(let offset=0;offset<bytes.length;offset+=FILE_CHUNK){
    if(!valid())throw Error('文件传输已取消');
    if(pending.length===WINDOW)await pending.shift();
    const sent=wire.data(bytes.subarray(offset,offset+FILE_CHUNK));void sent.catch(()=>{});pending.push(sent);
  }
  await Promise.all(pending);
}
