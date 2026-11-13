import { entryURL } from './entry-path.js';

export function createAccessUI({ api, allowed, canUnlock, needsUnlock, lockEnabled, claim, changed, activity = () => {}, toast }) {
  const $ = id => document.getElementById(id), dialog = $('access-dialog'), unlockDialog = $('unlock-dialog'), confirmation = $('access-confirm');
  let controller, unlockController, busy = false, loading = false, unlocking = false, current, confirmResolve, sharedCredential, savingSection = '';
  const clearPasswords = () => { $('screen-lock-password').value = $('temporary-password').value = $('temporary-share').value = ''; $('temporary-share').hidden = true; sharedCredential = null; $('temporary-copy').disabled = true; };
  function closeConfirmation() { if (confirmation.open) confirmation.close(); if (confirmResolve) { const resolve = confirmResolve; confirmResolve = null; resolve(false); } }
  function update() {
    $('access-actions').hidden = !allowed();
    $('screen-lock-button').hidden = !allowed() || !lockEnabled();
    if (!allowed() && dialog.open) dialog.close();
    if ((!canUnlock() || !needsUnlock()) && unlockDialog.open) unlockDialog.close();
    for (const id of ['screen-lock-save', 'temporary-save']) $(id).disabled = busy || loading || !current || !allowed();
    const disabled = busy || loading || !current || !allowed();
    for (const input of dialog.querySelectorAll('.access-form input, .access-form select')) input.disabled = disabled;
    $('screen-lock-password').disabled = disabled || !$('screen-lock-enabled').checked;
    $('screen-lock-password').required = $('screen-lock-enabled').checked && !!current && !current.screen.configured;
    const temporaryEnabled = $('temporary-enabled').checked;
    for (const id of ['temporary-username', 'temporary-password', 'temporary-duration']) $(id).disabled = disabled || !temporaryEnabled;
    $('temporary-username').required = temporaryEnabled;
    $('temporary-password').required = temporaryEnabled && !!current && (!current.temporary.enabled || $('temporary-username').value.trim() !== current.temporary.username);
    for (const [id, section, label] of [['screen-lock-save', 'screen', '保存屏幕锁'], ['temporary-save', 'temporary', '保存临时账号']]) $(id).textContent = busy && savingSection === section ? '正在保存…' : label;
    for (const form of dialog.querySelectorAll('.access-form')) form.setAttribute('aria-busy', String(loading || busy));
    if (!current) for (const id of ['screen-lock-current', 'temporary-state']) { $(id).textContent = loading ? '正在读取' : '未读取'; $(id).dataset.active = 'false'; }
    $('temporary-copy').disabled = busy || loading || !sharedCredential || !allowed();
    $('unlock-submit').disabled = unlocking || !canUnlock();
  }
  function render(value) {
    const screen = value?.screen, temporary = value?.temporary;
    if (typeof screen?.enabled !== 'boolean' || typeof screen.configured !== 'boolean' || typeof temporary?.enabled !== 'boolean' || typeof temporary.active !== 'boolean' || typeof temporary.username !== 'string' || temporary.expires !== null && !Number.isSafeInteger(temporary.expires)) throw new Error('访问设置响应无效，请关闭后重新打开。');
    current = value; $('screen-lock-enabled').checked = value.screen.enabled;
    $('screen-lock-current').textContent = screen.enabled ? '已开启' : '未开启'; $('screen-lock-current').dataset.active = String(screen.enabled);
    $('screen-lock-password').placeholder = value.screen.configured ? '留空保留已配置密码；新密码 4–128 个字符' : '请设置 4–128 个字符的屏幕锁密码';
    $('temporary-enabled').checked = value.temporary.enabled; $('temporary-username').value = value.temporary.username || 'visitor';
    $('temporary-state').textContent = temporary.enabled ? temporary.active ? '当前有效' : '已过期' : '未开启'; $('temporary-state').dataset.active = String(temporary.active);
    $('temporary-current').textContent = value.temporary.enabled ? `${value.temporary.active ? '当前有效' : '已过期'}，截止 ${new Date(value.temporary.expires).toLocaleString()}` : '当前未启用临时账号。';
  }
  async function open() {
    if (!allowed() || busy || loading) return;
    current = null; loading = true; clearPasswords(); $('access-status').textContent = '正在读取…'; dialog.showModal(); update();
    controller?.abort(); const request = new AbortController(); controller = request;
    try { const value = await api('/api/security', { signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) }); if (allowed() && dialog.open && controller === request) { render(value); $('access-status').textContent = ''; } }
    catch (error) { if (!request.signal.aborted && dialog.open) $('access-status').textContent = error.name === 'TimeoutError' ? '读取访问设置超时，请关闭后重新打开；尚未修改设置。' : error.message; }
    finally { if (controller === request) controller = null; loading = false; update(); }
  }
  function unlock() {
    if (!canUnlock() || !needsUnlock() || unlockDialog.open) return;
    $('unlock-password').value = ''; $('unlock-error').textContent = ''; unlockDialog.showModal(); $('unlock-password').focus({ preventScroll: true });
  }
  $('unlock-form').addEventListener('submit', async event => {
    event.preventDefault(); if (unlocking || !canUnlock()) return;
    const value = $('unlock-password').value; if (!value) return;
    $('unlock-password').value = ''; unlocking = true; update();
    const request = new AbortController(); unlockController = request;
    try { await claim(value, AbortSignal.any([request.signal, AbortSignal.timeout(15000)])); if (unlockDialog.open) unlockDialog.close(); }
    catch (error) { if (!request.signal.aborted && unlockDialog.open) $('unlock-error').textContent = error.message || '未能确认解锁结果，请重新输入密码'; }
    finally { if (unlockController === request) unlockController = null; unlocking = false; update(); }
  });
  for (const id of ['unlock-cancel', 'unlock-close']) $(id).addEventListener('click', () => unlockDialog.close());
  unlockDialog.addEventListener('close', () => { unlockController?.abort(); unlockController = null; $('unlock-password').value = ''; });
  $('access-settings-button').addEventListener('click', () => void open());
  $('access-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { controller?.abort(); controller = null; closeConfirmation(); clearPasswords(); });
  $('screen-lock-button').addEventListener('click', async () => {
    if (!allowed() || busy) return;
    try { const value = await api('/api/security/lock', { method: 'POST', body: {} }); changed(value.access); }
    catch (error) { toast(error.message, true); }
  });
  function confirmUpdate(enabled) {
    $('access-confirm-title').textContent = enabled ? '更新临时访问？' : '停用临时账号？';
    $('access-confirm-accept').textContent = enabled ? '确认更新' : '确认停用';
    closeConfirmation(); confirmation.showModal(); $('access-confirm-cancel').focus({ preventScroll: true });
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  $('access-confirm-cancel').addEventListener('click', closeConfirmation);
  confirmation.addEventListener('cancel', closeConfirmation);
  $('access-confirm-accept').addEventListener('click', () => { const resolve = confirmResolve; confirmResolve = null; confirmation.close(); resolve?.(true); });
  async function save(path, body, temporary = false) {
    if (busy || loading || !current || !allowed()) return;
    if (temporary && current?.temporary.enabled && !await confirmUpdate(body.enabled)) return;
    if (!allowed() || !dialog.open) return;
    busy = true; savingSection = temporary ? 'temporary' : 'screen'; $('access-status').textContent = temporary ? '正在保存临时账号…' : '正在保存屏幕锁…'; update(); const request = new AbortController(); controller = request;
    try {
      const value = await api(path, { method: 'POST', body, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
      $('screen-lock-password').value = $('temporary-password').value = ''; render(value); changed(value.access);
      if (dialog.open) { $('access-status').textContent = temporary ? '临时账号设置已保存。' : '屏幕锁设置已保存。'; sharedCredential = temporary && body.enabled && body.password ? { username: value.temporary.username, password: body.password, expires: value.temporary.expires } : null; }
      if (needsUnlock()) { toast('屏幕锁已更新，请输入锁密码继续操作'); unlock(); }
    } catch (error) {
      if (!request.signal.aborted && dialog.open) {
        if (error.outcome !== 'rejected') { current = null; clearPasswords(); $('access-status').textContent = '保存结果未知，请关闭并重新打开设置确认；不要重复提交。'; }
        else $('access-status').textContent = error.message;
      }
    }
    finally { busy = false; savingSection = ''; if (controller === request) controller = null; update(); }
  }
  $('screen-lock-form').addEventListener('submit', event => { event.preventDefault(); void save('/api/security/screen-lock', { enabled: $('screen-lock-enabled').checked, password: $('screen-lock-password').value }); });
  $('temporary-account-form').addEventListener('submit', event => {
    event.preventDefault(); void save('/api/security/temporary-account', { enabled: $('temporary-enabled').checked, username: $('temporary-username').value.trim(), password: $('temporary-password').value, durationMs: Number($('temporary-duration').value) }, true);
  });
  $('screen-lock-enabled').addEventListener('input', update);
  for (const id of ['temporary-enabled', 'temporary-username', 'temporary-password', 'temporary-duration']) $(id).addEventListener('input', () => { sharedCredential = null; $('temporary-copy').disabled = true; $('temporary-share').value = ''; $('temporary-share').hidden = true; update(); });
  $('temporary-copy').addEventListener('click', async () => {
    if (!allowed() || !sharedCredential || busy || loading) return;
    const credential = sharedCredential, valid = () => allowed() && dialog.open && sharedCredential === credential && !busy && !loading;
    const text = `工作台：${entryURL('/').href}\n临时账号：${credential.username}\n密码：${credential.password}\n到期：${new Date(credential.expires).toLocaleString()}\n允许共享文件中转，以及查看管理员单独开放的助手 key。`;
    try { await navigator.clipboard.writeText(text); if (valid()) $('access-status').textContent = '临时访问信息已复制。'; }
    catch { if (valid()) { $('temporary-share').value = text; $('temporary-share').hidden = false; $('temporary-share').focus(); $('temporary-share').select(); $('access-status').textContent = '请长按或使用系统复制；也可以再次点击复制按钮。'; } }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (unlockDialog.open) unlockDialog.close(); if (dialog.open) dialog.close(); } });
  const close = () => { if (dialog.open) dialog.close(); if (unlockDialog.open) unlockDialog.close(); closeConfirmation(); clearPasswords(); };
  for (const modal of [dialog, unlockDialog, confirmation]) modal.addEventListener('toggle', activity);
  window.addEventListener('pagehide', close);
  return { update, unlock, close, get blocking() { return dialog.open || unlockDialog.open || confirmation.open || busy || unlocking; } };
}
