// Four bounded in-flight file streams; revocation closes their HTTP bodies as
// well as their upstream requests. Screen ownership never controls a transfer.
export function createFileTransfers({ limit = 4, maxDownloads = limit, timeoutMs = 300000, downloadTimeoutMs = timeoutMs, downloadIdleMs = 0, busyStatus = 503, busyMessage = '文件传输繁忙，请稍后重试' } = {}) {
  if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1 || downloadTimeoutMs > 1800000) throw Error('文件下载期限无效');
  if (!Number.isSafeInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > limit ||
      !Number.isSafeInteger(downloadIdleMs) || downloadIdleMs < 0 || downloadIdleMs > downloadTimeoutMs) throw Error('文件下载名额或空闲期限无效');
  const active = new Set();
  function revalidate() {
    const now = Date.now();
    for (const entry of active) {
      if (entry.signal.aborted) continue;
      if (!entry.valid()) entry.abort();
      else if (entry.download && downloadIdleMs && now - entry.lastProgressAt >= downloadIdleMs) entry.expireIdle();
    }
  }
  const timer = setInterval(revalidate, 1000).unref();
  return {
    revalidate,
    progress(owner, id) {
      const entry = [...active].find(value => value.progress?.id === id && value.progress.owner === owner);
      if (!entry || entry.signal.aborted || !entry.valid()) throw Object.assign(Error('当前上传进度不存在'), { status: 404 });
      return { loaded: entry.progress.loaded, total: entry.progress.size };
    },
    begin(req, res, valid, temporaryUpload = false, progress) {
      const download = req.method === 'GET';
      if (active.size >= limit || download && [...active].filter(entry => entry.download).length >= maxDownloads ||
          temporaryUpload && [...active].some(entry => entry.temporaryUpload)) throw Object.assign(Error(busyMessage), { status: busyStatus });
      if (progress && (!/^[a-f0-9]{32}$/.test(progress.id || '') || typeof progress.owner !== 'string' || !progress.owner || !Number.isSafeInteger(progress.size) || progress.size < 0 || progress.size > 50 * 1024 * 1024)) throw Object.assign(Error('上传进度参数无效'), { status: 400 });
      if (progress && [...active].some(entry => entry.progress?.id === progress.id)) throw Object.assign(Error('上传标识正在使用'), { status: 409 });
      const controller = new AbortController();
      const started = Date.now();
      let dispatched = false, extended = false;
      const cancel = () => controller.abort();
      const entry = {
        valid, signal: controller.signal, download, lastProgressAt: started, temporaryUpload,
        ...(progress ? { progress: { ...progress, loaded: 0 } } : {}),
        abort() { cancel(); res.destroy(); },
        expireIdle() {
          if (res.writableFinished) return;
          controller.abort(Object.assign(Error('文件下载长时间没有数据，请手动重试'), { status: 408, outcome: 'unknown' }));
          if (res.headersSent) res.destroy();
        },
        finish,
      };
      // Keep the slot through cancellation until the handler's finally has
      // unwound its upstream work. The original deadline still bounds cleanup.
      const expire = () => { entry.abort(); finish(); };
      let deadline = setTimeout(expire, timeoutMs).unref();
      active.add(entry);
      function finish() { clearTimeout(deadline); active.delete(entry); cancel(); req.off('aborted', cancel); res.off('close', cancel); }
      function check() {
        if (controller.signal.aborted && controller.signal.reason?.status === 408) throw controller.signal.reason;
        if (controller.signal.aborted || !valid() || res.destroyed) throw Object.assign(Error(dispatched ? '登录授权已失效，文件操作结果未知；请重新登录后核对' : '登录授权已失效，文件操作未发送'), { status: 401, outcome: dispatched ? 'unknown' : 'rejected' });
      }
      req.once('aborted', cancel); res.once('close', cancel);
      if (req.aborted || res.destroyed) entry.abort();
      return { signal: controller.signal, finish,
        extendDownloadDeadline() {
          if (!download || extended || controller.signal.aborted || downloadTimeoutMs <= timeoutMs) return;
          extended = true;
          clearTimeout(deadline);
          deadline = setTimeout(expire, Math.max(0, downloadTimeoutMs - (Date.now() - started))).unref();
        },
        downloadProgress() { entry.lastProgressAt = Date.now(); },
        // A later authorization failure cannot undo an admitted upload/delete.
        // Mark immediately before the sole upstream mutation, never preflight.
        dispatch() { check(); dispatched = true; },
        advance(bytes) { if (!entry.progress || controller.signal.aborted || !active.has(entry)) return; if (!Number.isSafeInteger(bytes) || bytes < 0 || entry.progress.loaded + bytes > entry.progress.size) throw Error('上传大小超过声明范围'); entry.progress.loaded += bytes; },
        check };
    },
    close() { clearInterval(timer); for (const entry of active) { entry.abort(); entry.finish(); } },
  };
}
