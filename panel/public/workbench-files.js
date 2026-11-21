import { FILE_MAX, FILE_DOWNLOAD_TIMEOUT, fileTimeoutCode } from './file-wire.js';
import { canStreamDownload, createDownloadSink } from './file-download.js';
import { createUploadPrompt, uploadResult, validTransferName, validFileVersion, fileDownloadPath, transferFilePath, quoteFilePath, UPLOAD_PROTOCOL, FILE_DELETE_PROTOCOL, fileDeleteOptions, fileDeleteResult } from './file-upload.js';
import { createFileListReader, readFilePages } from './file-list.js';
import { createFileProgress, observeUploadProgress, createUploadTrace, downloadFailure } from './file-transfer.js';
import { nodeLink } from './node-scope.js';

// One transfer or deletion, one directory read, two expiring download URLs. No replay.
export function createWorkbenchFiles({ $, api, action, toast, state, serviceLink, startService, canInsert, canOpenDirectory, insertDraft, openDirectory, trace, changed = () => {} }) {
  let fileTransferController, fileTransferPath, fileDeletion, deleteSupported = false, filePathCopyBusy = false, filePathGeneration = 0, disposed = false;
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
      const link = document.createElement('a'); if (available) link.href = nodeLink(fileDownloadPath(file.name, file.version)); link.textContent = '下载'; link.download = file.name;
      link.setAttribute('aria-label', `下载 ${file.name}`);
      if (!available) link.tabIndex = -1;
      link.addEventListener('click', event => {
        event.preventDefault();
        if (!available) return toast('此文件名无法在网页使用，请先在节点主机改名', true);
        if (!state().loggedIn || state().accessExpired || !navigator.onLine) return toast('文件传输暂不可用，请恢复连接后重试。', true);
        void downloadFile(file);
      });
      const actions = document.createElement('div'); actions.className = 'file-row-actions';
      const copy = document.createElement('button'); copy.className = 'quiet'; copy.type = 'button'; copy.textContent = '复制路径'; copy.dataset.fileCopy = '';
      copy.setAttribute('aria-label', `复制 ${file.name} 的服务器路径`);
      copy.addEventListener('click', () => void copyFilePath(file.name));
      const insert = document.createElement('button'); insert.className = 'quiet'; insert.type = 'button'; insert.textContent = '加入草稿'; insert.dataset.fileInsert = '';
      insert.setAttribute('aria-label', `将 ${file.name} 的路径加入输入草稿`);
      insert.addEventListener('click', () => insertFilePath(file.name));
      const remove = document.createElement('button'); remove.className = 'quiet interrupt-key'; remove.type = 'button'; remove.textContent = '删除'; remove.dataset.fileDelete = '';
      remove.setAttribute('aria-label', `删除 ${file.name}`);
      try { fileDeleteOptions({ name: file.name, version: file.version }); } catch { remove.dataset.unavailable = 'true'; }
      remove.addEventListener('click', () => void deleteFile(file, remove));
      actions.append(link);
      if (file.size > FILE_MAX && available) {
        const fallback = document.createElement('a'); fallback.href = link.href; fallback.download = file.name; fallback.textContent = 'HTTPS 下载';
        fallback.setAttribute('aria-label', `HTTPS 下载 ${file.name}`);
        fallback.addEventListener('click', event => {
          event.preventDefault();
          if (!state().loggedIn || state().accessExpired || !navigator.onLine || fileTransferController || fileDeletion) return toast('请先完成当前文件操作并恢复连接。');
          nativeDownload(file);
        });
        actions.append(fallback);
      }
      actions.append(copy, insert, remove); row.append(detail, actions); $('file-list').append(row);
    }
    renderFileControls();
  }
  function renderFileControls() {
    if (disposed) return;
    const readable = state().loggedIn && !state().accessExpired && navigator.onLine && !!state().directory;
    const insertable = readable && canInsert();
    for (const button of $('file-list').querySelectorAll('[data-file-copy]')) {
      button.disabled = !readable || button.closest('.file-row').dataset.unavailable === 'true';
      button.setAttribute('aria-disabled', String(button.disabled || filePathCopyBusy));
    }
    for (const button of $('file-list').querySelectorAll('[data-file-insert]')) { button.hidden = state().temporary; button.disabled = !insertable || button.closest('.file-row').dataset.unavailable === 'true'; }
    for (const button of $('file-list').querySelectorAll('[data-file-delete]')) {
      button.hidden = state().temporary;
      button.disabled = !readable || state().temporary || !deleteSupported || !!fileTransferController || !!fileDeletion || button.dataset.unavailable === 'true';
      button.title = !deleteSupported ? '文件服务需要更新后才能删除文件' : '';
    }
    $('open-transfer-directory').hidden = state().terminalOnly || state().terminalMode || state().temporary;
    $('open-transfer-directory').disabled = !readable || !canOpenDirectory();
    $('upload-zone').disabled = !state().loggedIn || state().accessExpired || !navigator.onLine || !!fileTransferController || !!fileDeletion;
    $('upload-input').disabled = $('upload-zone').disabled;
    $('files-button').setAttribute('aria-busy', String(!!fileTransferController || !!fileDeletion));
    for (const link of $('file-list').querySelectorAll('a')) link.setAttribute('aria-disabled', String(!readable || !!fileTransferController || !!fileDeletion || link.closest('.file-row').dataset.unavailable === 'true'));
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
  const readFiles = signal => readFilePages((page, signal) => api('/api/files?page=' + page, { signal }), signal, trace);
  const fileListReader = createFileListReader({ request: readFiles,
    valid: () => !disposed && state().loggedIn && !state().accessExpired && navigator.onLine && $('files-dialog').open,
    render: (files, listing) => { deleteSupported = listing.deleteProtocol === FILE_DELETE_PROTOCOL; renderFiles(files); }, status: text => { $('file-list-status').textContent = text; },
  });
  const loadFiles = signal => fileListReader.read(signal);
  listen($('files-button'), 'click', () => void action($('files-button'), async () => { startService(); $('files-dialog').showModal(); await loadFiles(); }));
  listen($('close-files'), 'click', () => $('files-dialog').close());
  listen($('files-dialog'), 'close', () => { if (!fileDeletion?.sent) finishDeleteConfirmation(false); filePathGeneration++; filePathCopyBusy = false; fileListReader.cancel(); $('file-path-preview').value = ''; $('file-path-fallback').hidden = true; $('upload-zone').classList.remove('drag-over'); });
  listen($('upload-zone'), 'click', () => { if (!$('upload-zone').disabled) $('upload-input').click(); });
  const refresh = $('refresh-files');
  listen(refresh, 'click', async () => {
    if (fileListReader.busy || !$('files-dialog').open) return;
    refresh.setAttribute('aria-disabled', 'true');
    try { await loadFiles(); }
    catch { /* The file list displays the read error. */ }
    finally { refresh.removeAttribute('aria-disabled'); }
  });
  const uploadPrompt = createUploadPrompt({
    dialog: $('file-conflict-dialog'), filename: $('file-conflict-name'), detail: $('file-conflict-detail'),
    cancel: $('file-conflict-cancel'), rename: $('file-conflict-rename'), replace: $('file-conflict-replace'),
  }, () => !disposed && state().loggedIn && !state().accessExpired && navigator.onLine, sizeLabel);
  function finishDeleteConfirmation(confirmed) {
    const entry = fileDeletion;
    if (!entry?.resolve) return;
    const resolve = entry.resolve; entry.resolve = undefined; clearTimeout(entry.timer);
    $('file-delete-dialog').close(); $('file-delete-name').textContent = '';
    resolve(confirmed);
  }
  listen($('file-delete-cancel'), 'click', () => finishDeleteConfirmation(false));
  listen($('file-delete-confirm'), 'click', () => finishDeleteConfirmation(true));
  listen($('file-delete-dialog'), 'cancel', event => { event.preventDefault(); finishDeleteConfirmation(false); });
  listen($('file-delete-dialog'), 'close', () => { if (!$('file-delete-dialog').open) finishDeleteConfirmation(false); });
  listen($('file-delete-dialog'), 'keydown', event => {
    if (event.key === 'Enter' && event.target !== $('file-delete-confirm')) { event.preventDefault(); finishDeleteConfirmation(false); }
  });
  async function deleteFile(file, trigger) {
    if (fileDeletion || fileTransferController || serviceLink.files?.busy) return toast('请先完成当前文件操作。');
    if (disposed || !state().loggedIn || state().accessExpired || state().temporary || !navigator.onLine || !deleteSupported || !$('files-dialog').open) return;
    let snapshot; try { snapshot = fileDeleteOptions({ name: file.name, version: file.version }); } catch (error) { return toast(error.message, true); }
    const entry = fileDeletion = { controller: new AbortController(), generation: state().generation, sent: false };
    const current = () => !disposed && fileDeletion === entry && entry.generation === state().generation && state().loggedIn && !state().accessExpired && !state().temporary;
    const restoreFocus = document.activeElement === trigger;
    renderFileControls();
    try {
      const confirmed = await new Promise(resolve => {
        entry.resolve = resolve; entry.timer = setTimeout(() => finishDeleteConfirmation(false), 120000);
        $('file-delete-name').textContent = snapshot.name; $('file-delete-dialog').showModal(); $('file-delete-cancel').focus();
      });
      if (!current()) return;
      if (!confirmed || entry.controller.signal.aborted || !navigator.onLine) { $('upload-status').textContent = '已取消删除。'; return; }
      entry.sent = true; entry.timer = setTimeout(() => entry.controller.abort('timeout'), 10000);
      $('upload-status').textContent = `正在删除：${snapshot.name}…`;
      fileDeleteResult(await api('/api/files/delete', { method: 'POST', body: snapshot, signal: entry.controller.signal }), snapshot.name);
      if (!current()) return;
      $('upload-status').textContent = `已删除：${snapshot.name}`;
      try { await loadFiles(entry.controller.signal); } catch { if (current()) $('upload-status').textContent = `已删除：${snapshot.name}；列表刷新失败，请手动刷新。`; }
    } catch (error) {
      if (current()) $('upload-status').textContent = entry.sent && (entry.controller.signal.aborted || !error.status || error.outcome === 'unknown')
        ? '删除结果未确认，请刷新文件列表核对；不会自动重试。' : `${error.message}；请刷新文件列表后重新选择。`;
    } finally {
      clearTimeout(entry.timer); finishDeleteConfirmation(false);
      if (fileDeletion === entry) {
        fileDeletion = undefined;
        renderFileControls();
        if (!entry.sent && restoreFocus && $('files-dialog').open && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      }
    }
  }
  function cancelDeletion() { finishDeleteConfirmation(false); fileDeletion?.controller.abort(); }
  async function uploadFile(file) {
    if (fileTransferController || fileDeletion) return toast('请先完成当前文件操作。');
    if (serviceLink.files?.busy) return toast('文件直连正在处理其他下载，请完成后再操作。');
    if (!file || !state().loggedIn || state().accessExpired || !navigator.onLine || !$('files-dialog').open) return;
    if (!validTransferName(file.name, true)) { toast('文件名无效或超过 240 字节，请改名后上传。', true); $('upload-input').value = ''; return; }
    if (file.size > 50 * 1024 * 1024) { toast('文件不能超过 50 MiB', true); $('upload-input').value = ''; return; }
    const generation = state().generation, controller = fileTransferController = new AbortController();
    const progress = fileProgress.start({ name: file.name, size: file.size, direction: 'upload', cancel: () => controller.abort('user') });
    const timer = setTimeout(() => controller.abort('timeout'), 300000), uploadTrace = createUploadTrace(trace);
    const current = () => !disposed && fileTransferController === controller && generation === state().generation && state().loggedIn && !state().accessExpired;
    let sending = false, stopProgress = () => {};
    $('upload-input').disabled = true;
    renderFileControls();
    $('upload-status').textContent = `正在检查 ${file.name}…`;
    try {
      const listing = await readFiles(controller.signal);
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
      fileTransferPath = client ? 'direct' : 'https'; changed();
      uploadTrace.start(client ? 'direct' : 'https', file.size);
      progress.route(client ? 'WebRTC' : 'HTTPS'); progress.progress(0, file.size);
      const report = (loaded, total, metrics) => { if (current() && !controller.signal.aborted) { progress.progress(loaded, total); uploadTrace.progress(loaded, total, metrics); } };
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
      uploadTrace.end(undefined, undefined, 'confirmed');
      $('upload-status').textContent = `上传完成：${name}`;
      progress.end('上传已确认完成。', true);
      try { await loadFiles(controller.signal); } catch { if (current()) $('upload-status').textContent = `上传完成：${name}；列表刷新失败，请手动刷新，不要重复上传。`; }
    } catch (error) {
      uploadTrace.end(controller.signal.aborted ? ['timeout', 'offline', 'auth', 'page-hidden'].includes(controller.signal.reason) ? controller.signal.reason : 'aborted' : ['file_read_failed', 'file_read_busy', 'file_read_timeout'].includes(error.code) || fileTimeoutCode(error.code) ? error.code : error.fileCode || (error.status ? 'http-status' : 'network'), error.status,
        error.outcome === 'rejected' ? 'rejected' : 'unknown');
      progress.end(controller.signal.aborted ? sending ? '上传已中断；请刷新列表核对服务器结果。' : '已取消，未发送文件内容。'
        : error.outcome === 'rejected' ? `${error.message}；本次上传已拒绝，未保存文件。` : '本次上传未完成，请核对文件列表；不会自动重试。');
      if (current()) $('upload-status').textContent = controller.signal.aborted
        ? sending ? `${controller.signal.reason === 'timeout' ? '上传超过五分钟' : controller.signal.reason === 'offline' ? '设备离线，上传已中断' : '上传已中断'}，结果未知；请检查文件状态后手动重试。` : '检查已取消，未上传文件。'
        : `${sending && error.outcome !== 'rejected' && (!error.status || error.outcome === 'unknown') ? '上传结果未确认：' : ''}${error.message}；不会自动重试，请刷新文件列表后重新选择。`;
    } finally {
      stopProgress(); clearTimeout(timer);
      if (fileTransferController === controller) { fileTransferController = fileTransferPath = undefined; changed(); $('upload-input').disabled = false; $('upload-input').value = ''; renderFileControls(); }
    }
  }
  function nativeDownload(file) {
    $('upload-status').textContent = '文件内容：HTTPS（本次下载）；请在浏览器下载列表查看进度或取消。';
    const link = document.createElement('a'); link.href = nodeLink(fileDownloadPath(file.name, file.version)); link.download = file.name;
    document.body.append(link); link.click(); link.remove();
    trace('file-handoff', { route: 'https', direction: 'download', totalBytes: file.size });
  }
  async function downloadFile(file) {
    if (fileTransferController || fileDeletion) return toast('请先完成当前文件操作。');
    if (serviceLink.files?.busy) return toast('文件直连正在处理其他下载，请完成后再操作。');
    if (!state().loggedIn || state().accessExpired || !navigator.onLine || !$('files-dialog').open) return;
    const version = validFileVersion(file.version) ? file.version : undefined;
    const available = serviceLink.files;
    const client = version && !available?.versionedDownloads ? null : available;
    const large = file.size > FILE_MAX;
    if (large && (!client || file.size > client.maxDownload || !canStreamDownload())) { nativeDownload(file); return; }
    const generation = state().generation, controller = fileTransferController = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), large ? FILE_DOWNLOAD_TIMEOUT : 300000), downloadTrace = createUploadTrace(trace);
    let sink;
    fileTransferPath = client ? 'direct' : 'https'; changed();
    const current = () => !disposed && fileTransferController === controller && generation === state().generation && state().loggedIn && !state().accessExpired;
    const progress = fileProgress.start({ name: file.name, size: file.size, direction: 'download', route: client ? 'WebRTC' : 'HTTPS', cancel: () => controller.abort('user') });
    downloadTrace.start(client ? 'direct' : 'https', file.size, 'download');
    const report = (loaded, total) => { if (current() && !controller.signal.aborted) { progress.progress(loaded, total); downloadTrace.progress(loaded, total); } };
    $('upload-input').disabled = true; renderFileControls(); $('upload-status').textContent = `正在下载 ${file.name}…`;
    try {
      let blob;
      if (large) {
        sink = await createDownloadSink(file.name, file.size, controller.signal, reason => controller.abort(reason));
        if (!current() || controller.signal.aborted) { sink.abort(); return; }
        await client.downloadTo(file.name, file.size, sink, controller.signal, report, version);
      } else blob = client ? await client.download(file.name, file.size, controller.signal, report, version)
        : await api(fileDownloadPath(file.name, version), { signal: controller.signal, progress: report, downloadSize: file.size, downloadVersion: version });
      if (!current() || controller.signal.aborted) { progress.end(large ? '下载已取消，请在浏览器下载列表核对文件。' : '下载已取消，未生成下载文件。'); return; }
      if (blob) saveDirectFile(blob, file.name);
      downloadTrace.end(undefined, undefined, 'confirmed'); progress.end('下载完成，已交给浏览器保存。', true); $('upload-status').textContent = `下载完成：${file.name}`;
    } catch (error) {
      sink?.abort(error);
      const { reason, status, outcome } = downloadFailure(error, controller.signal);
      downloadTrace.end(reason, status, outcome);
      const canceled = outcome === 'canceled';
      progress.end(canceled ? large ? '下载已取消，请在浏览器下载列表核对文件。' : '下载已取消，未生成下载文件。' : '下载未完成，不会自动重试。');
      if (current()) {
        const message = controller.signal.reason?.message || error?.message;
        $('upload-status').textContent = canceled
          ? large ? '下载已中断，请在浏览器下载列表核对并清理未完成文件。' : '下载已中断，未保存不完整文件。'
          : reason === 'timeout' ? '下载超时，请手动重试。' : message || '下载未完成，请手动重试。';
      }
    } finally {
      clearTimeout(timer);
      downloadTrace.end('aborted', undefined, 'canceled');
      if (fileTransferController === controller) { fileTransferController = fileTransferPath = undefined; changed(); $('upload-input').disabled = false; renderFileControls(); }
    }
  }
  listen($('upload-input'), 'change', () => void uploadFile($('upload-input').files[0]));
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) listen($('files-dialog'), type, event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (type === 'dragleave' && $('files-dialog').contains(event.relatedTarget)) return;
    const active = (type === 'dragenter' || type === 'dragover') && !fileTransferController && !fileDeletion && state().loggedIn && !state().accessExpired && navigator.onLine;
    $('upload-zone').classList.toggle('drag-over', active);
    if (type !== 'drop') { if (event.dataTransfer) event.dataTransfer.dropEffect = active ? 'copy' : 'none'; return; }
    const items = event.dataTransfer.items, files = event.dataTransfer.files;
    let message;
    if (fileTransferController || fileDeletion) message = '当前文件仍在处理中，请完成后再上传。';
    else if (files.length !== 1 || items?.length !== 1 || items[0].webkitGetAsEntry?.()?.isDirectory) message = '每次请拖入一个文件，不支持文件夹。';
    if (message) {
      const status = $('upload-status');
      status.textContent = message;
      status.scrollIntoView({ block: 'nearest' });
      return;
    }
    void uploadFile(files[0]);
  });

  function reset(reason = 'closed') {
    filePathGeneration++; filePathCopyBusy = false;
    const controller = fileTransferController; fileTransferController = fileTransferPath = undefined; controller?.abort(reason); changed();
    cancelDeletion(); uploadPrompt.cancel(); fileListReader.cancel(); clearFileURLs(); fileProgress.clear();
    $('upload-input').disabled = false; $('file-path-preview').value = ''; $('file-path-fallback').hidden = true;
    $('upload-zone').classList.remove('drag-over'); renderFileControls();
  }
  return {
    get busy() { return !!fileTransferController || !!fileDeletion || fileListReader.busy; },
    get transferPath() { return fileTransferPath; },
    update: renderFileControls, saveDownload: saveDirectFile, reset,
    revalidate() {
      fileListReader.revalidate(); uploadPrompt.revalidate();
      if (state().temporary || fileDeletion?.generation !== state().generation) cancelDeletion();
      if (!state().loggedIn || state().accessExpired) { fileTransferController?.abort('auth'); cancelDeletion(); }
      else if (!navigator.onLine) {
        // The default-route hint cannot revoke an admitted LAN/VPN transfer.
        // Its channel, ACK/read deadlines and five-minute budget still apply.
        if (fileTransferPath !== 'direct') fileTransferController?.abort('offline');
        cancelDeletion();
      }
    },
    suspend() { const pending = !!fileTransferController || !!fileDeletion?.sent; reset('page-hidden'); if (pending) $('upload-status').textContent = '页面已离开，文件操作结果未确认；请刷新列表核对，不会自动重试。'; },
    dispose() { if (disposed) return; disposed = true; reset(); for (const remove of listeners) remove(); uploadPrompt.dispose(); fileProgress.dispose(); $('file-list').replaceChildren(); },
  };
}
