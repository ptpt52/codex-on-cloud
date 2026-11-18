export const UPLOAD_PROTOCOL = 1;
export const FILE_DELETE_PROTOCOL = 1;
export const UPLOAD_CONFIRM_MS = 120000;
// A file HTTP failure can retire its channel while authenticated controls live.
// Authentication, lock and malformed-protocol failures remain peer-fatal.
export const recoverableFileStatus = status => Number.isInteger(status) &&
  ([404, 408, 409, 410, 412, 413, 429].includes(status) || status >= 500 && status <= 599);
// Existing Unix files may use the full NAME_MAX and literal backslashes.
// New uploads keep space for a rename suffix and portable names.
export function validTransferName(name, upload = false) {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || name.startsWith('.upload-') || /[/\x00-\x1f\x7f]/.test(name) || upload && name.includes('\\')) return false;
  const bytes = new TextEncoder().encode(name);
  return bytes.length <= (upload ? 240 : 255) && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === name;
}
export function transferFilePath(directory, name) {
  if (typeof directory !== 'string' || !directory.startsWith('/') || /[\x00-\x1f\x7f]/.test(directory) || new TextEncoder().encode(directory).length > 4096) throw Error('服务器共享目录尚未就绪，请刷新后重试');
  if (!validTransferName(name)) throw Error('此文件名无法在网页使用，请先在节点主机改名');
  return directory.replace(/\/+$/, '') + '/' + name;
}
export const quoteFilePath = path => "'" + path.replaceAll("'", "'\\''") + "'";
export function uploadResult(value) {
  if (!value || value.ok !== true || !validTransferName(value.name, true)) {
    throw Object.assign(Error('上传完成信息不完整，结果未知；请刷新文件列表确认'), { status: 502, outcome: 'unknown' });
  }
  return value;
}
const invalid = message => Object.assign(Error(message || '上传处理方式无效'), { status: 400, outcome: 'rejected' });
export function fileDeleteOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'name,version' || !validTransferName(value.name) || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version)) throw invalid('删除文件需要有效的文件名和原文件版本');
  return { name: value.name, version: value.version };
}
export function fileDeleteResult(value, name) {
  if (!value || value.ok !== true || value.name !== name) throw Object.assign(Error('删除结果未确认，请刷新文件列表核对'), { status: 502, outcome: 'unknown' });
  return value;
}
export function uploadOptions(value = { mode: 'create' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = Object.keys(value).sort().join(',');
  if (value.mode === 'replace') {
    if (keys !== 'mode,version' || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version)) throw invalid('替换文件需要有效的原文件版本');
    return { mode: 'replace', version: value.version };
  }
  if (keys !== 'mode' || !['create', 'rename'].includes(value.mode)) throw invalid();
  return { mode: value.mode };
}
export function uploadHeaders(value) {
  const options = uploadOptions(value);
  return { 'x-codex-upload-mode': options.mode, ...(options.mode === 'replace' ? { 'if-match': '"' + options.version + '"' } : options.mode === 'create' ? { 'if-none-match': '*' } : {}) };
}
export function readUploadHeaders(headers) {
  const mode = headers['x-codex-upload-mode'] ?? 'create', match = headers['if-match'], absent = headers['if-none-match'];
  if (mode === 'replace') {
    if (absent !== undefined || typeof match !== 'string' || !/^"[a-f0-9]{64}"$/.test(match)) throw invalid('替换文件需要有效的原文件版本');
    return uploadOptions({ mode, version: match.slice(1, -1) });
  }
  if (match !== undefined || mode === 'rename' && absent !== undefined || absent !== undefined && absent !== '*') throw invalid();
  return uploadOptions({ mode });
}

// One pending decision, one metadata snapshot. The caller retains at most one
// already-bounded File (50 MiB). No bytes are read/sent before this resolves.
export function createUploadPrompt({ dialog, filename, detail, cancel, rename, replace }, valid, sizeLabel = String) {
  let pending, disposed = false;
  const listeners = [];
  const listen = (element, type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
  function finish(value, error) {
    if (!pending) return;
    const entry = pending; pending = undefined; clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    dialog.close(); filename.textContent = detail.textContent = '';
    error ? entry.reject(error) : entry.resolve(value && valid() ? value : null);
  }
  listen(cancel, 'click', () => finish(null));
  listen(rename, 'click', () => finish({ mode: 'rename' }));
  listen(replace, 'click', () => finish(pending ? { mode: 'replace', version: pending.version } : null));
  listen(dialog, 'cancel', event => { event.preventDefault(); finish(null); });
  listen(dialog, 'close', () => { if (!dialog.open) finish(null); });
  const revalidate = () => { if (pending && !valid()) finish(null); };
  listen(window, 'offline', revalidate);
  listen(window, 'pagehide', () => finish(null));
  return {
    revalidate, cancel: () => finish(null),
    dispose() { if (disposed) return; disposed = true; finish(null); for (const remove of listeners) remove(); },
    ask(file, existing, signal) {
      if (disposed || pending || !valid() || signal?.aborted) return Promise.reject(invalid('当前不能确认上传，请重新选择文件'));
      let options; try { options = uploadOptions({ mode: 'replace', version: existing.version }); } catch { return Promise.reject(invalid('原文件缺少版本信息，请更新文件服务后重试')); }
      filename.textContent = file.name;
      detail.textContent = `原文件 ${sizeLabel(existing.size)}，新文件 ${sizeLabel(file.size)}。替换会覆盖原内容；自动改名会保留两份文件。`;
      return new Promise((resolve, reject) => {
        const abort = () => finish(null);
        pending = { resolve, reject, signal, abort, version: options.version, timer: setTimeout(() => finish(null, invalid('上传确认已过期，请重新选择文件')), UPLOAD_CONFIRM_MS) };
        signal?.addEventListener('abort', abort, { once: true });
        try { dialog.showModal(); cancel.focus(); } catch (error) { finish(null, error); }
      });
    },
  };
}
