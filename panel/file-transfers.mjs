// Four bounded in-flight file streams; revocation closes their HTTP bodies as
// well as their upstream requests. Screen ownership never controls a transfer.
export function createFileTransfers() {
  const active = new Set();
  function revalidate() { for (const entry of active) if (!entry.valid()) entry.abort(); }
  const timer = setInterval(revalidate, 1000).unref();
  return {
    revalidate,
    begin(req, res, valid, temporaryUpload = false) {
      if (active.size >= 4 || temporaryUpload && [...active].some(entry => entry.temporaryUpload)) throw Object.assign(Error('文件传输繁忙，请稍后重试'), { status: 503 });
      const controller = new AbortController();
      const entry = { valid, temporaryUpload, abort() { controller.abort(); active.delete(entry); res.destroy(); } };
      active.add(entry);
      const finish = () => { active.delete(entry); controller.abort(); };
      req.once('aborted', finish); res.once('close', finish);
      return { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]), finish,
        check() { if (!valid() || res.destroyed) throw Object.assign(Error('登录授权已失效，文件传输已取消'), { status: 401 }); } };
    },
    close() { clearInterval(timer); for (const entry of active) entry.abort(); },
  };
}
