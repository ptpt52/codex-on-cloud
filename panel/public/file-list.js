export const FILE_LIST_TIMEOUT = 8000;
export const FILE_PAGE_LIMITS = Object.freeze({ items: 1000, pageItems: 128, pageBytes: 192 * 1024, pages: 32 });
export const validFilePage = page => typeof page === 'string' && /^(?:1|[a-f0-9]{32}\.[1-9]\d{0,2})$/.test(page);

// One bounded sequence, with no retries. A page failure or cancellation drops
// the partial result. Older panels ignore the query and return a legacy list.
export async function readFilePages(request, signal) {
  let page = '1', first, files = [];
  const flags = ['uploadProtocol', 'deleteProtocol', 'quotaProtocol', 'fileProgressProtocol', 'truncated'];
  for (let count = 0; count < FILE_PAGE_LIMITS.pages; count++) {
    signal?.throwIfAborted();
    const value = await request(page, signal);
    signal?.throwIfAborted();
    if (!Array.isArray(value?.files) || value.files.length > FILE_PAGE_LIMITS.items) throw Error('文件列表响应无效，请手动刷新');
    if (count === 0 && value.filePageProtocol === undefined) return value;
    if (value.filePageProtocol !== 1 || !/^[a-f0-9]{32}$/.test(value.snapshot || '') || !Number.isInteger(value.total) || value.total < 0 || value.total > FILE_PAGE_LIMITS.items ||
        value.offset !== files.length || value.files.length > FILE_PAGE_LIMITS.pageItems || files.length + value.files.length > value.total) throw Error('文件列表分页无效，请手动刷新');
    first ||= value;
    if (value.snapshot !== first.snapshot || value.total !== first.total || flags.some(key => value[key] !== first[key])) throw Error('文件列表已变化，请手动刷新');
    files.push(...value.files);
    if (value.next === null) {
      if (files.length !== value.total) throw Error('文件列表不完整，请手动刷新');
      const { snapshot, offset, total, next, ...listing } = first;
      return { ...listing, files };
    }
    if (!value.files.length || files.length === value.total || value.next !== value.snapshot + '.' + files.length || !validFilePage(value.next)) throw Error('文件列表分页无效，请手动刷新');
    page = value.next;
  }
  throw Error('文件列表分页超过限制，请手动刷新');
}

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
        render(value.files, value);
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
