// Four bounded in-flight file streams; revocation closes their HTTP bodies as
// well as their upstream requests. Screen ownership never controls a transfer.
export function createFileTransfers({ limit = 4, timeoutMs = 300000, busyStatus = 503, busyMessage = '文件传输繁忙，请稍后重试' } = {}) {
  const active = new Set();
  function revalidate() { for (const entry of active) if (!entry.valid()) entry.abort(); }
  const timer = setInterval(revalidate, 1000).unref();
  return {
    revalidate,
    begin(req, res, valid, temporaryUpload = false) {
      if (active.size >= limit || temporaryUpload && [...active].some(entry => entry.temporaryUpload)) throw Object.assign(Error(busyMessage), { status: busyStatus });
      const controller = new AbortController();
      const entry = { valid, temporaryUpload, abort() { finish(); res.destroy(); } };
      const timer = setTimeout(() => entry.abort(), timeoutMs).unref();
      active.add(entry);
      const finish = () => { clearTimeout(timer); active.delete(entry); controller.abort(); req.off('aborted', finish); res.off('close', finish); };
      req.once('aborted', finish); res.once('close', finish);
      return { signal: controller.signal, finish,
        check() { if (!valid() || res.destroyed) throw Object.assign(Error('登录授权已失效，文件传输已取消'), { status: 401 }); } };
    },
    close() { clearInterval(timer); for (const entry of active) entry.abort(); },
  };
}
