const $ = id => document.getElementById(id);
let csrf = '', viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), pollTimer, toastTimer, frameLoaded = false, owned = false, loggedIn = false, pollController = null;
const draftKey = 'codex-cloud.draft';
let inputBusy = false;
try { $('mobile-input').value = sessionStorage.getItem(draftKey) || ''; } catch {}
$('mobile-input').addEventListener('input', () => { try { sessionStorage.setItem(draftKey, $('mobile-input').value); } catch {} });

// One bounded browser preference entry; it contains no terminal text or credentials.
const displayKey = 'codex-cloud.display.v1';
const displayPreferences = { zoom: 'fit', pan: false, collapsed: false };
let displayScale = 0;
try {
  const stored = localStorage.getItem(displayKey);
  if (stored && stored.length <= 256) {
    const value = JSON.parse(stored);
    if (value && (value.zoom === 'fit' || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) && typeof value.pan === 'boolean' && typeof value.collapsed === 'boolean') {
      Object.assign(displayPreferences, { zoom: value.zoom, pan: value.pan, collapsed: value.collapsed });
    }
  }
} catch {}
function sendDisplayPreferences() {
  if (!frameLoaded || !owned) return;
  $('desktop-frame').contentWindow.postMessage({ type: 'codex-desktop-options', zoom: displayPreferences.zoom, pan: displayPreferences.pan }, location.origin);
}
function renderDisplayControls() {
  $('fit-button').setAttribute('aria-pressed', String(displayPreferences.zoom === 'fit'));
  $('actual-size-button').setAttribute('aria-pressed', String(displayPreferences.zoom === 1));
  $('pan-button').setAttribute('aria-pressed', String(displayPreferences.pan));
  $('toggle-input-button').setAttribute('aria-expanded', String(!displayPreferences.collapsed));
  $('toggle-input-button').textContent = displayPreferences.collapsed ? '展开输入' : '收起输入';
  $('input-dock').hidden = displayPreferences.collapsed;
  $('zoom-label').textContent = displayScale ? `${Math.round(displayScale * 100)}%` : '—';
  $('zoom-out-button').disabled = !displayScale || displayScale <= 0.1;
  $('zoom-in-button').disabled = !displayScale || displayScale >= 2;
}
function updateDisplayPreferences(change) {
  Object.assign(displayPreferences, change);
  try { localStorage.setItem(displayKey, JSON.stringify(displayPreferences)); } catch {}
  renderDisplayControls();
  sendDisplayPreferences();
}
$('fit-button').addEventListener('click', () => updateDisplayPreferences({ zoom: 'fit' }));
$('actual-size-button').addEventListener('click', () => updateDisplayPreferences({ zoom: 1 }));
for (const [id, factor] of [['zoom-out-button', 0.8], ['zoom-in-button', 1.25]]) $(id).addEventListener('click', () => {
  if (!displayScale) return;
  updateDisplayPreferences({ zoom: Math.max(0.1, Math.min(2, Math.round(displayScale * factor * 100) / 100)) });
});
$('pan-button').addEventListener('click', () => {
  updateDisplayPreferences({ pan: !displayPreferences.pan });
  toast(displayPreferences.pan ? '拖动模式：移动画面，不会点击远程桌面' : '操作模式：可以点击远程桌面');
});
$('toggle-input-button').addEventListener('click', () => updateDisplayPreferences({ collapsed: !displayPreferences.collapsed }));
renderDisplayControls();

function toast(message, failure = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('failure', failure);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const headers = { 'x-viewer-id': viewer };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual', signal });
  if (response.type === 'opaqueredirect') throw new Error('外层访问验证已过期，请重新打开此页面完成验证');
  const data = await response.json().catch(() => ({}));
  if (!signal?.aborted && response.status === 401 && path !== '/api/login') showLogin();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function overlay(title, description, takeover = false) {
  $('overlay-title').textContent = title;
  $('overlay-description').textContent = description;
  $('takeover-button').hidden = !takeover;
  $('desktop-overlay').hidden = false;
}
function stopFrame() {
  frameLoaded = false;
  displayScale = 0;
  renderDisplayControls();
  $('desktop-frame').hidden = true;
  $('desktop-frame').src = 'about:blank';
}
function stopPolling() {
  clearTimeout(pollTimer);
  pollController?.abort();
  pollController = null;
}
function showLogin() {
  loggedIn = false; owned = false; csrf = '';
  stopPolling();
  stopFrame();
  $('workspace-view').hidden = true;
  $('login-view').hidden = false;
  if ($('files-dialog').open) $('files-dialog').close();
}
function frameUrl() {
  const query = new URLSearchParams({ viewer });
  return `/desktop/index.html?${query}`;
}
function openFrame() {
  if (frameLoaded || !owned) return;
  frameLoaded = true;
  $('desktop-frame').src = frameUrl();
  $('desktop-frame').hidden = false;
  $('desktop-overlay').hidden = true;
}
async function poll() {
  if (!loggedIn || pollController) return;
  const controller = new AbortController();
  pollController = controller;
  clearTimeout(pollTimer);
  try {
    const state = await api('/api/state', { signal: controller.signal });
    if (!loggedIn || pollController !== controller) return;
    const mine = state.mine;
    owned = mine;
    $('connection-status').classList.toggle('offline', !state.desktop.ready || !mine);
    $('connection-status').lastChild.textContent = !mine ? '连接已释放' : state.desktop.ready ? '桌面在线' : '启动中';
    $('version-label').textContent = state.desktop.version;
    if (state.desktop.transferDir) $('transfer-path').textContent = state.desktop.transferDir;
    if (!mine) {
      stopFrame();
      overlay('在这里继续工作', '桌面已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启 Codex。', true);
    } else if (state.desktop.ready) openFrame();
    else if (!frameLoaded) overlay('正在准备桌面', state.desktop.message);
  } catch (error) {
    if (loggedIn && pollController === controller) {
      $('connection-status').classList.add('offline');
      $('connection-status').lastChild.textContent = '等待网络';
      if (!frameLoaded) overlay('等待连接恢复', error.message);
    }
  } finally {
    if (pollController === controller) {
      pollController = null;
      if (loggedIn) pollTimer = setTimeout(poll, 4000);
    }
  }
}
async function claim() {
  await api('/api/desktop/claim', { method: 'POST', body: { viewer } });
  if (!loggedIn) return;
  // A successful claim invalidates every state snapshot fetched before it.
  stopPolling();
  owned = true;
  stopFrame();
  overlay('正在连接桌面', '连接后会回到原来的终端会话。');
  // Let the old iframe unload and close its socket before opening a new viewer.
  await new Promise(resolve => setTimeout(resolve, 300));
  await poll();
}
async function showWorkspace(user) {
  loggedIn = true; csrf = user.csrf;
  $('user-label').textContent = user.username;
  $('password').value = '';
  $('login-view').hidden = true;
  $('workspace-view').hidden = false;
  try { await claim(); } catch (error) { toast(error.message, true); }
}
async function action(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
async function inputAction(work) {
  if (inputBusy) return;
  inputBusy = true;
  const controls = [$('paste-button'), $('terminal-button'), ...document.querySelectorAll('[data-key]')];
  for (const control of controls) control.disabled = true;
  try { await work(); } catch (error) { toast(error.message, true); }
  finally { inputBusy = false; for (const control of controls) control.disabled = false; }
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('login-button'), async () => {
    $('login-error').textContent = '';
    try { await showWorkspace(await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } })); }
    catch (error) { $('login-error').textContent = error.message; }
  });
});
$('logout-button').addEventListener('click', () => void action($('logout-button'), async () => {
  await api('/api/logout', { method: 'POST', body: {} });
  showLogin();
}));
$('takeover-button').addEventListener('click', () => void action($('takeover-button'), claim));
$('reconnect-button').addEventListener('click', () => void action($('reconnect-button'), claim));
$('terminal-button').addEventListener('click', () => void inputAction(async () => {
  await api('/api/terminal', { method: 'POST', body: {} });
  toast('已打开终端，连接原有 tmux 会话');
}));
$('paste-button').addEventListener('click', () => void inputAction(async () => {
  const text = $('mobile-input').value;
  if (!text) return toast('先输入要粘贴的文字');
  await api('/api/paste', { method: 'POST', body: { text, target: $('paste-target').value } });
  toast('已粘贴。确认内容后，按 Enter 提交');
}));
for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => void inputAction(() => api('/api/key', { method: 'POST', body: { key: button.dataset.key } })));
$('fullscreen-button').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(error => toast(error.message, true));
  else if ($('desktop-card').requestFullscreen) $('desktop-card').requestFullscreen().catch(error => toast(error.message, true));
  else toast('此浏览器不支持网页全屏，可以横屏或添加到主屏幕使用');
});

function sizeLabel(size) { return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(size / 1024))} KiB`; }
async function loadFiles() {
  const { files } = await api('/api/files');
  $('file-list').replaceChildren();
  if (!files.length) {
    const empty = document.createElement('p'); empty.className = 'empty-files'; empty.textContent = '还没有中转文件。在桌面中把文件放进 transfer 文件夹，即可在这里下载。'; $('file-list').append(empty);
  }
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const detail = document.createElement('span'); detail.textContent = file.name;
    const info = document.createElement('small'); info.textContent = sizeLabel(file.size); detail.append(info);
    const link = document.createElement('a'); link.href = `/api/files/${encodeURIComponent(file.name)}`; link.textContent = '下载'; link.download = file.name;
    row.append(detail, link); $('file-list').append(row);
  }
}
$('files-button').addEventListener('click', () => void action($('files-button'), async () => { $('files-dialog').showModal(); await loadFiles(); }));
$('close-files').addEventListener('click', () => $('files-dialog').close());
$('refresh-files').addEventListener('click', () => void action($('refresh-files'), loadFiles));
$('upload-input').addEventListener('change', async () => {
  const file = $('upload-input').files[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { toast('文件不能超过 50 MiB', true); $('upload-input').value = ''; return; }
  $('upload-input').disabled = true;
  $('upload-status').textContent = `正在上传 ${file.name}…`;
  try {
    await api(`/api/files/${encodeURIComponent(file.name)}`, { method: 'PUT', raw: file });
    $('upload-status').textContent = '上传完成，文件已放进桌面中转目录。';
    await loadFiles();
  } catch (error) { $('upload-status').textContent = error.message; }
  finally { $('upload-input').disabled = false; $('upload-input').value = ''; }
});
window.addEventListener('online', () => void poll());
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('desktop-frame').contentWindow || !owned) return;
  if (event.data?.type === 'codex-desktop-view') {
    if (Number.isFinite(event.data.scale) && event.data.scale > 0 && event.data.scale <= 16) {
      displayScale = event.data.scale;
      renderDisplayControls();
    }
    return;
  }
  if (event.data?.type !== 'codex-desktop') return;
  if (event.data.state === 'ready') { sendDisplayPreferences(); return; }
  if (!['connected', 'disconnected'].includes(event.data.state)) return;
  if (event.data.state === 'connected') sendDisplayPreferences();
  const connected = event.data.state === 'connected';
  $('connection-status').classList.toggle('offline', !connected);
  $('connection-status').lastChild.textContent = connected ? '桌面在线' : '重新连接中';
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });

try { await showWorkspace(await api('/api/me')); } catch { showLogin(); }
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
