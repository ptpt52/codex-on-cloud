import { nodeLink } from './node-scope.js';
import { FILE_DOWNLOAD_MAX } from './file-wire.js';
import { validTransferName } from './file-upload.js';

// The browser consumes one transferred block at a time. No Blob, disk cache,
// persistent queue or third-party download worker holds the complete file.
export const DOWNLOAD_SAVE_LIMITS = Object.freeze({ blockBytes: 256 * 1024, prepareMs: 10000, idleMs: 15000 });
export const canStreamDownload = () => window.isSecureContext && !!navigator.serviceWorker && typeof MessageChannel === 'function';
const failure = () => Object.assign(Error('大文件保存不可用或已中断；请检查浏览器下载列表后手动重试，也可选择“HTTPS 下载”'), { code: 'file_save_failed' });
let saving = false, bridge;

export async function createDownloadSink(name, size, signal, cancelled = () => {}) {
  if (!canStreamDownload() || saving || !validTransferName(name) || !Number.isSafeInteger(size) || size < 0 || size > FILE_DOWNLOAD_MAX) throw failure();
  signal?.throwIfAborted(); saving = true;
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const existing = bridge?.isConnected, frame = existing ? bridge : document.createElement('iframe');
  frame.hidden = true; frame.title = '文件下载'; bridge = frame;
  const { port1: port, port2 } = new MessageChannel();
  let ended = false, error, timer, retirement, loaded = 0, block = new Uint8Array(DOWNLOAD_SAVE_LIMITS.blockBytes), used = 0;
  let credit = false, waiting, acknowledged, started, completed;
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; };
  started = deferred(); completed = deferred();
  function cleanup(saved = false) {
    clearTimeout(timer); clearTimeout(retirement); signal?.removeEventListener('abort', cancel); port.close(); block = null; saving = false;
    // Reuse one inert frame for this page. Removing a completed download's
    // initiating frame can interrupt the browser's final save. It retains no
    // port or file data; failures remove it immediately.
    if (saved) frame.contentWindow.postMessage({ type: 'download-release', token }, location.origin);
    else { frame.remove(); if (bridge === frame) bridge = undefined; }
  }
  function abort(reason = failure()) {
    if (ended) return; ended = true; error = reason instanceof Error ? reason : failure();
    try { port.postMessage({ type: 'abort' }); } catch {}
    for (const pending of [started, completed, waiting, acknowledged]) pending?.reject(error);
    // Let the worker consume the abort and error its native response before
    // disentangling the port or removing its originating frame. Bound the
    // handshake even if the worker has already disappeared.
    clearTimeout(timer); retirement = setTimeout(() => cleanup(), 1500);
  }
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { abort(); cancelled(); }, ms); };
  port.onmessage = ({ data }) => {
    if (ended) { if (['error', 'done'].includes(data?.type)) cleanup(); return; }
    if (data?.type === 'ready') frame.contentWindow.postMessage({ type: 'download-save', token }, location.origin);
    else if (data?.type === 'started') { clearTimeout(timer); started.resolve(); }
    else if (data?.type === 'pull') { credit = true; waiting?.resolve(); waiting = undefined; }
    else if (data?.type === 'accepted') { acknowledged?.resolve(); acknowledged = undefined; }
    else if (data?.type === 'done') { completed.resolve(); }
    else { abort(); cleanup(); cancelled(); }
  };
  port.onmessageerror = () => { abort(); cancelled(); };
  const cancel = () => abort(signal?.reason);
  // Keep the listener separate from the public abort method's optional reason.
  signal?.addEventListener('abort', cancel, { once: true });
  const remove = () => signal?.removeEventListener('abort', cancel);
  const connect = () => {
    try { frame.contentWindow.postMessage({ type: 'download-open', token, name, size }, location.origin, [port2]); }
    catch { abort(); }
  };
  if (existing) connect();
  else { frame.addEventListener('load', connect, { once: true }); frame.src = nodeLink('/file-download/bridge.html'); document.body.append(frame); }
  arm(DOWNLOAD_SAVE_LIMITS.prepareMs);
  try { await started.promise; signal?.throwIfAborted(); }
  catch (reason) { remove(); abort(reason); throw reason; }
  async function flush() {
    if (!used) return;
    if (ended) throw error || failure();
    arm(DOWNLOAD_SAVE_LIMITS.idleMs);
    if (!credit) { waiting = deferred(); await waiting.promise; }
    if (ended) throw error || failure(); credit = false;
    acknowledged = deferred(); const received = acknowledged.promise;
    const bytes = used === block.length ? block : block.slice(0, used);
    port.postMessage({ type: 'chunk', bytes: bytes.buffer }, [bytes.buffer]);
    await received; if (ended) throw error || failure(); clearTimeout(timer); used = 0; block = new Uint8Array(DOWNLOAD_SAVE_LIMITS.blockBytes);
  }
  return {
    async write(bytes) {
      if (ended || !(bytes instanceof Uint8Array) || loaded + bytes.length > size) throw error || failure();
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(block.length - used, bytes.length - offset);
        block.set(bytes.subarray(offset, offset + length), used); used += length; offset += length; loaded += length;
        if (used === block.length) await flush();
      }
    },
    async close() {
      if (ended || loaded !== size) throw error || failure();
      await flush(); arm(DOWNLOAD_SAVE_LIMITS.idleMs); port.postMessage({ type: 'end' }); await completed.promise;
      ended = true; remove(); cleanup(true);
    },
    abort(reason) { remove(); abort(reason); },
  };
}
