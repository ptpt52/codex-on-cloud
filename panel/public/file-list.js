export const FILE_LIST_TIMEOUT = 8000;

// One active metadata read. Closing, logout and a newer read cancel the old
// request; an upload itself has a separate lifetime and is never replayed.
export function createFileListReader({ request, valid, render, status }) {
  let pending;
  function cancel(reason = 'closed') {
    const entry = pending; pending = undefined;
    if (entry) { entry.reason = reason; entry.controller.abort(); }
    status('');
  }
  return {
    get busy() { return !!pending; },
    cancel,
    revalidate() { if (pending && !valid()) cancel('access'); },
    async read(signal) {
      cancel('superseded');
      if (!valid() || signal?.aborted) return;
      const controller = new AbortController(), entry = pending = { controller, reason: '' };
      const abort = () => { entry.reason = 'caller'; controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { entry.reason = 'timeout'; controller.abort(); }, FILE_LIST_TIMEOUT);
      let canceled;
      const stopped = new Promise((_, reject) => { canceled = () => reject(Error('文件列表读取已取消')); controller.signal.addEventListener('abort', canceled, { once: true }); });
      status('正在读取文件列表…');
      try {
        const value = await Promise.race([request(controller.signal), stopped]);
        if (pending !== entry || !valid()) return;
        if (controller.signal.aborted) throw Error('文件列表读取已取消');
        if (!Array.isArray(value?.files) || value.files.length > 1000) throw Error('文件列表响应无效，请手动刷新');
        render(value.files);
        status(value.truncated ? '仅展示部分文件；目录超过核算范围，临时上传已暂停。' : '');
      } catch (error) {
        if (pending !== entry || !valid()) return;
        const message = entry.reason === 'timeout' ? '读取文件列表超时，请点击刷新重试。' : entry.reason === 'caller' ? '文件列表读取已取消，请手动刷新。' : error.message;
        status(message); throw Error(message);
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', canceled);
        if (pending === entry) pending = undefined;
      }
    },
  };
}
