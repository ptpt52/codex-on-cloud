const $ = id => document.getElementById(id);
let csrf = '', viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), pollTimer, toastTimer, frameLoaded = false, owned = false, loggedIn = false, pollController = null;
const draftKey = 'codex-cloud.draft';
let inputBusy = false;
let panelState = 'connecting', desktopReady = null, frameState = 'idle', frameEpoch = 0, frameDimensions = null, accessExpired = false;
let diagnosticsController = null, diagnosticsTimer;
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

function canInput() {
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && desktopReady === true && frameState === 'connected';
}
function renderInputControls() {
  for (const control of [$('paste-button'), $('terminal-button'), ...document.querySelectorAll('[data-key]')]) control.disabled = inputBusy || !canInput();
}
function renderConnection() {
  let label;
  if (accessExpired) label = '访问验证已过期';
  else if (!navigator.onLine || panelState === 'offline') label = '等待网络';
  else if (!owned) label = '等待接管';
  else if (desktopReady === false) label = '桌面未就绪';
  else if (frameState === 'connected') label = '桌面在线';
  else label = frameState === 'reconnecting' ? '画面重连中' : '画面连接中';
  $('connection-status').classList.toggle('offline', label !== '桌面在线');
  $('connection-status').lastChild.textContent = label;
  $('diag-panel').textContent = accessExpired ? '访问验证已过期' : panelState === 'online' ? '可访问' : panelState === 'offline' ? '连接中断' : '等待检测';
  $('diag-desktop').textContent = desktopReady === null ? '等待检测' : desktopReady ? '已就绪' : '未就绪';
  $('diag-frame').textContent = !owned ? '等待接管' : frameState === 'connected' ? '已连接' : frameState === 'reconnecting' ? '重连中' : '等待连接';
  $('diag-resolution').textContent = frameDimensions ? `${frameDimensions.width} × ${frameDimensions.height}${frameState === 'connected' ? '' : '（上次连接）'}` : '等待画面连接';
  renderInputControls();
  if (!loggedIn) return;
  if (accessExpired) {
    overlay('访问验证已过期', '刷新页面完成外层访问验证，然后返回原来的工作会话。');
    $('access-refresh-button').hidden = false;
  } else if (!navigator.onLine || panelState === 'offline') {
    if (frameState !== 'connected') overlay('等待网络恢复', '连接恢复后会继续原来的会话。未确认成功的输入不会自动重发。');
    else $('desktop-overlay').hidden = true;
  } else if (!owned) overlay('在这里继续工作', '桌面已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启 Codex。', true);
  else if (desktopReady === false && frameState !== 'connected') overlay('桌面未就绪', '正在等待桌面服务。网页不会自动重启桌面或重新执行任务。');
  else if (frameState === 'connected') $('desktop-overlay').hidden = true;
  else overlay(label, '正在连接画面，桌面任务继续运行。');
}
function stopDiagnostics() {
  clearTimeout(diagnosticsTimer);
  diagnosticsController?.abort();
  diagnosticsController = null;
}
async function loadDiagnostics() {
  if (!$('connection-dialog').open || !loggedIn || accessExpired || diagnosticsController) return;
  const controller = new AbortController();
  diagnosticsController = controller;
  const timeout = setTimeout(() => controller.abort(new Error('诊断响应超时，请稍后重试')), 6000);
  clearTimeout(diagnosticsTimer);
  try {
    const { tunnel } = await api('/api/diagnostics', { signal: controller.signal });
    if (diagnosticsController !== controller || !$('connection-dialog').open) return;
    $('diag-tunnel').textContent = tunnel?.available ? tunnel.connections > 0 ? `已连接 · ${tunnel.connections} 条连接` : '未建立连接' : '诊断不可用';
    $('diag-families').textContent = tunnel?.available ? `${tunnel.ipv6} / ${tunnel.ipv4}` : '—';
    $('diag-note').textContent = tunnel?.available ? `更新于 ${new Date(tunnel.checkedAt).toLocaleTimeString()}；仅统计当前活动边缘连接。` : 'Tunnel 未启动、未配置或诊断接口暂不可用；这不表示桌面任务已停止。';
  } catch (error) {
    if (diagnosticsController === controller && loggedIn) {
      $('diag-tunnel').textContent = '状态未知';
      $('diag-families').textContent = '—';
      $('diag-note').textContent = error.message;
    }
  } finally {
    clearTimeout(timeout);
    if (diagnosticsController === controller) {
      diagnosticsController = null;
      if ($('connection-dialog').open && loggedIn && !accessExpired) diagnosticsTimer = setTimeout(loadDiagnostics, 5000);
    }
  }
}
function expireAccess() {
  accessExpired = true;
  stopPolling();
  stopFrame();
  stopDiagnostics();
  if ($('connection-dialog').open) $('connection-dialog').close();
  if (loggedIn) renderConnection();
  else showLogin('外层访问验证已过期，请刷新页面完成验证');
}

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
  if (response.type === 'opaqueredirect') {
    if (!signal?.aborted) expireAccess();
    throw new Error('外层访问验证已过期，请刷新页面完成验证');
  }
  const data = await response.json().catch(() => ({}));
  if (!signal?.aborted && response.status === 401 && path !== '/api/login') showLogin(loggedIn ? '登录已过期，请重新登录' : '');
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function overlay(title, description, takeover = false) {
  $('overlay-title').textContent = title;
  $('overlay-description').textContent = description;
  $('takeover-button').hidden = !takeover;
  $('access-refresh-button').hidden = true;
  $('desktop-overlay').hidden = false;
}
function stopFrame() {
  frameLoaded = false;
  frameState = 'idle';
  frameEpoch++;
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
function showLogin(message = '') {
  loggedIn = false; owned = false; csrf = '';
  desktopReady = null; frameDimensions = null; panelState = 'auth';
  stopPolling();
  stopFrame();
  stopDiagnostics();
  $('login-error').textContent = message;
  $('login-refresh-button').hidden = !accessExpired;
  $('workspace-view').hidden = true;
  $('login-view').hidden = false;
  if ($('files-dialog').open) $('files-dialog').close();
  if ($('connection-dialog').open) $('connection-dialog').close();
  renderConnection();
}
function frameUrl() {
  const query = new URLSearchParams({ viewer, frame: String(frameEpoch) });
  return `/desktop/index.html?${query}`;
}
function openFrame() {
  if (frameLoaded || !owned) return;
  frameLoaded = true;
  frameState = 'connecting';
  $('desktop-frame').src = frameUrl();
  $('desktop-frame').hidden = false;
  renderConnection();
}
async function poll() {
  if (!loggedIn || accessExpired || pollController) return;
  const controller = new AbortController();
  pollController = controller;
  const timeout = setTimeout(() => controller.abort(new Error('网络响应超时，请稍后重试')), 8000);
  clearTimeout(pollTimer);
  try {
    const state = await api('/api/state', { signal: controller.signal });
    if (!loggedIn || pollController !== controller) return;
    const mine = state.mine;
    owned = mine;
    panelState = 'online';
    desktopReady = state.desktop.ready === true;
    $('version-label').textContent = state.desktop.version;
    if (state.desktop.transferDir) $('transfer-path').textContent = state.desktop.transferDir;
    if (!mine) {
      stopFrame();
    } else if (state.desktop.ready) openFrame();
    renderConnection();
  } catch (error) {
    if (loggedIn && pollController === controller) {
      panelState = 'offline';
      renderConnection();
    }
  } finally {
    clearTimeout(timeout);
    if (pollController === controller) {
      pollController = null;
      if (loggedIn && !accessExpired) pollTimer = setTimeout(poll, 4000);
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
  renderConnection();
  // Let the old iframe unload and close its socket before opening a new viewer.
  await new Promise(resolve => setTimeout(resolve, 300));
  await poll();
}
async function showWorkspace(user) {
  loggedIn = true; csrf = user.csrf;
  accessExpired = false; panelState = 'online'; desktopReady = null;
  $('user-label').textContent = user.username;
  $('password').value = '';
  $('login-view').hidden = true;
  $('workspace-view').hidden = false;
  try { await claim(); } catch (error) {
    if (loggedIn && !accessExpired) {
      panelState = 'offline'; renderConnection();
      pollTimer = setTimeout(poll, 4000);
    }
    toast(error.message, true);
  }
}
async function action(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
async function inputAction(work) {
  if (inputBusy || !canInput()) return;
  inputBusy = true;
  renderInputControls();
  try { await work(); } catch (error) { toast(error.message, true); }
  finally { inputBusy = false; renderInputControls(); }
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
window.addEventListener('offline', () => {
  if (!loggedIn) return;
  stopPolling();
  panelState = 'offline';
  renderConnection();
  pollTimer = setTimeout(poll, 4000);
});
$('connection-button').addEventListener('click', () => {
  $('connection-dialog').showModal();
  renderConnection();
  void loadDiagnostics();
});
$('close-connection').addEventListener('click', () => $('connection-dialog').close());
$('connection-dialog').addEventListener('close', stopDiagnostics);
$('refresh-connection').addEventListener('click', () => { void poll(); void loadDiagnostics(); });
for (const id of ['access-refresh-button', 'login-refresh-button']) $(id).addEventListener('click', () => location.reload());
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('desktop-frame').contentWindow || !owned) return;
  if (event.data?.frame !== String(frameEpoch) || !frameLoaded) return;
  if (event.data?.type === 'codex-desktop-view') {
    if (Number.isFinite(event.data.scale) && event.data.scale > 0 && event.data.scale <= 16) {
      displayScale = event.data.scale;
      renderDisplayControls();
    }
    if (Number.isInteger(event.data.width) && Number.isInteger(event.data.height) && event.data.width > 0 && event.data.height > 0 && event.data.width <= 16384 && event.data.height <= 16384) frameDimensions = { width: event.data.width, height: event.data.height };
    renderConnection();
    return;
  }
  if (event.data?.type !== 'codex-desktop') return;
  if (event.data.state === 'ready') { sendDisplayPreferences(); return; }
  if (event.data.state === 'connected') { frameState = 'connected'; sendDisplayPreferences(); }
  else if (event.data.state === 'disconnected') frameState = 'reconnecting';
  else if (event.data.state === 'connecting') { if (frameState !== 'reconnecting') frameState = 'connecting'; }
  else return;
  renderConnection();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });

try { await showWorkspace(await api('/api/me')); } catch (error) { showLogin(accessExpired ? error.message : ''); }
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
