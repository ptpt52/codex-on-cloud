import { parseNodeDirectory, decodePortalCode } from './node-directory.js';
export function createNodeUI({ api, allowed, canConfigure, canLeave, saveDraft, changed, leave = origin => location.assign(origin + '/') }) {
  const $ = id => document.getElementById(id), dialog = $('servers-dialog'), settings = $('portal-settings-dialog'), button = $('servers-button');
  let directory, pending, leaving = false, generation = 0, controller, loading = false, saving = false, connection;
  const visibleBrand = enabled => { button.hidden = !enabled; $('node-brand').hidden = enabled; button.closest('.brand').classList.toggle('nodes-configured', enabled); };
  function update() { button.disabled = loading || leaving || !allowed() || !canLeave(); $('portal-settings-button').disabled = !canConfigure() || leaving || saving; }
  function selection() { $('servers-selection').hidden = !!pending; $('servers-confirmation').hidden = !pending; $('servers-destination').textContent = pending ? pending.name + ' · ' + new URL(pending.origin).host : ''; }
  function close() { pending = null; selection(); if (dialog.open) dialog.close(); changed(); }
  function closeSettings() { generation++; controller?.abort(); controller = null; loading = saving = false; $('portal-authorization-code').value = ''; if (settings.open) settings.close(); changed(); update(); }
  function reset() { closeSettings(); directory = null; connection = null; leaving = false; close(); visibleBrand(false); $('servers-list').replaceChildren(); $('current-server-name').textContent = ''; }
  function choose(target) { if (!allowed() || !canLeave() || leaving || target.origin === location.origin) return; pending = target; selection(); $('servers-cancel').focus({ preventScroll: true }); changed(); }
  function render() {
    $('servers-list').replaceChildren(); if (!directory) return;
    const current = directory.nodes.find(node => node.origin === location.origin);
    const name = current?.name || new URL(location.origin).host;
    $('current-server-name').textContent = name; button.title = `当前服务器：${name} · ${location.host}`; button.setAttribute('aria-label', '切换服务器，当前 ' + name); visibleBrand(true);
    for (const node of directory.nodes) {
      const row = document.createElement('div'); row.className = 'server-row';
      const details = document.createElement('div'), title = document.createElement('strong'), address = document.createElement('p'); title.textContent = node.name; address.textContent = new URL(node.origin).host; address.className = 'muted'; details.append(title, address);
      const select = document.createElement('button'); select.type = 'button'; select.className = 'secondary'; select.dataset.nodeId = node.id; select.textContent = node.origin === location.origin ? '当前服务器' : node.enabled ? '切换' : '待启用'; select.disabled = node.origin === location.origin || !node.enabled; select.addEventListener('click', () => choose(node)); row.append(details, select); $('servers-list').append(row);
    }
    $('servers-portal').hidden = false; $('servers-portal').textContent = '返回统一门户 · ' + new URL(directory.portalOrigin).host;
  }
  async function load() {
    if (!allowed() || loading || leaving) return;
    const epoch = ++generation; controller?.abort(); const current = controller = new AbortController(); loading = true; pending = null; selection();
    $('servers-status').textContent = '正在读取服务器列表…'; $('servers-retry').hidden = true; $('servers-list').replaceChildren(); $('servers-portal').hidden = true; update();
    const timer = setTimeout(() => current.abort(), 5000);
    try {
      const value = await api('/api/nodes', { signal: current.signal }); if (epoch !== generation || !allowed()) return;
      if (value?.enabled === false) { directory = null; visibleBrand(false); $('servers-status').textContent = '当前节点尚未接入门户。'; return; }
      directory = parseNodeDirectory({ version: value?.version, portalOrigin: value?.portalOrigin, nodes: value?.nodes }); if (value.enabled !== true) throw Error('服务器目录响应无效');
      render(); $('servers-status').textContent = '选择后需确认切换，各服务器分别登录。';
    } catch (error) {
      if (epoch !== generation || !allowed()) return;
      directory = null; visibleBrand(true); $('current-server-name').textContent = '服务器'; $('servers-status').textContent = current.signal.aborted ? '读取超时，当前服务器仍可独立使用。' : error.message; $('servers-retry').hidden = false;
    } finally { clearTimeout(timer); if (epoch === generation) { loading = false; controller = null; update(); } }
  }
  async function configure() {
    if (!canConfigure() || saving) return;
    close(); settings.showModal(); $('portal-authorization-code').value = ''; $('portal-config-status').textContent = '正在读取接入配置…'; $('portal-register').disabled = true; $('portal-node-name').disabled = $('portal-authorization-code').disabled = true;
    const epoch = ++generation; controller?.abort(); const current = controller = new AbortController(), timer = setTimeout(() => current.abort(), 5000);
    try {
      const value = await api('/api/portal', { signal: current.signal }); if (epoch !== generation || !settings.open) return;
      if (typeof value?.configured !== 'boolean' || value.publicOrigin !== location.origin || typeof value.name !== 'string') throw Error('门户接入配置响应无效');
      connection = value; $('portal-node-name').value = value.name; $('portal-node-origin').textContent = value.publicOrigin; $('portal-target-origin').textContent = value.portalOrigin || '粘贴授权码后自动识别门户地址'; $('portal-config-status').textContent = value.configured ? '已保存节点身份；留空授权码可保存已有接入。' : '门户可选配置，不影响本机独立运行。'; $('portal-register').disabled = false; $('portal-node-name').disabled = $('portal-authorization-code').disabled = false;
    } catch (error) { if (epoch === generation && settings.open) $('portal-config-status').textContent = current.signal.aborted ? '读取超时，请关闭后重试。' : error.message; }
    finally { clearTimeout(timer); if (epoch === generation) controller = null; }
    changed();
  }
  button.addEventListener('click', () => { if (button.disabled || !allowed() || !canLeave()) return; dialog.showModal(); $('servers-close').focus(); changed(); void load(); });
  $('servers-close').addEventListener('click', close); $('servers-retry').addEventListener('click', load);
  $('servers-portal').addEventListener('click', () => { if (directory) choose({ name: '统一门户', origin: directory.portalOrigin }); });
  $('servers-cancel').addEventListener('click', () => { pending = null; selection(); $('servers-close').focus(); changed(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { pending = null; selection(); changed(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && document.activeElement !== $('servers-accept')) { event.preventDefault(); pending ? $('servers-cancel').click() : close(); } });
  $('servers-accept').addEventListener('click', () => {
    const target = pending; if (!target || leaving || !allowed()) return close();
    if (!canLeave()) { $('servers-status').textContent = '请等待输入、配置或文件上传完成后再切换。'; pending = null; selection(); return; }
    if (!saveDraft()) { $('servers-status').textContent = '草稿未能保存，请先复制当前文字。'; pending = null; selection(); return; }
    pending = null; leaving = true; close(); update();
    try { leave(target.origin); } catch { leaving = false; $('servers-status').textContent = '无法跳转，请重新选择服务器。'; update(); }
  });
  $('portal-settings-button').addEventListener('click', configure); $('portal-settings-close').addEventListener('click', closeSettings);
  settings.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
  settings.addEventListener('close', () => { $('portal-authorization-code').value = ''; changed(); if (connection?.configured && allowed() && !leaving) void load(); });
  $('portal-authorization-code').addEventListener('input', () => { const code = $('portal-authorization-code').value.trim(); try { $('portal-target-origin').textContent = code ? decodePortalCode(code).origin : connection?.portalOrigin || '粘贴授权码后自动识别门户地址'; } catch { $('portal-target-origin').textContent = '请粘贴完整的门户授权码'; } });
  $('portal-register-form').addEventListener('submit', event => {
    event.preventDefault(); if (saving || !canConfigure()) return;
    const name = $('portal-node-name').value, authorizationCode = $('portal-authorization-code').value.trim();
    if (!authorizationCode && !connection?.configured) { $('portal-config-status').textContent = '请填写门户授权码'; return; }
    if (authorizationCode) { try { decodePortalCode(authorizationCode); } catch (error) { $('portal-config-status').textContent = error.message; return; } }
    const epoch = ++generation; controller?.abort(); const current = controller = new AbortController(); saving = true; $('portal-register').disabled = true; $('portal-node-name').disabled = $('portal-authorization-code').disabled = true; $('portal-config-status').textContent = '正在保存注册…'; changed();
    const timer = setTimeout(() => current.abort(), 8000);
    void (async () => {
      try {
        const value = await api('/api/portal/register', { method: 'POST', body: { name, authorizationCode }, signal: current.signal });
        if (epoch !== generation || !settings.open) return;
        connection = value; $('portal-authorization-code').value = ''; $('portal-target-origin').textContent = value.portalOrigin; $('portal-config-status').textContent = value.enabled ? '注册已保存，门户入口已启用。' : '注册已保存，等待门户管理员启用入口。';
      } catch (error) { if (epoch === generation && settings.open) $('portal-config-status').textContent = current.signal.aborted ? '接入结果未知，请检查门户后手动重试；不会自动发送。' : error.message; }
      finally { clearTimeout(timer); if (epoch === generation) { saving = false; controller = null; $('portal-register').disabled = false; $('portal-node-name').disabled = $('portal-authorization-code').disabled = false; update(); changed(); } }
    })();
  });
  window.addEventListener('pagehide', () => { generation++; controller?.abort(); loading = saving = false; close(); if (settings.open) closeSettings(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  return { load, reset, update, get blocking() { return dialog.open || settings.open || leaving; } };
}
