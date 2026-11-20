import { FILE_MAX, FILE_DOWNLOAD_MAX, createFileBuffer, fileTimeoutCode } from './file-wire.js';

export function transferSize(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1048576).toFixed(1)} MiB`;
}

export function downloadFailure(error, signal) {
  const cancellation = signal?.aborted ? signal.reason : undefined;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const code = cancellation?.code || error?.code;
  if (code === 'file_save_failed' || fileTimeoutCode(code)) return { reason: code, status, outcome: 'unknown' };
  if (signal?.aborted) {
    const reason = ['browser-cancel', 'timeout', 'offline', 'auth', 'page-hidden', 'closed'].includes(cancellation) ? cancellation : 'aborted';
    return { reason, status, outcome: reason === 'timeout' ? 'unknown' : 'canceled' };
  }
  return {
    reason: status ? 'http-status' : 'network',
    status,
    outcome: error?.outcome === 'rejected' || error?.outcome === undefined && status >= 400 && status < 500 && status !== 408
      ? 'rejected' : 'unknown',
  };
}

// One transfer, no filename or payload. Progress events are limited to one per
// five seconds plus the final byte count; the shared debug log owns storage.
export function createUploadTrace(report = () => {}, now = () => performance.now()) {
  let active;
  function emit(type, detail = {}) {
    if (!active) return;
    try { report(type, { route: active.route, ...(active.direction ? { direction: active.direction } : {}), loadedBytes: active.loaded, totalBytes: active.total, durationMs: Math.max(0, Math.round(now() - active.started)), ...active.metrics, ...detail }); } catch { /* Diagnostics cannot stop a transfer. */ }
  }
  return {
    start(route, total, direction = 'upload') {
      if (!['upload', 'download'].includes(direction) || !['https', 'direct'].includes(route) || !Number.isSafeInteger(total) || total < 0 || total > (direction === 'download' ? FILE_DOWNLOAD_MAX : FILE_MAX)) throw Error('文件诊断参数无效');
      active = { route, total, loaded: 0, started: now(), logged: now(), ...(direction === 'download' ? { direction } : {}) }; emit('file-start');
    },
    progress(loaded, total, metrics) {
      if (!active || total !== active.total || !Number.isSafeInteger(loaded) || loaded <= active.loaded || loaded > total) return;
      active.loaded = loaded;
      if (metrics) {
        active.metrics = {};
        for (const key of ['windowChunks', 'chunkAckMs', 'chunkMaxAckMs', 'bufferWaitMs', 'fileReadMs']) if (Number.isInteger(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 2 ** 40) active.metrics[key] = metrics[key];
      }
      if (now() - active.logged >= 5000 || loaded === total) { active.logged = now(); emit('file-progress'); }
    },
    end(reason, status, outcome) { emit('file-ended', { reason, status, outcome }); active = undefined; },
  };
}

// One visible transfer, one paint timer, no queue or retained file contents.
export function createFileProgress({ panel, title, meter, detail, cancel }, now = () => performance.now()) {
  let active, timer, disposed = false;
  const cancelClick = () => { if (!active?.done && !cancel.disabled) { cancel.disabled = true; active.cancel(); } };
  cancel.addEventListener('click', cancelClick);
  function paint() {
    clearTimeout(timer); timer = undefined;
    if (!active) return;
    const entry = active; entry.painted = now();
    title.textContent = `${entry.direction === 'upload' ? '上传' : '下载'}：${entry.name}`;
    if (entry.phase) {
      if (entry.done) meter.value = entry.complete ? 100 : entry.total ? Math.floor(entry.loaded / entry.total * 100) : 0; else meter.removeAttribute('value');
      detail.textContent = entry.complete ? `${entry.route} · ${transferSize(entry.total)} / ${transferSize(entry.total)} · 100% · ${entry.phase}`
        : entry.done ? `${entry.route} · ${transferSize(entry.loaded)} / ${transferSize(entry.total)} · ${entry.phase}` : entry.phase;
    }
    else {
      meter.value = entry.total ? Math.min(100, Math.floor(entry.loaded / entry.total * 100)) : entry.done ? 100 : 0;
      const rate = entry.loaded * 1000 / Math.max(1, now() - entry.started);
      detail.textContent = `${entry.route} · ${transferSize(entry.loaded)} / ${transferSize(entry.total)} · ${Math.floor(meter.value)}% · ${transferSize(Math.round(rate))}/s${!entry.done && entry.loaded === entry.total ? ' · 等待确认' : ''}`;
    }
    cancel.hidden = entry.done; panel.hidden = false;
  }
  return {
    start({ name, size, direction, route = '', cancel: abort }) {
      if (disposed) throw Error('文件进度已关闭');
      clearTimeout(timer);
      const entry = active = { name, total: size, direction, route, cancel: abort, loaded: 0, phase: '正在准备…', started: now(), painted: -Infinity, done: false };
      cancel.disabled = false; paint();
      return {
        phase(text) { if (active !== entry || entry.done) return; entry.phase = text; paint(); },
        progress(loaded, total = size) {
          if (active !== entry || entry.done || !Number.isSafeInteger(loaded) || !Number.isSafeInteger(total) || loaded < entry.loaded || total < loaded || total > (entry.direction === 'download' ? FILE_DOWNLOAD_MAX : FILE_MAX)) return;
          if (entry.phase) entry.started = now();
          entry.phase = ''; entry.loaded = loaded; entry.total = total;
          if (now() - entry.painted >= 150 || loaded === total) paint();
          else if (!timer) timer = setTimeout(paint, 150);
        },
        route(value) { if (active === entry && !entry.done) { entry.route = value; } },
        end(message = '', complete = false) { if (active !== entry) return; entry.done = true; entry.complete = complete; entry.phase = message; paint(); },
      };
    },
    clear() { clearTimeout(timer); active = undefined; panel.hidden = true; title.textContent = detail.textContent = ''; cancel.hidden = true; },
    dispose() { disposed = true; this.clear(); cancel.removeEventListener('click', cancelClick); },
  };
}

// One read-only progress request at a time; the upload itself is never replayed.
export function observeUploadProgress(request, report, signal) {
  let stopped = false, timer, pending;
  const stop = () => { stopped = true; clearTimeout(timer); pending?.abort(); signal?.removeEventListener('abort', stop); };
  async function poll() {
    if (stopped || signal?.aborted) return;
    const controller = pending = new AbortController(), deadline = setTimeout(() => controller.abort(), 2500);
    try {
      const value = await request(controller.signal);
      if (!stopped && !controller.signal.aborted && Number.isSafeInteger(value?.loaded) && Number.isSafeInteger(value.total) && value.loaded >= 0 && value.loaded <= value.total && value.total <= FILE_MAX) report(value.loaded, value.total);
    } catch { /* Missing/late diagnostics never fail or resend the upload. */ }
    finally { clearTimeout(deadline); if (pending === controller) pending = undefined; if (!stopped && !signal?.aborted) timer = setTimeout(poll, 500); }
  }
  signal?.addEventListener('abort', stop, { once: true });
  if (!signal?.aborted) timer = setTimeout(poll, 100); else stop();
  return stop;
}

export async function readFileDownload(response, size, signal, progress, version) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_MAX || !response.body) throw Error('文件大小无效，请刷新列表');
  const declared = response.headers.get('content-length');
  const changed = version !== undefined && response.headers.get('etag') !== '"' + version + '"';
  const wrongSize = declared !== null && Number(declared) !== size;
  if (changed || wrongSize) {
    void response.body.cancel().catch(() => {});
    throw Object.assign(Error(wrongSize ? '文件大小已变化，请刷新列表后重试' : '文件已变化，请刷新列表后重试'), { status: 412, outcome: 'rejected' });
  }
  const reader = response.body.getReader(), buffer = createFileBuffer(size); let loaded = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted(); progress?.(0, size);
    while (true) {
      const value = await reader.read(); signal?.throwIfAborted(); if (value.done) break;
      loaded += value.value.byteLength;
      if (loaded > size || loaded > FILE_MAX) throw Error('文件大小已变化，请刷新列表后重试');
      buffer.append(value.value); progress?.(loaded, size);
    }
    if (loaded !== size) throw Error('文件下载不完整，请手动重试');
    return buffer.blob();
  } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
