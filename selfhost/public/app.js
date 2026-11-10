const $ = id => document.getElementById(id);
let csrf = '', keys = [], refreshTimer;

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch('/admin' + path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(value.error || '请求失败'), { status: response.status });
  return value;
}

function toast(message, error = false) {
  $('list-message').textContent = message;
  $('list-message').classList.toggle('error', error);
}

function date(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未';
}

function statusLabel(status) {
  return { offline: '离线', connecting: '接入中', authenticated: '认证中', online: '在线', grace: '断线恢复', revoked: '已撤销', expired: '已过期' }[status] || status;
}

function keyState(item, now = Date.now()) {
  if (item.revokedAt) return '已撤销';
  if (item.expiresAt !== null && item.expiresAt <= now) return '已过期';
  return item.expiresAt === null ? '无限期' : date(item.expiresAt);
}

function renderStatus(value) {
  $('online-count').textContent = value.onlineNodes;
  $('online-limit').textContent = '上限 ' + value.maximumNodes;
  $('grace-count').textContent = value.graceNodes;
  $('active-count').textContent = value.activeKeys;
  $('total-count').textContent = '共 ' + value.totalKeys + ' 个';
  $('turn-state').textContent = value.turn ? '已启用' : '未启用';
  $('connection-state').textContent = '可用';
  $('connection-state').className = 'status online';
}

function renderKeys() {
  const target = $('key-list'); target.replaceChildren();
  $('empty').hidden = keys.length !== 0;
  for (const item of keys) {
    const row = document.createElement('tr'), name = document.createElement('td'), slug = document.createElement('td'), authorization = document.createElement('td'), connection = document.createElement('td'), activity = document.createElement('td'), actions = document.createElement('td');
    name.textContent = item.name;
    slug.textContent = item.path;
    slug.className = 'mono';
    authorization.textContent = keyState(item);
    const state = document.createElement('span');
    state.className = 'status ' + (['online', 'authenticated', 'connecting'].includes(item.status) ? 'online' : item.status === 'grace' ? 'warning' : item.status === 'offline' ? 'neutral' : 'error');
    state.textContent = statusLabel(item.status);
    connection.append(state);
    if (item.session) {
      const mode = document.createElement('small'); mode.textContent = (item.session.mode === 'terminal' ? '网页终端' : '开发桌面') + ' · ' + date(item.session.connectedAt); connection.append(mode);
      if (item.session.source) { const source = document.createElement('small'); source.textContent = item.session.source; connection.append(source); }
    }
    activity.textContent = date(item.session?.lastSeenAt);
    actions.className = 'actions';
    if (item.session && !['revoked', 'expired'].includes(item.status)) {
      const disconnect = document.createElement('button'); disconnect.type = 'button'; disconnect.className = 'quiet';
      disconnect.textContent = '断开'; disconnect.addEventListener('click', () => confirmAction('断开节点', '关闭“' + item.name + '”的当前隧道。', () => api('/api/nodes/' + item.slug + '/disconnect', { method: 'POST', body: { revision: item.revision } }).then(load)));
      actions.append(disconnect);
    }
    if (!item.revokedAt) {
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'danger-text';
      revoke.textContent = '撤销'; revoke.addEventListener('click', () => confirmAction('撤销授权', '撤销后现有隧道会关闭，该 key 和节点凭据不能再次接入。', () => api('/api/keys/' + item.id, { method: 'DELETE', body: {} }).then(load)));
      actions.append(revoke);
    }
    row.append(name, slug, authorization, connection, activity, actions); target.append(row);
  }
}

async function load() {
  try {
    const [me, status, list] = await Promise.all([api('/api/me'), api('/api/status'), api('/api/keys')]);
    csrf = me.csrf; keys = list.keys; $('center-host').textContent = me.host; renderStatus(status); renderKeys();
    $('login-view').hidden = true; $('center-view').hidden = false;
    clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 5000);
  } catch (error) {
    clearTimeout(refreshTimer);
    if (error.status === 401) { $('center-view').hidden = true; $('login-view').hidden = false; }
    else { $('connection-state').textContent = '状态不可用'; $('connection-state').className = 'status error'; toast(error.message, true); refreshTimer = setTimeout(load, 5000); }
  }
}

function confirmAction(title, message, action) {
  $('confirm-title').textContent = title; $('confirm-message').textContent = message;
  const dialog = $('confirm-dialog'); $('confirm-action').onclick = async event => {
    event.preventDefault();
    try { $('confirm-action').disabled = true; await action(); dialog.close(); }
    catch (error) { toast(error.message, true); }
    finally { $('confirm-action').disabled = false; }
  };
  dialog.showModal();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const value = await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } });
    csrf = value.csrf; $('password').value = ''; $('login-message').textContent = '使用中心管理员密码登录。'; await load();
  } catch (error) { $('login-message').textContent = error.message; $('login-message').className = 'error'; }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: {} }); } finally { csrf = ''; location.reload(); } });
$('refresh').addEventListener('click', load);
$('new-key').addEventListener('click', () => { $('key-name').value = ''; $('key-slug').value = ''; $('key-never-expires').checked = true; $('expiry-field').hidden = true; $('key-form-error').textContent = ''; $('key-dialog').showModal(); });
$('key-never-expires').addEventListener('change', event => { $('expiry-field').hidden = event.target.checked; });
$('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const expiresAt = $('key-never-expires').checked ? null : new Date($('key-expiry').value).getTime();
  try {
    $('create-key').disabled = true;
    const value = await api('/api/keys', { method: 'POST', body: { name: $('key-name').value, slug: $('key-slug').value, expiresAt } });
    $('key-dialog').close(); $('secret-value').textContent = value.key; $('copy-state').textContent = ''; $('secret-dialog').showModal(); await load();
  } catch (error) { $('key-form-error').textContent = error.message; }
  finally { $('create-key').disabled = false; }
});
$('copy-secret').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('secret-value').textContent); $('copy-state').textContent = '已复制'; } catch { $('copy-state').textContent = '请手动选择复制'; } });
$('secret-close').addEventListener('click', () => $('secret-dialog').close());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
void load();
