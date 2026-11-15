import { FILE_MAX } from './file-wire.js';
import { createUploadPrompt, uploadResult, validTransferName, transferFilePath, quoteFilePath, UPLOAD_PROTOCOL } from './file-upload.js';
import { createFileListReader } from './file-list.js';
import { createFileProgress, observeUploadProgress } from './file-transfer.js';
import { nodeLink } from './node-scope.js';

// One transfer, one directory read, two expiring download URLs. No replay.
export function createWorkbenchFiles({ $, api, action, toast, state, serviceLink, startService, canInsert, canOpenDirectory, insertDraft, openDirectory }) {
  let fileTransferController, filePathCopyBusy = false, filePathGeneration = 0, disposed = false;
  const listeners = [];
  const listen = (element, type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
  function sizeLabel(size) { return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(size / 1024))} KiB`; }
  const fileURLs = new Map();
  const fileProgress = createFileProgress({ panel: $('file-progress'), title: $('file-progress-title'), meter: $('file-progress-meter'), detail: $('file-progress-detail'), cancel: $('cancel-file-transfer') });
  function clearFileURLs() { for (const [url, timer] of fileURLs) { clearTimeout(timer); URL.revokeObjectURL(url); } fileURLs.clear(); }
  function saveDirectFile(blob, name) {
    if (disposed) return;
    while (fileURLs.size >= 2) { const [url, timer] = fileURLs.entries().next().value; clearTimeout(timer); URL.revokeObjectURL(url); fileURLs.delete(url); }
    const url = URL.createObjectURL(blob), timer = setTimeout(() => { URL.revokeObjectURL(url); fileURLs.delete(url); }, 30000); fileURLs.set(url, timer);
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  }
  function renderFiles(files) {
    $('file-list').replaceChildren();
    if (!files.length) {
      const empty = document.createElement('p'); empty.className = 'empty-files'; empty.textContent = '还没有中转文件。上传文件，或在节点主机中把文件放进上方共享目录。'; $('file-list').append(empty);
    }
    for (const file of files) {
      const row = document.createElement('div'); row.className = 'file-row';
      const available = validTransferName(file.name); row.dataset.unavailable = String(!available);
      const detail = document.createElement('span'); detail.textContent = file.name;
      const info = document.createElement('small'); info.textContent = sizeLabel(file.size) + (available ? '' : ' · 文件名无法在网页使用，请在节点主机改名'); detail.append(info);
      const link = document.createElement('a'); if (available) link.href = nodeLink(`/api/files/${encodeURIComponent(file.name)}`); link.textContent = '下载'; link.download = file.name;
      if (!available) link.tabIndex = -1;
      link.addEventListener('click', event => {
        event.preventDefault();
        if (!available) return toast('此文件名无法在网页使用，请先在节点主机改名', true);
        if (!state().loggedIn || state().accessExpired || !navigator.onLine) return toast('文件传输暂不可用，请恢复连接后重试。', true);
        if (file.size > FILE_MAX) {
          if (fileTransferController) return toast('请先完成当前文件传输。');
          $('upload-status').textContent = '大于 50 MiB 的文件由浏览器下载，请在浏览器下载列表查看进度或取消。';
          const nativeLink = document.createElement('a'); nativeLink.href = link.href; nativeLink.download = file.name; document.body.append(nativeLink); nativeLink.click(); nativeLink.remove(); return;
        }
        void downloadFile(file);
      });
      const actions = document.createElement('div'); actions.className = 'file-row-actions';
      const copy = document.createElement('button'); copy.className = 'quiet'; copy.type = 'button'; copy.textContent = '复制路径'; copy.dataset.fileCopy = '';
      copy.setAttribute('aria-label', `复制 ${file.name} 的服务器路径`);
      copy.addEventListener('click', () => void copyFilePath(file.name));
      const insert = document.createElement('button'); insert.className = 'quiet'; insert.type = 'button'; insert.textContent = '加入草稿'; insert.dataset.fileInsert = '';
      insert.setAttribute('aria-label', `将 ${file.name} 的路径加入输入草稿`);
      insert.addEventListener('click', () => insertFilePath(file.name));
      actions.append(link, copy, insert); row.append(detail, actions); $('file-list').append(row);
    }
    renderFileControls();
  }
  function renderFileControls() {
    if (disposed) return;
    const readable = state().loggedIn && !state().accessExpired && navigator.onLine && !!state().directory;
    const insertable = readable && canInsert();
    for (const button of $('file-list').querySelectorAll('[data-file-copy]')) button.disabled = !readable || filePathCopyBusy || button.closest('.file-row').dataset.unavailable === 'true';
    for (const button of $('file-list').querySelectorAll('[data-file-insert]')) { button.hidden = state().temporary; button.disabled = !insertable || button.closest('.file-row').dataset.unavailable === 'true'; }
    $('open-transfer-directory').hidden = state().terminalOnly || state().terminalMode || state().temporary;
    $('open-transfer-directory').disabled = !readable || !canOpenDirectory();
    $('upload-zone').disabled = !state().loggedIn || state().accessExpired || !navigator.onLine || !!fileTransferController;
    $('files-button').setAttribute('aria-busy', String(!!fileTransferController));
    for (const link of $('file-list').querySelectorAll('a')) link.setAttribute('aria-disabled', String(!readable || !!fileTransferController || link.closest('.file-row').dataset.unavailable === 'true'));
  }
  async function copyFilePath(name) {
    if (filePathCopyBusy || !state().loggedIn || state().accessExpired || !$('files-dialog').open) return;
    let path; try { path = transferFilePath(state().directory, name); } catch (error) { return toast(error.message, true); }
    const generation = state().generation, previewGeneration = filePathGeneration;
    filePathCopyBusy = true; $('file-path-fallback').hidden = true; renderFileControls();
    try {
      if (!navigator.clipboard?.writeText) throw Error('clipboard unavailable');
      await navigator.clipboard.writeText(path);
      if (generation === state().generation && previewGeneration === filePathGeneration && state().loggedIn && !state().accessExpired && $('files-dialog').open) $('file-list-status').textContent = '已复制服务器完整路径。';
    } catch {
      if (generation === state().generation && previewGeneration === filePathGeneration && state().loggedIn && !state().accessExpired && $('files-dialog').open) {
        $('file-path-preview').value = path; $('file-path-fallback').hidden = false;
        $('file-path-preview').focus({ preventScroll: true }); $('file-path-preview').select();
      }
    } finally { if (previewGeneration === filePathGeneration) { filePathCopyBusy = false; renderFileControls(); } }
  }
  function insertFilePath(name) {
    if (!canInsert() || !$('files-dialog').open) return;
    try { insertDraft(quoteFilePath(transferFilePath(state().directory, name))); }
    catch (error) { toast(error.message, true); }
  }
  listen($('open-transfer-directory'), 'click', async () => {
    if (!canOpenDirectory()) return;
    const generation = state().generation;
    try {
      const result = await openDirectory();
      if (generation !== state().generation || !state().loggedIn || state().accessExpired || !result) return;
      if (result.ok !== true) throw Error('打开目录的结果未确认，请先查看桌面');
      $('files-dialog').close(); toast('已请求在远程桌面打开共享目录。');
    } catch (error) {
      if (generation === state().generation && state().loggedIn && !state().accessExpired) $('file-list-status').textContent = `${error.message}；不会自动重试。`;
    }
  });
  const fileListReader = createFileListReader({ request: signal => api('/api/files', { signal }),
    valid: () => !disposed && state().loggedIn && !state().accessExpired && navigator.onLine && $('files-dialog').open,
    render: renderFiles, status: text => { $('file-list-status').textContent = text; },
  });
  const loadFiles = signal => fileListReader.read(signal);
  listen($('files-button'), 'click', () => void action($('files-button'), async () => { startService(); $('files-dialog').showModal(); await loadFiles(); }));
  listen($('close-files'), 'click', () => $('files-dialog').close());
  listen($('files-dialog'), 'close', () => { filePathGeneration++; filePathCopyBusy = false; fileListReader.cancel(); $('file-path-preview').value = ''; $('file-path-fallback').hidden = true; $('upload-zone').classList.remove('drag-over'); });
  listen($('upload-zone'), 'click', () => { if (!$('upload-zone').disabled) $('upload-input').click(); });
  listen($('refresh-files'), 'click', () => void action($('refresh-files'), loadFiles));
  const uploadPrompt = createUploadPrompt({
    dialog: $('file-conflict-dialog'), filename: $('file-conflict-name'), detail: $('file-conflict-detail'),
    cancel: $('file-conflict-cancel'), rename: $('file-conflict-rename'), replace: $('file-conflict-replace'),
  }, () => !disposed && state().loggedIn && !state().accessExpired && navigator.onLine, sizeLabel);
  async function uploadFile(file) {
    if (fileTransferController) return toast('请先完成当前文件传输。');
    if (serviceLink.files?.busy) return toast('文件直连正在处理其他下载，请完成后再操作。');
    if (!file || !state().loggedIn || state().accessExpired || !navigator.onLine || !$('files-dialog').open) return;
    if (!validTransferName(file.name, true)) { toast('文件名无效或超过 240 字节，请改名后上传。', true); $('upload-input').value = ''; return; }
    if (file.size > 50 * 1024 * 1024) { toast('文件不能超过 50 MiB', true); $('upload-input').value = ''; return; }
    const generation = state().generation, controller = fileTransferController = new AbortController();
    const progress = fileProgress.start({ name: file.name, size: file.size, direction: 'upload', cancel: () => controller.abort('user') });
    const timer = setTimeout(() => controller.abort(), 300000);
    const current = () => !disposed && fileTransferController === controller && generation === state().generation && state().loggedIn && !state().accessExpired;
    let sending = false, stopProgress = () => {};
    $('upload-input').disabled = true;
    renderFileControls();
    $('upload-status').textContent = `正在检查 ${file.name}…`;
    try {
      const listing = await api('/api/files', { signal: controller.signal });
      if (!current()) return;
      if (listing.uploadProtocol !== UPLOAD_PROTOCOL || !Array.isArray(listing.files)) throw Error('文件服务需要更新后才能安全上传；未发送文件内容');
      const existing = listing.files.find(entry => entry.name === file.name);
      if (existing) progress.phase('等待选择同名文件处理方式…');
      const upload = existing ? await uploadPrompt.ask(file, existing, controller.signal) : { mode: 'create' };
      if (!current()) return;
      if (!upload || controller.signal.aborted) { $('upload-status').textContent = '已取消上传，原文件保留。'; progress.end('已取消，未发送文件内容。'); return; }
      $('upload-status').textContent = `正在上传 ${file.name}…`;
      sending = true;
      const client = serviceLink.files;
      progress.route(client ? 'WebRTC' : 'HTTPS'); progress.progress(0, file.size);
      const report = (loaded, total) => { if (current() && !controller.signal.aborted) progress.progress(loaded, total); };
      let result;
      if (client) result = await client.upload(file, upload, controller.signal, report);
      else {
        const transferId = listing.fileProgressProtocol === 1 ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') : undefined;
        const pending = api(`/api/files/${encodeURIComponent(file.name)}`, { method: 'PUT', raw: file, upload, signal: controller.signal, transferId, progress: report });
        if (transferId) stopProgress = observeUploadProgress(signal => api(`/api/file-progress/${transferId}`, { signal }), report, controller.signal);
        else progress.phase('正在上传；当前后台未提供字节进度。');
        result = await pending;
      }
      stopProgress();
      if (!current()) return;
      const { name } = uploadResult(result);
      $('upload-status').textContent = `上传完成：${name}`;
      progress.end('上传已确认完成。', true);
      try { await loadFiles(controller.signal); } catch { if (current()) $('upload-status').textContent = `上传完成：${name}；列表刷新失败，请手动刷新，不要重复上传。`; }
    } catch (error) {
      progress.end(controller.signal.aborted ? sending ? '上传已中断；请刷新列表核对服务器结果。' : '已取消，未发送文件内容。' : '本次上传未完成，请核对文件列表；不会自动重试。');
      if (current()) $('upload-status').textContent = controller.signal.aborted
        ? sending ? '上传已中断，结果未知；请检查文件状态后手动重试。' : '检查已取消，未上传文件。'
        : `${sending && error.outcome !== 'rejected' && (!error.status || error.outcome === 'unknown') ? '上传结果未确认：' : ''}${error.message}；不会自动重试，请刷新文件列表后重新选择。`;
    } finally {
      stopProgress(); clearTimeout(timer);
      if (fileTransferController === controller) { fileTransferController = undefined; $('upload-input').disabled = false; $('upload-input').value = ''; renderFileControls(); }
    }
  }
  async function downloadFile(file) {
    if (fileTransferController) return toast('请先完成当前文件传输。');
    if (serviceLink.files?.busy) return toast('文件直连正在处理其他下载，请完成后再操作。');
    if (!state().loggedIn || state().accessExpired || !navigator.onLine || !$('files-dialog').open) return;
    const generation = state().generation, controller = fileTransferController = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 300000), client = serviceLink.files;
    const current = () => !disposed && fileTransferController === controller && generation === state().generation && state().loggedIn && !state().accessExpired;
    const progress = fileProgress.start({ name: file.name, size: file.size, direction: 'download', route: client ? 'WebRTC' : 'HTTPS', cancel: () => controller.abort('user') });
    const report = (loaded, total) => { if (current() && !controller.signal.aborted) progress.progress(loaded, total); };
    $('upload-input').disabled = true; renderFileControls(); $('upload-status').textContent = `正在下载 ${file.name}…`;
    try {
      const blob = client ? await client.download(file.name, file.size, controller.signal, report)
        : await api(`/api/files/${encodeURIComponent(file.name)}`, { signal: controller.signal, progress: report, downloadSize: file.size });
      if (!current() || controller.signal.aborted) { progress.end('下载已取消，未生成下载文件。'); return; }
      saveDirectFile(blob, file.name); progress.end('下载完成，已交给浏览器保存。', true); $('upload-status').textContent = `下载完成：${file.name}`;
    } catch (error) {
      progress.end(controller.signal.aborted ? '下载已取消，未生成下载文件。' : '下载未完成，不会自动重试。');
      if (current()) $('upload-status').textContent = controller.signal.aborted ? '下载已中断，未保存不完整文件。' : `${error.message}；请刷新列表后手动重试。`;
    } finally {
      clearTimeout(timer);
      if (fileTransferController === controller) { fileTransferController = undefined; $('upload-input').disabled = false; renderFileControls(); }
    }
  }
  listen($('upload-input'), 'change', () => void uploadFile($('upload-input').files[0]));
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) listen($('files-dialog'), type, event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (type === 'dragleave' && $('files-dialog').contains(event.relatedTarget)) return;
    const active = (type === 'dragenter' || type === 'dragover') && !fileTransferController && state().loggedIn && !state().accessExpired && navigator.onLine;
    $('upload-zone').classList.toggle('drag-over', active);
    if (type !== 'drop') { if (event.dataTransfer) event.dataTransfer.dropEffect = active ? 'copy' : 'none'; return; }
    if (fileTransferController) { toast('当前文件仍在处理中，请完成后再上传。'); return; }
    const items = event.dataTransfer.items, files = event.dataTransfer.files;
    if (files.length !== 1 || items?.length !== 1 || items[0].webkitGetAsEntry?.()?.isDirectory) return toast('每次请拖入一个文件，不支持文件夹。', true);
    void uploadFile(files[0]);
  });

  function reset() {
    filePathGeneration++; filePathCopyBusy = false;
    const controller = fileTransferController; fileTransferController = undefined; controller?.abort();
    uploadPrompt.cancel(); fileListReader.cancel(); clearFileURLs(); fileProgress.clear();
    $('upload-input').disabled = false; $('file-path-preview').value = ''; $('file-path-fallback').hidden = true;
    $('upload-zone').classList.remove('drag-over'); renderFileControls();
  }
  return {
    get busy() { return !!fileTransferController || fileListReader.busy; },
    update: renderFileControls, saveDownload: saveDirectFile, reset,
    revalidate() { fileListReader.revalidate(); uploadPrompt.revalidate(); if (!state().loggedIn || state().accessExpired || !navigator.onLine) fileTransferController?.abort(); },
    suspend() { const pending = !!fileTransferController; reset(); if (pending) $('upload-status').textContent = '页面已离开，传输结果未确认；请刷新列表核对，不会自动重传。'; },
    dispose() { if (disposed) return; disposed = true; reset(); for (const remove of listeners) remove(); uploadPrompt.dispose(); fileProgress.dispose(); $('file-list').replaceChildren(); },
  };
}
