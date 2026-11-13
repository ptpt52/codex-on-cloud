// Four bounded in-flight file streams; revocation closes their HTTP bodies as
// well as their upstream requests. Screen ownership never controls a transfer.
export function createFileTransfers({ limit = 4, timeoutMs = 300000, busyStatus = 503, busyMessage = '文件传输繁忙，请稍后重试' } = {}) {
  const active = new Set();
  function revalidate() { for (const entry of active) if (!entry.valid()) entry.abort(); }
  const timer = setInterval(revalidate, 1000).unref();
  return {
    revalidate,
    progress(owner, id) {
      const entry = [...active].find(value => value.progress?.id === id && value.progress.owner === owner);
      if (!entry || !entry.valid()) throw Object.assign(Error('当前上传进度不存在'), { status: 404 });
      return { loaded: entry.progress.loaded, total: entry.progress.size };
    },
    begin(req, res, valid, temporaryUpload = false, progress) {
      if (active.size >= limit || temporaryUpload && [...active].some(entry => entry.temporaryUpload)) throw Object.assign(Error(busyMessage), { status: busyStatus });
      if (progress && (!/^[a-f0-9]{32}$/.test(progress.id || '') || typeof progress.owner !== 'string' || !progress.owner || !Number.isSafeInteger(progress.size) || progress.size < 0 || progress.size > 50 * 1024 * 1024)) throw Object.assign(Error('上传进度参数无效'), { status: 400 });
      if (progress && [...active].some(entry => entry.progress?.id === progress.id)) throw Object.assign(Error('上传标识正在使用'), { status: 409 });
      const controller = new AbortController();
      const entry = { valid, temporaryUpload, ...(progress ? { progress: { ...progress, loaded: 0 } } : {}), abort() { finish(); res.destroy(); } };
      const timer = setTimeout(() => entry.abort(), timeoutMs).unref();
      active.add(entry);
      const finish = () => { clearTimeout(timer); active.delete(entry); controller.abort(); req.off('aborted', finish); res.off('close', finish); };
      req.once('aborted', finish); res.once('close', finish);
      return { signal: controller.signal, finish,
        advance(bytes) { if (!entry.progress || !active.has(entry)) return; if (!Number.isSafeInteger(bytes) || bytes < 0 || entry.progress.loaded + bytes > entry.progress.size) throw Error('上传大小超过声明范围'); entry.progress.loaded += bytes; },
        check() { if (!valid() || res.destroyed) throw Object.assign(Error('登录授权已失效，文件传输已取消'), { status: 401 }); } };
    },
    close() { clearInterval(timer); for (const entry of active) entry.abort(); },
  };
}
