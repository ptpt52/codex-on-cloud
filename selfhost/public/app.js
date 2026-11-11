const $ = id => document.getElementById(id);
const labels = { offline: '离线', connecting: '接入中', authenticated: '认证中', online: '在线', grace: '断线恢复', revoked: '已撤销', expired: '已过期' };
let csrf = '', keys = [], revision = 0, timer, loading, controller, epoch = 0, fresh = false, writing = false, target, pendingAction;
const rows = new Map();
const dialogTriggers = new WeakMap();
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未';
const localTime = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const modalOpen = () => !!document.querySelector('dialog[open], .node-row details[open]');
function view(id) { for (const name of ['state-view', 'login-view', 'center-view']) $(name).hidden = name !== id; }
function message(text = '', error = false) { $('list-message').textContent = text; $('list-message').className = error ? 'error' : 'muted'; }
async function api(path, { method = 'GET', body, signal } = {}) {
  const timeout = AbortSignal.timeout(10000), headers = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch('/admin' + path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(value.error || '请求失败'), { status: response.status });
  return value;
}
function schedule() {
  clearTimeout(timer);
  if (!$('center-view').hidden && !document.hidden && !modalOpen() && !writing) timer = setTimeout(() => void load(), 5000);
}
function endSession() {
  epoch++; controller?.abort(); clearTimeout(timer); fresh = false; csrf = ''; keys = []; rows.clear(); $('key-list').replaceChildren();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearSecret(); view('login-view');
}
function permissions() {
  $('new-key').disabled = !fresh || writing;
  $('logout').disabled = writing;
  for (const button of document.querySelectorAll('dialog button[type="submit"]')) button.disabled = !fresh || writing;
  for (const button of document.querySelectorAll('[data-manage]')) button.disabled = !fresh || writing;
}
async function load() {
  if (loading) return loading;
  const current = epoch; controller = new AbortController(); $('refresh').disabled = true; $('retry').disabled = true;
  loading = (async () => {
    try {
      const value = await api('/api/overview', { signal: controller.signal });
      if (current !== epoch) return;
      csrf = value.csrf; revision = value.revision; keys = value.keys; fresh = true;
      $('center-host').textContent = value.host;
      const status = value.status;
      for (const [id, count] of [['online-count', status.onlineNodes], ['connecting-count', status.connectingNodes], ['grace-count', status.graceNodes], ['active-count', status.activeKeys]]) $(id).textContent = count;
      $('total-count').textContent = '共 ' + status.totalKeys + ' 个'; $('turn-state').textContent = value.turn ? '已配置' : '未配置';
      $('connection-state').textContent = '已更新'; $('connection-state').className = 'status online'; message(); render(); view('center-view');
    } catch (error) {
      if (current !== epoch) return;
      fresh = false;
      if (error.status === 401) endSession();
      else if (!$('center-view').hidden) { $('connection-state').textContent = '数据待刷新'; $('connection-state').className = 'status warning'; message('刷新失败：' + error.message + '。当前显示上次数据，请刷新后再管理节点。', true); }
      else { view('state-view'); $('state-title').textContent = '暂时无法加载管理中心'; $('state-message').textContent = error.message + '。请重试或返回节点首页。'; $('retry').hidden = false; }
    } finally { loading = null; $('refresh').disabled = false; $('retry').disabled = false; permissions(); schedule(); }
  })();
  return loading;
}
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function makeRow(id) {
  const row = element('article', 'node-row'); row.setAttribute('role', 'listitem'); row.dataset.id = id;
  const info = element('div', 'node-info'), name = element('h3'), path = element('span', 'mono'), state = element('span', 'status'), expiry = element('span', 'node-expiry');
  info.append(name, path); const meta = element('div', 'node-meta'); meta.append(state, expiry);
  const actions = element('div', 'node-actions'), enter = element('a', 'primary node-enter', '进入节点'), copy = element('button', 'quiet', '复制地址');
  copy.type = 'button'; copy.addEventListener('click', () => { const item = keys.find(k => k.id === id); if (item) void copyText(new URL(item.path, location.origin).href, $('list-message')); });
  enter.addEventListener('click', event => { if (enter.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
  const more = element('details', 'node-more'), summary = element('summary', 'quiet', '更多'), menu = element('div', 'node-menu');
  for (const [action, text] of [['details', '查看详情'], ['edit', '修改名称 / 有效期'], ['reissue', '重新授权'], ['disconnect', '断开连接'], ['revoke', '撤销授权']]) {
    const button = element('button', action === 'revoke' ? 'danger-text' : 'quiet', text); button.type = 'button'; button.dataset.action = action; if (action !== 'details') button.dataset.manage = '';
    button.addEventListener('click', () => { const item = keys.find(k => k.id === id); more.open = false; if (item) openAction(action, item, summary); }); menu.append(button);
  }
  more.append(summary, menu); more.addEventListener('toggle', () => { if (more.open) for (const other of document.querySelectorAll('.node-more[open]')) if (other !== more) other.open = false; schedule(); }); actions.append(enter, copy, more); row.append(info, meta, actions);
  return { row, name, path, state, expiry, enter, menu };
}
function render() {
  const query = $('search').value.trim().toLocaleLowerCase(), filter = $('filter').value;
  const filtered = keys.filter(item => {
    const history = ['revoked', 'expired'].includes(item.status);
    return (!query || (item.name + ' ' + item.path).toLocaleLowerCase().includes(query)) && (filter === 'all' || filter === 'current' && !history || filter === 'history' && history || filter === 'connecting' && ['connecting', 'authenticated'].includes(item.status) || filter === item.status);
  }).sort((a, b) => (['online', 'connecting', 'authenticated', 'grace', 'offline', 'expired', 'revoked'].indexOf(a.status) - ['online', 'connecting', 'authenticated', 'grace', 'offline', 'expired', 'revoked'].indexOf(b.status)) || a.name.localeCompare(b.name, 'zh-CN'));
  const visible = new Set(filtered.map(item => item.id));
  for (const [id, parts] of rows) if (!keys.some(item => item.id === id)) { parts.row.remove(); rows.delete(id); }
  let previous = null;
  for (const item of filtered) {
    let p = rows.get(item.id); if (!p) { p = makeRow(item.id); rows.set(item.id, p); }
    // Preserve nodes and focused controls across polling; only move changed order.
    p.row.hidden = false;
    if (p.name.textContent !== item.name) p.name.textContent = item.name;
    p.path.textContent = item.path; p.state.textContent = labels[item.status] || item.status;
    p.state.className = 'status ' + (item.status === 'online' ? 'online' : ['connecting', 'authenticated', 'grace'].includes(item.status) ? 'warning' : ['revoked', 'expired'].includes(item.status) ? 'error' : 'neutral');
    p.expiry.textContent = item.revokedAt ? '授权已撤销' : item.expiresAt === null ? '无限期' : '到期 ' + date(item.expiresAt);
    p.enter.href = item.path; p.enter.setAttribute('aria-disabled', String(item.status !== 'online')); p.enter.tabIndex = item.status === 'online' ? 0 : -1; p.enter.title = item.status === 'online' ? '进入 ' + item.name : '节点在线后可进入';
    p.menu.querySelector('[data-action="disconnect"]').hidden = !item.session || ['revoked', 'expired'].includes(item.status);
    p.menu.querySelector('[data-action="revoke"]').hidden = !!item.revokedAt;
    const expected = previous ? previous.nextElementSibling : $('key-list').firstElementChild;
    if (expected !== p.row) { const focused = p.row.contains(document.activeElement) ? document.activeElement : null; $('key-list').insertBefore(p.row, expected); focused?.focus({ preventScroll: true }); }
    previous = p.row;
  }
  for (const [id, parts] of rows) if (!visible.has(id)) parts.row.hidden = true;
  $('empty').hidden = keys.length !== 0; $('no-results').hidden = keys.length === 0 || filtered.length !== 0; $('result-count').textContent = '显示 ' + filtered.length + ' / ' + keys.length + ' 个'; permissions();
}
function resetDialog(dialog) {
  dialog.querySelectorAll('[role="alert"]').forEach(node => { node.textContent = ''; });
  dialog.querySelectorAll('.reconcile').forEach(node => { node.hidden = true; });
  dialog.querySelectorAll('button').forEach(node => { node.disabled = false; });
}
function show(dialog, trigger = document.activeElement) { clearTimeout(timer); resetDialog(dialog); dialogTriggers.set(dialog, trigger); dialog.showModal(); }
function restoreDialogFocus(dialog) {
  if (dialog.open || writing || $('center-view').hidden || document.querySelector('dialog[open]')) return;
  const trigger = dialogTriggers.get(dialog);
  const destination = trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length ? trigger : $('filter');
  destination.focus({ preventScroll: true });
}
function expiryFields(prefix, finite) {
  $(prefix === 'key' ? 'expiry-field' : 'edit-expiry-field').hidden = !finite;
  const input = $(prefix + '-expiry'); input.required = finite; input.disabled = !finite; input.min = localTime(Date.now() + 60000);
}
function expiration(prefix, infinite) {
  if (infinite) return { neverExpires: true, expiresAt: null };
  const value = new Date($(prefix + '-expiry').value).getTime();
  if (!Number.isSafeInteger(value) || value <= Date.now()) throw Error('请选择有效的未来到期时间');
  return { neverExpires: false, expiresAt: value };
}
function openKey(item, trigger) {
  target = item ? { ...item, revision } : null;
  $('key-form').reset(); $('key-name').value = item?.name || ''; $('key-slug').value = item?.slug || ''; $('key-name').readOnly = !!item; $('key-slug').readOnly = !!item;
  $('key-dialog-title').textContent = item ? '重新授权节点' : '创建节点授权'; $('create-key').textContent = item ? '重新授权并生成 key' : '创建';
  $('key-warning').hidden = !item; $('key-warning').textContent = item ? '将替换“' + item.name + '”的 key。旧 key 和节点凭据失效，新请求立即被阻止，现有隧道在下一次心跳（约 5 秒）关闭。地址 ' + item.path + ' 保持不变；不会结束节点上的终端或桌面任务。请在节点重新执行接入命令。' : '';
  $('key-never-expires').checked = !item?.expiresAt; $('key-expiry').value = item?.expiresAt && item.expiresAt > Date.now() ? localTime(item.expiresAt) : ''; expiryFields('key', !$('key-never-expires').checked); show($('key-dialog'), trigger);
}
function openAction(action, item, trigger) {
  if (action !== 'details' && (!fresh || writing)) return;
  target = { ...item, revision };
  if (action === 'reissue') return openKey(item, trigger);
  if (action === 'edit') { $('edit-name').value = item.name; $('edit-context').textContent = item.path + ' · ' + (item.expiresAt === null ? '无限期' : '到期 ' + date(item.expiresAt)); $('edit-validity').value = 'keep'; $('edit-expiry').value = ''; expiryFields('edit', false); return show($('edit-dialog'), trigger); }
  if (action === 'details') {
    $('details-title').textContent = item.name; const list = $('node-details'); list.replaceChildren();
    for (const [label, value] of [['访问路径', item.path], ['连接状态', labels[item.status]], ['授权有效期', item.expiresAt === null ? '无限期' : date(item.expiresAt)], ['创建时间', date(item.createdAt)], ['撤销时间', date(item.revokedAt)], ['模式', item.session ? item.session.mode === 'terminal' ? '网页终端' : '开发桌面' : '尚无连接'], ['来源', item.session?.source || '—'], ['连接时间', date(item.session?.connectedAt)], ['最近活动', date(item.session?.lastSeenAt)]]) list.append(element('dt', '', label), element('dd', '', value));
    return show($('details-dialog'), trigger);
  }
  const revoke = action === 'revoke'; pendingAction = { path: revoke ? '/api/keys/' + item.id : '/api/nodes/' + item.slug + '/disconnect', method: revoke ? 'DELETE' : 'POST', revision };
  $('confirm-title').textContent = revoke ? '撤销节点授权' : '断开节点连接'; $('confirm-target').textContent = item.name + ' · ' + item.path;
  $('confirm-message').textContent = revoke ? '将使该 key 和节点凭据失效，立即阻止新请求；现有隧道在下一次心跳（约 5 秒）关闭。终端和桌面任务继续运行。以后可在此节点重新授权，保留访问路径。' : '下一次心跳（约 5 秒）关闭当前隧道，保留授权和节点上的终端、桌面任务。节点客户端可能自动重连；要持续阻止接入，请撤销授权。';
  $('confirm-action').textContent = revoke ? '撤销此节点授权' : '断开此节点连接'; show($('confirm-dialog'), trigger);
}
async function mutate(dialog, errorId, action, success) {
  if (writing || !fresh) return;
  writing = true; clearTimeout(timer); $(errorId).textContent = '';
  dialog.querySelectorAll('button').forEach(button => { button.disabled = true; }); permissions();
  try { const value = await action(); dialog.close(); await success?.(value); await load(); }
  catch (error) {
    if (error.status === 401) { endSession(); $('login-message').textContent = '登录已过期，请重新登录并核对节点状态。'; }
    else {
      $(errorId).textContent = error.status && error.status < 500 ? error.message : '操作结果未确认：' + error.message + '。请刷新核对列表后再决定，系统不会自动重试此操作。';
      if (!error.status || error.status >= 500 || error.status === 409) { fresh = false; dialog.querySelector('.reconcile').hidden = false; message('操作结果需要核对，请刷新列表后再管理节点。', true); $('connection-state').textContent = '待核对'; $('connection-state').className = 'status warning'; }
    }
  } finally { writing = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); permissions(); restoreDialogFocus(dialog); schedule(); }
}
function clearSecret() { $('secret-value').textContent = ''; $('join-command').value = ''; $('secret-context').textContent = ''; $('copy-state').textContent = ''; }
function secret(value, reissued) {
  $('secret-context').textContent = value.name + ' · ' + value.path; $('secret-value').textContent = value.key; $('copy-state').textContent = '';
  $('join-command').value = 'npm run server:join -- --server ' + location.origin + ' --slug ' + value.slug + (reissued ? ' --reauthorize' : '');
  show($('secret-dialog'), dialogTriggers.get($('key-dialog')));
}
async function copyText(text, output) { try { await navigator.clipboard.writeText(text); output.textContent = '已复制'; output.classList.remove('error'); } catch { output.textContent = '无法自动复制，请手动选择文本复制。'; } }
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (dialog.id === 'secret-dialog') clearSecret(); restoreDialogFocus(dialog); schedule(); });
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (!writing) dialog.close(); }));
  dialog.querySelector('.reconcile')?.addEventListener('click', () => { dialog.close(); void load(); });
}
// Keep validation feedback inside the modal instead of browser popups that
// can cover adjacent controls (notably Firefox datetime-local validation).
for (const [form, output] of [['key-form', 'key-form-error'], ['edit-form', 'edit-error']]) {
  $(form).addEventListener('invalid', event => {
    event.preventDefault();
    $(output).textContent = event.target.type === 'datetime-local' ? '请选择有效的未来到期时间' : event.target.validationMessage;
    event.target.focus();
  }, true);
}
$('secret-close').addEventListener('click', () => $('secret-dialog').close());
$('copy-secret').addEventListener('click', () => void copyText($('secret-value').textContent, $('copy-state')));
$('copy-command').addEventListener('click', () => void copyText($('join-command').value, $('copy-state')));
$('key-never-expires').addEventListener('change', () => expiryFields('key', !$('key-never-expires').checked));
$('edit-validity').addEventListener('change', () => expiryFields('edit', $('edit-validity').value === 'finite'));
$('new-key').addEventListener('click', () => openKey(undefined, $('new-key')));
$('key-form').addEventListener('submit', event => {
  event.preventDefault(); let expiry;
  try { expiry = expiration('key', $('key-never-expires').checked); } catch (error) { $('key-form-error').textContent = error.message; return; }
  const reissued = !!target, path = target ? '/api/keys/' + target.id + '/reissue' : '/api/keys';
  const body = target ? { ...expiry, revision: target.revision } : { name: $('key-name').value, slug: $('key-slug').value, ...expiry, revision };
  void mutate($('key-dialog'), 'key-form-error', () => api(path, { method: 'POST', body }), value => secret(value, reissued));
});
$('edit-form').addEventListener('submit', event => {
  event.preventDefault(); const body = { name: $('edit-name').value, revision: target.revision };
  try { if ($('edit-validity').value !== 'keep') Object.assign(body, expiration('edit', $('edit-validity').value === 'forever')); } catch (error) { $('edit-error').textContent = error.message; return; }
  const id = target.id; void mutate($('edit-dialog'), 'edit-error', () => api('/api/keys/' + id, { method: 'PATCH', body }));
});
$('confirm-form').addEventListener('submit', event => { event.preventDefault(); const action = pendingAction; void mutate($('confirm-dialog'), 'confirm-error', () => api(action.path, { method: action.method, body: { revision: action.revision } })); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const value = await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } }); csrf = value.csrf; $('password').value = ''; $('login-message').textContent = '使用中心管理员密码登录。'; $('login-message').className = 'muted'; view('state-view'); await load(); }
  catch (error) { $('login-message').textContent = error.message; $('login-message').className = 'error'; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  if (writing) return; writing = true; clearTimeout(timer); $('logout').disabled = true; permissions();
  epoch++; controller?.abort(); if (loading) await loading;
  try { await api('/api/logout', { method: 'POST', body: {} }); endSession(); }
  catch (error) {
    // Read back session state when the response is lost; never replay logout.
    let loggedOut = error.status === 401;
    if (!loggedOut) { try { await api('/api/me'); } catch (check) { loggedOut = check.status === 401; } }
    if (loggedOut) endSession(); else message('退出未完成：' + error.message + '。登录仍保留，可再次点击退出。', true);
  } finally { writing = false; $('logout').disabled = false; permissions(); schedule(); }
});
for (const id of ['refresh', 'retry']) $(id).addEventListener('click', () => void load());
for (const id of ['search', 'filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
$('clear-filters').addEventListener('click', () => { $('search').value = ''; $('filter').value = 'all'; render(); });
document.addEventListener('click', event => {
  for (const more of document.querySelectorAll('.node-more[open]')) if (!more.contains(event.target)) more.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  for (const more of document.querySelectorAll('.node-more[open]')) { more.open = false; more.querySelector('summary').focus(); }
});
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && !modalOpen() && !writing) void load(); });
void load();
