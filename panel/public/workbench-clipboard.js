// Remote text is read only after an explicit click. A suspend invalidates
// reads and local clipboard promises; reconnect never reads or copies again.
export function createWorkbenchClipboard({ $, request, access, open, blocked, terminalOnly, receive, changed }) {
  let clipboardController = null, clipboardGeneration = 0, clipboardCopyBusy = false, clipboardText = '', disposed = false;
  const listeners = [];
  const listen = (element, type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
  function clearClipboard() {
    clipboardController?.abort(); clipboardController = null;
    clipboardGeneration++; clipboardCopyBusy = false;
    clipboardText = '';
    $('clipboard-preview').value = '';
    $('clipboard-meta').textContent = '';
    $('clipboard-status').textContent = '';
  }
  function renderClipboard() {
    if (disposed) return;
    const accessible = access();
    if (!accessible) clearClipboard();
    const readable = accessible && !blocked() && !clipboardController;
    const receiving = open();
    $('input-dock').classList.toggle('is-receiving', receiving);
    $('assistant-send-panel').hidden = receiving;
    $('clipboard-dialog').hidden = !receiving;
    $('assistant-send-button').setAttribute('aria-pressed', String(!receiving));
    $('clipboard-button').setAttribute('aria-pressed', String(receiving));
    $('clipboard-button').disabled = !accessible || terminalOnly();
    $('read-clipboard').disabled = !readable || !receiving;
    $('copy-clipboard').disabled = !accessible || !receiving || !clipboardText || clipboardCopyBusy;
    $('select-clipboard').disabled = !accessible || !receiving || !$('clipboard-preview').value;
    if (receiving && !$('clipboard-status').textContent) $('clipboard-status').textContent = '只在点击读取时获取；切换方向或关闭面板会清空预览。';
  }
  listen($('clipboard-button'), 'click', () => {
    if ($('clipboard-button').disabled) return;
    receive();
  });
  listen($('clipboard-source'), 'change', () => { clearClipboard(); renderClipboard(); changed(); });
  listen($('read-clipboard'), 'click', async () => {
    if ($('read-clipboard').disabled) return;
    clearClipboard();
    const controller = new AbortController(), source = $('clipboard-source').value;
    clipboardController = controller;
    const timeout = setTimeout(() => controller.abort(new Error('读取超时，请手动重试')), 8000);
    $('clipboard-status').textContent = '正在读取远程文字…';
    renderClipboard(); changed();
    try {
      const result = await request('/api/clipboard/read', { source }, controller.signal);
      if (clipboardController !== controller || !open() || !access()) return;
      if (result.source !== source || typeof result.text !== 'string' || result.text.length > 32768 || result.text.includes('\0') || new TextEncoder().encode(result.text).length > 32768) throw new Error('远程文字格式或大小无效');
      clipboardText = result.text;
      $('clipboard-preview').value = result.text;
      $('clipboard-meta').textContent = `${source === 'clipboard' ? '远程剪贴板' : '选中文字'} · ${new TextEncoder().encode(result.text).length} 字节`;
      $('clipboard-status').textContent = result.text ? '已读取，请预览后复制到本机。' : '当前内容为空，请在远程桌面复制或选中文字后手动读取。';
    } catch (error) {
      if (clipboardController === controller) $('clipboard-status').textContent = controller.signal.aborted ? '读取超时，请手动重试。' : error.message;
    } finally {
      clearTimeout(timeout);
      if (clipboardController === controller) { clipboardController = null; renderClipboard(); changed(); }
    }
  });
  function selectClipboardText() {
    $('clipboard-preview').focus(); $('clipboard-preview').select();
    $('clipboard-preview').setSelectionRange(0, $('clipboard-preview').value.length);
  }
  listen($('select-clipboard'), 'click', () => {
    if ($('select-clipboard').disabled) return;
    selectClipboardText();
    $('clipboard-status').textContent = '已选中文字，请长按或使用系统的复制操作。';
  });
  listen($('copy-clipboard'), 'click', async () => {
    if ($('copy-clipboard').disabled) return;
    const generation = clipboardGeneration;
    clipboardCopyBusy = true; renderClipboard();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(clipboardText);
      if (generation === clipboardGeneration && open() && access()) $('clipboard-status').textContent = '已复制到本机剪贴板。';
    } catch {
      if (generation === clipboardGeneration && open() && access()) {
        selectClipboardText();
        $('clipboard-status').textContent = '浏览器未允许自动复制，文字已选中，请长按或使用系统的复制操作。';
      }
    } finally { if (generation === clipboardGeneration) { clipboardCopyBusy = false; renderClipboard(); } }
  });

  return {
    get busy() { return !!clipboardController; },
    update: renderClipboard, reset: clearClipboard, suspend: clearClipboard,
    dispose() { if (disposed) return; disposed = true; clearClipboard(); for (const remove of listeners) remove(); },
  };
}
