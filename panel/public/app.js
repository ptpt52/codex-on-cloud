const $ = id => document.getElementById(id);
let csrf = '', viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), pollTimer, toastTimer, frameLoaded = false, owned = false, loggedIn = false, pollController = null;
const draftKey = 'codex-cloud.draft';
let inputBusy = false;
let inputController = null, inputFeedback = false, maintenancePending = false;
let controlsState = { available: false, maintenance: false, inputBusy: false };
let clipboardController = null, clipboardGeneration = 0, clipboardCopyBusy = false, clipboardText = '';
let panelState = 'connecting', desktopReady = null, frameState = 'idle', frameEpoch = 0, frameDimensions = null, accessExpired = false;
let diagnosticsController = null, diagnosticsTimer;
let frameTransport = '';
let controlReady = false, controlPending = null, controlSequence = 0;
let transportSwitching = false, switchTimer;
let desktopSettings = null, settingsController = null, settingsTimer, settingsBusy = false;
let viewportTimer, viewportController, viewportWaiter, viewportApplied = '', viewportResizing = false, nativeIdle = false;
try { $('mobile-input').value = sessionStorage.getItem(draftKey) || ''; } catch {}
$('mobile-input').addEventListener('input', () => { try { sessionStorage.setItem(draftKey, $('mobile-input').value); } catch {} });

// One bounded browser preference entry; it contains no terminal text or credentials.
const displayKey = 'codex-cloud.display.v1';
const displayPreferences = { layout: 2, zoom: 'width', pan: false, collapsed: false, controlsCollapsed: false, autoResolution: false };
const followsViewport = () => displayPreferences.autoResolution;
const fixedSize = () => controlsState.viewport?.fixed || { width: 1600, height: 3200 };
let displayScale = 0, displayRevision = 0, scaleRevision = -1;
try {
  const stored = localStorage.getItem(displayKey);
  if (stored && stored.length <= 256) {
    const value = JSON.parse(stored);
    if (value && (['fit', 'width'].includes(value.zoom) || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) && typeof value.pan === 'boolean' && typeof value.collapsed === 'boolean' && (value.controlsCollapsed === undefined || typeof value.controlsCollapsed === 'boolean')) {
      Object.assign(displayPreferences, { pan: value.pan, collapsed: value.collapsed, controlsCollapsed: value.controlsCollapsed === true });
      if (value.layout === 2) {
        displayPreferences.zoom = value.zoom;
        if (typeof value.autoResolution === 'boolean') displayPreferences.autoResolution = value.autoResolution;
      }
    }
  }
} catch {}
function sendDisplayPreferences() {
  if (!frameLoaded || !owned) return;
  $('desktop-frame').contentWindow.postMessage({ type: 'codex-desktop-options', zoom: displayPreferences.zoom, pan: displayPreferences.pan, blocked: inputPaused(),
    handoff: (transportSwitching || viewportResizing) && !maintenancePending && !controlsState.maintenance && controlsState.available,
    busy: inputBusy || !!clipboardController || controlsState.inputBusy || controlsState.clipboardBusy || settingsBusy, revision: displayRevision }, location.origin);
}
function zoomBase() { return typeof displayPreferences.zoom === 'number' ? displayPreferences.zoom : scaleRevision === displayRevision ? displayScale : 0; }
function renderDisplayControls() {
  $('auto-resolution').checked = followsViewport();
  const fixed = fixedSize(), maximum = controlsState.viewport?.maximum;
  const needsRestart = maximum && (maximum.width < fixed.width || maximum.height < fixed.height);
  $('viewport-note').textContent = controlsState.viewport?.supported
    ? followsViewport() ? '分辨率随当前可用画面区域调整，无需重启；超过显示上限时等比例适配。'
      : `固定使用 ${fixed.width} × ${fixed.height} 桌面，按宽度缩放，上下滚动查看。${needsRestart ? '当前显示上限不足，需确认重启桌面后启用此尺寸。' : '窗口和键盘变化不改变远端尺寸。'}`
    : '当前显示暂未提供动态分辨率，画面继续等比例缩放。';
  $('width-button').setAttribute('aria-pressed', String(displayPreferences.zoom === 'width'));
  $('fit-button').setAttribute('aria-pressed', String(displayPreferences.zoom === 'fit'));
  $('actual-size-button').setAttribute('aria-pressed', String(displayPreferences.zoom === 1));
  $('pan-button').setAttribute('aria-pressed', String(displayPreferences.pan));
  $('toggle-input-button').setAttribute('aria-expanded', String(!displayPreferences.collapsed));
  $('toggle-input-button').textContent = displayPreferences.collapsed ? '展开输入' : '收起输入';
  $('input-dock').hidden = displayPreferences.collapsed;
  $('desktop-actions').hidden = displayPreferences.controlsCollapsed;
  $('display-controls').hidden = displayPreferences.controlsCollapsed;
  $('desktop-card').classList.toggle('controls-collapsed', displayPreferences.controlsCollapsed);
  $('toggle-controls-button').setAttribute('aria-expanded', String(!displayPreferences.controlsCollapsed));
  $('toggle-controls-button').textContent = displayPreferences.controlsCollapsed ? '展开控件' : '收起控件';
  const base = zoomBase(), ready = frameLoaded && frameState === 'connected';
  $('zoom-label').textContent = base ? `${Math.round(base * 100)}%` : '—';
  $('zoom-out-button').disabled = !ready || !base || base <= 0.1;
  $('zoom-in-button').disabled = !ready || !base || base >= 2;
}
function updateDisplayPreferences(change) {
  if (change.zoom !== undefined && change.zoom !== displayPreferences.zoom) displayRevision++;
  Object.assign(displayPreferences, change);
  try { localStorage.setItem(displayKey, JSON.stringify(displayPreferences)); } catch {}
  renderDisplayControls();
  sendDisplayPreferences();
  scheduleViewport();
}
$('fit-button').addEventListener('click', () => updateDisplayPreferences({ zoom: 'fit' }));
$('width-button').addEventListener('click', () => updateDisplayPreferences({ zoom: 'width' }));
$('actual-size-button').addEventListener('click', () => updateDisplayPreferences({ zoom: 1 }));
for (const [id, factor] of [['zoom-out-button', 0.8], ['zoom-in-button', 1.25]]) $(id).addEventListener('click', () => {
  const base = zoomBase();
  if (!base || $(id).disabled) return;
  updateDisplayPreferences({ zoom: Math.max(0.1, Math.min(2, Math.round(base * factor * 100) / 100)) });
});
$('pan-button').addEventListener('click', () => {
  updateDisplayPreferences({ pan: !displayPreferences.pan });
  toast(displayPreferences.pan ? '拖动模式：移动画面，不会点击远程桌面' : '操作模式：可以点击远程桌面');
});
$('toggle-input-button').addEventListener('click', () => updateDisplayPreferences({ collapsed: !displayPreferences.collapsed }));
$('toggle-controls-button').addEventListener('click', () => updateDisplayPreferences({ controlsCollapsed: !displayPreferences.controlsCollapsed }));
renderDisplayControls();

function inputPaused() { return viewportResizing || controlsState.viewportBusy || transportSwitching || maintenancePending || controlsState.maintenance || !controlsState.available; }
function scheduleViewport(delay = 500) {
  clearTimeout(viewportTimer);
  if (!loggedIn || !owned || !frameLoaded || frameState !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
  viewportTimer = setTimeout(resizeViewport, delay);
}
function waitForViewport(actual, signal) {
  if (!actual || ![actual.width, actual.height].every(value => Number.isInteger(value) && value >= 160 && value <= 4096)) return Promise.reject(new Error('显示尺寸无效'));
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (viewportWaiter === check) viewportWaiter = undefined;
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('窗口适配已取消'));
    const check = () => { if (frameDimensions?.width === actual.width && frameDimensions?.height === actual.height) finish(); };
    const timer = setTimeout(() => finish(new Error('等待画面尺寸更新超时')), 3000);
    viewportWaiter = check; signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}
async function resizeViewport() {
  viewportTimer = null;
  if (!loggedIn || !owned || !frameLoaded || frameState !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
  if (!nativeIdle || inputPaused() || inputBusy || clipboardController || controlsState.inputBusy || controlsState.clipboardBusy || settingsBusy || document.hidden) { scheduleViewport(1000); return; }
  const rect = $('desktop-stage').getBoundingClientRect();
  const size = followsViewport() ? { width: Math.min(8192, Math.max(160, Math.floor(rect.width))), height: Math.min(8192, Math.max(160, Math.floor(rect.height))) } : fixedSize();
  if (!followsViewport() && (controlsState.viewport.maximum.width < size.width || controlsState.viewport.maximum.height < size.height)) return;
  const signature = `${frameEpoch}:${size.width}x${size.height}`;
  if (signature === viewportApplied) return;
  if (frameDimensions?.width === size.width && frameDimensions?.height === size.height) { viewportApplied = signature; return; }
  const controller = viewportController = new AbortController(), epoch = frameEpoch;
  const timer = setTimeout(() => controller.abort(), 7000);
  viewportResizing = true; renderInputControls(); sendDisplayPreferences();
  try {
    const result = await api('/api/desktop/viewport', { method: 'POST', body: size, signal: controller.signal });
    clearTimeout(timer);
    await waitForViewport(result.actual, controller.signal);
    if (viewportController === controller && frameEpoch === epoch) viewportApplied = signature;
  } catch (error) {
    if (viewportController === controller && !controller.signal.aborted && error.status !== 409) $('viewport-note').textContent = '本次窗口适配未完成，当前任务继续运行；稍后会重新检查。';
  } finally {
    clearTimeout(timer);
    if (viewportController === controller) {
      viewportController = null; viewportResizing = false;
      renderInputControls(); renderDesktopSettings(); sendDisplayPreferences(); scheduleViewport(2000);
    }
  }
}
new ResizeObserver(() => scheduleViewport()).observe($('desktop-stage'));
$('auto-resolution').addEventListener('change', () => {
  const enabled = $('auto-resolution').checked;
  updateDisplayPreferences({ autoResolution: enabled, zoom: enabled ? 'fit' : 'width' });
  renderDesktopSettings(); scheduleViewport();
});
function canInput() {
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && desktopReady === true && frameState === 'connected' && !inputPaused() && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardController;
}
function renderInputControls() {
  for (const control of [$('paste-button'), $('terminal-button'), ...document.querySelectorAll('[data-key]')]) control.disabled = inputBusy || !canInput();
  sendDisplayPreferences();
}
function renderConnection() {
  let label;
  if (accessExpired) label = '访问验证已过期';
  else if (!navigator.onLine || panelState === 'offline') label = '等待网络';
  else if (!owned) label = '等待接管';
  else if (desktopReady === false) label = '桌面未就绪';
  else if (transportSwitching) label = '正在切换局域网';
  else if (maintenancePending || controlsState.maintenance) label = '桌面操作进行中';
  else if (!controlsState.available) label = '输入服务未就绪';
  else if (frameState === 'connected') label = '桌面在线';
  else label = frameState === 'reconnecting' ? '画面重连中' : '画面连接中';
  $('connection-status').classList.toggle('offline', label !== '桌面在线');
  $('connection-status').lastChild.textContent = label;
  $('diag-panel').textContent = accessExpired ? '访问验证已过期' : panelState === 'online' ? '可访问' : panelState === 'offline' ? '连接中断' : '等待检测';
  $('diag-desktop').textContent = desktopReady === null ? '等待检测' : desktopReady ? '已就绪' : '未就绪';
  $('diag-frame').textContent = !owned ? '等待接管' : frameState === 'connected' ? '已连接' : frameState === 'reconnecting' ? '重连中' : '等待连接';
  $('diag-transport').textContent = frameState !== 'connected' ? '等待画面连接' : frameTransport === 'direct' ? 'WebRTC 加密直连' : 'HTTPS / WebSocket 中转';
  $('diag-input-transport').textContent = frameState !== 'connected' ? '等待画面连接' : controlReady ? '局域网加密直连' : 'HTTPS';
  $('diag-resolution').textContent = frameDimensions ? `${frameDimensions.width} × ${frameDimensions.height}${frameState === 'connected' ? '' : '（上次连接）'}` : '等待画面连接';
  renderInputControls();
  renderDisplayControls();
  renderDesktopSettings();
  renderClipboard();
  sendDisplayPreferences();
  if (!loggedIn) return;
  if (accessExpired) {
    overlay('访问验证已过期', '刷新页面完成外层访问验证，然后返回原来的工作会话。');
    $('access-refresh-button').hidden = false;
  } else if (!navigator.onLine || panelState === 'offline') {
    if (frameState !== 'connected') overlay('等待网络恢复', '连接恢复后会继续原来的会话。未确认成功的输入不会自动重发。');
    else $('desktop-overlay').hidden = true;
  } else if (!owned) overlay('在这里继续工作', '桌面已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启 Codex。', true);
  else if (desktopReady === false && frameState !== 'connected') overlay('桌面未就绪', '正在等待桌面服务。网页不会自动重启桌面或重新执行任务。');
  else if ((viewportResizing || controlsState.viewportBusy) && frameState === 'connected') $('desktop-overlay').hidden = true;
  else if (inputPaused()) overlay(label, '输入暂时暂停。当前操作完成后恢复，不会自动重发输入。');
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
  if (!response.ok) { const error = new Error(data.error || `请求失败（${response.status}）`); error.outcome = data.outcome; throw error; }
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
  clearTimeout(viewportTimer); viewportController?.abort(); viewportController = null; viewportResizing = false; viewportApplied = ''; nativeIdle = false;
  clearTimeout(switchTimer); transportSwitching = false;
  resetDirectControl();
  frameLoaded = false;
  frameState = 'idle';
  frameTransport = '';
  frameEpoch++;
  displayScale = 0;
  scaleRevision = -1;
  renderDisplayControls();
  $('desktop-frame').hidden = true;
  $('desktop-frame').src = 'about:blank';
}
function finishDirectControl(error, value) {
  if (!controlPending) return;
  const pending = controlPending; controlPending = null;
  clearTimeout(pending.timer);
  pending.signal?.removeEventListener('abort', pending.abort);
  error ? pending.reject(error) : pending.resolve(value);
}
function resetDirectControl() {
  controlReady = false;
  finishDirectControl(Object.assign(new Error('连接已变化，操作结果未知，请先查看桌面确认'), { outcome: 'unknown' }));
}
function assistantRequest(path, body, signal) {
  const action = { '/api/paste': 'paste', '/api/key': 'key', '/api/clipboard/read': 'clipboard' }[path];
  if (!controlReady || !action) return api(path, { method: 'POST', body, signal });
  if (controlPending || signal?.aborted || controlSequence >= 2147483647) return Promise.reject(Object.assign(new Error('直连通道未就绪，本次操作未发送'), { outcome: 'rejected' }));
  return new Promise((resolve, reject) => {
    const id = ++controlSequence;
    const abort = () => {
      $('desktop-frame').contentWindow.postMessage({ type: 'codex-control-cancel', frame: String(frameEpoch), id }, location.origin);
      finishDirectControl(Object.assign(new Error('直连操作结果未知，请先查看桌面确认'), { outcome: 'unknown' }));
    };
    controlPending = { id, resolve, reject, signal, abort, timer: setTimeout(abort, 8000) };
    signal?.addEventListener('abort', abort, { once: true });
    $('desktop-frame').contentWindow.postMessage({ type: 'codex-control-request', frame: String(frameEpoch), id, action, body }, location.origin);
  });
}
function stopPolling() {
  clearTimeout(pollTimer);
  pollController?.abort();
  pollController = null;
}
function showLogin(message = '') {
  clearClipboard();
  inputController?.abort(); inputController = null; inputBusy = false; inputFeedback = false;
  controlsState = { available: false, maintenance: false, inputBusy: false };
  maintenancePending = false;
  $('input-status').hidden = true;
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
  if ($('desktop-settings-dialog').open) $('desktop-settings-dialog').close();
  if ($('clipboard-dialog').open) $('clipboard-dialog').close();
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
    controlsState = state.controls || { available: false, maintenance: false, inputBusy: false };
    scheduleViewport();
    if (!inputBusy && !inputFeedback && controlsState.input?.status === 'unknown') inputMessage('unknown', '上一项输入结果未知，请先查看桌面确认，避免重复执行。');
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
      if (loggedIn && !accessExpired) pollTimer = setTimeout(poll, controlsState.maintenance || controlsState.inputBusy || controlsState.clipboardBusy || controlsState.viewportBusy || maintenancePending ? 800 : 4000);
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
function inputMessage(outcome, message) {
  inputFeedback = true;
  $('input-status').hidden = false;
  $('input-status').dataset.outcome = outcome;
  $('input-status').textContent = message;
}
async function inputAction(path, body, label, success) {
  if (inputBusy || !canInput()) return;
  const controller = new AbortController(); inputController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  inputBusy = true;
  inputMessage('pending', `正在${label}…`);
  renderInputControls();
  renderDesktopSettings();
  try {
    const result = await assistantRequest(path, body, controller.signal);
    if (inputController !== controller) return;
    if (result.outcome !== 'success') throw new Error('missing input result');
    inputMessage('success', success);
  } catch (error) {
    if (inputController === controller) inputMessage(error.outcome === 'rejected' ? 'rejected' : 'unknown', error.outcome === 'rejected' ? `未发送：${error.message}` : `${label}结果未知，请先查看桌面确认，避免重复执行。`);
  } finally {
    clearTimeout(timeout);
    if (inputController === controller) { inputController = null; inputBusy = false; renderInputControls(); renderDesktopSettings(); }
  }
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
$('terminal-button').addEventListener('click', () => void inputAction('/api/terminal', {}, '打开终端', '已打开终端，连接原有 tmux 会话'));
$('paste-button').addEventListener('click', () => {
  const text = $('mobile-input').value;
  if (!text) return inputMessage('rejected', '先输入要粘贴的文字');
  void inputAction('/api/paste', { text, target: $('paste-target').value }, '粘贴', '已粘贴。确认内容后，按 Enter 提交');
});
for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => void inputAction('/api/key', { key: button.dataset.key }, '发送按键', `${button.textContent.trim()} 已发送`));
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
function clipboardAccess() {
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && !inputPaused();
}
function clearClipboard() {
  clipboardController?.abort(); clipboardController = null;
  clipboardGeneration++; clipboardCopyBusy = false;
  clipboardText = '';
  $('clipboard-preview').value = '';
  $('clipboard-meta').textContent = '';
  $('clipboard-status').textContent = '';
}
function renderClipboard() {
  const accessible = clipboardAccess();
  if (!accessible) clearClipboard();
  const readable = accessible && !inputBusy && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardController;
  $('clipboard-button').disabled = !readable;
  $('read-clipboard').disabled = !readable;
  $('copy-clipboard').disabled = !accessible || !clipboardText || clipboardCopyBusy;
  $('select-clipboard').disabled = !accessible || !$('clipboard-preview').value;
}
$('clipboard-button').addEventListener('click', async () => {
  if ($('clipboard-button').disabled) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  clearClipboard();
  $('clipboard-dialog').showModal();
  $('clipboard-status').textContent = '只在点击读取时获取；关闭窗口会清空预览。';
  renderClipboard();
});
$('close-clipboard').addEventListener('click', () => $('clipboard-dialog').close());
$('clipboard-dialog').addEventListener('close', () => { clearClipboard(); renderInputControls(); renderDesktopSettings(); renderClipboard(); });
$('clipboard-source').addEventListener('change', () => { clearClipboard(); renderClipboard(); renderInputControls(); renderDesktopSettings(); });
$('read-clipboard').addEventListener('click', async () => {
  if ($('read-clipboard').disabled) return;
  clearClipboard();
  const controller = new AbortController(), source = $('clipboard-source').value;
  clipboardController = controller;
  const timeout = setTimeout(() => controller.abort(new Error('读取超时，请手动重试')), 8000);
  $('clipboard-status').textContent = '正在读取远程文字…';
  renderClipboard(); renderInputControls(); renderDesktopSettings();
  try {
    const result = await assistantRequest('/api/clipboard/read', { source }, controller.signal);
    if (clipboardController !== controller || !$('clipboard-dialog').open || !clipboardAccess()) return;
    if (result.source !== source || typeof result.text !== 'string' || result.text.length > 32768 || result.text.includes('\0') || new TextEncoder().encode(result.text).length > 32768) throw new Error('远程文字格式或大小无效');
    clipboardText = result.text;
    $('clipboard-preview').value = result.text;
    $('clipboard-meta').textContent = `${source === 'clipboard' ? '远程剪贴板' : '选中文字'} · ${new TextEncoder().encode(result.text).length} 字节`;
    $('clipboard-status').textContent = result.text ? '已读取，请预览后复制到本机。' : '当前内容为空，请在远程桌面复制或选中文字后手动读取。';
  } catch (error) {
    if (clipboardController === controller) $('clipboard-status').textContent = controller.signal.aborted ? '读取超时，请手动重试。' : error.message;
  } finally {
    clearTimeout(timeout);
    if (clipboardController === controller) { clipboardController = null; renderClipboard(); renderInputControls(); renderDesktopSettings(); }
  }
});
function selectClipboardText() {
  $('clipboard-preview').focus(); $('clipboard-preview').select();
  $('clipboard-preview').setSelectionRange(0, $('clipboard-preview').value.length);
}
$('select-clipboard').addEventListener('click', () => {
  if ($('select-clipboard').disabled) return;
  selectClipboardText();
  $('clipboard-status').textContent = '已选中文字，请长按或使用系统的复制操作。';
});
$('copy-clipboard').addEventListener('click', async () => {
  if ($('copy-clipboard').disabled) return;
  const generation = clipboardGeneration;
  clipboardCopyBusy = true; renderClipboard();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(clipboardText);
    if (generation === clipboardGeneration && $('clipboard-dialog').open && clipboardAccess()) $('clipboard-status').textContent = '已复制到本机剪贴板。';
  } catch {
    if (generation === clipboardGeneration && $('clipboard-dialog').open && clipboardAccess()) {
      selectClipboardText();
      $('clipboard-status').textContent = '浏览器未允许自动复制，文字已选中，请长按或使用系统的复制操作。';
    }
  } finally { if (generation === clipboardGeneration) { clipboardCopyBusy = false; renderClipboard(); } }
});
window.addEventListener('pagehide', clearClipboard);
function settingsValues() {
  return { width: Number($('desktop-width').value), height: Number($('desktop-height').value), fontSize: Number($('terminal-font-size').value) };
}
function settingsDirty() {
  const value = settingsValues();
  return !desktopSettings || ['width', 'height', 'fontSize'].some(key => value[key] !== desktopSettings.saved[key]);
}
function renderDesktopSettings() {
  const writable = loggedIn && owned && !accessExpired && !transportSwitching && panelState === 'online' && controlsState.available && !controlsState.maintenance && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardController && !inputBusy && desktopSettings && !settingsBusy && !desktopSettings.busy;
  const adaptive = followsViewport() && controlsState.viewport?.supported;
  for (const id of ['resolution-preset', 'desktop-width', 'desktop-height']) $(id).disabled = !!adaptive || viewportResizing;
  const dirty = settingsDirty();
  $('save-desktop-settings').disabled = !writable || !dirty;
  for (const id of ['apply-terminal-font', 'maximize-terminal', 'restore-terminal']) $(id).disabled = !writable || (id === 'apply-terminal-font' && dirty);
  $('apply-desktop-settings').disabled = !!adaptive || !writable || dirty || !desktopSettings?.restartRequired || !desktopSettings?.session?.recoverable || !$('confirm-desktop-restart').checked;
  if (!desktopSettings) return;
  const { actual, saved, session, job } = desktopSettings;
  $('settings-current').textContent = actual ? `当前实际分辨率：${actual.width} × ${actual.height}` : '桌面尚未就绪，仍可保存下次启动的配置。';
  $('settings-pending').textContent = adaptive ? '桌面尺寸正在跟随浏览器窗口；关闭此选项后使用固定尺寸。'
    : desktopSettings.restartRequired ? `固定桌面：${saved.width} × ${saved.height}；当前显示上限不足时需显式重启。` : `已保存：${saved.width} × ${saved.height}；当前分辨率无需重启。`;
  $('settings-recovery').textContent = session?.resumeId ? `将恢复会话 ${session.resumeId}，项目：${session.cwd}` : session?.recoverable ? '当前为 shell，重启后打开新的 shell，不自动启动任务。' : '当前会话无法准确识别或存在多个窗格。结束前台任务后再应用分辨率。';
  $('apply-desktop-settings').textContent = session?.resumeId ? '重启桌面并恢复会话' : '重启桌面应用设置';
  if (job) $('desktop-settings-status').textContent = job.message;
}
function stopSettingsPolling() {
  clearTimeout(settingsTimer);
  settingsController?.abort(); settingsController = null;
}
async function loadDesktopSettings(resetForm = false) {
  if (!$('desktop-settings-dialog').open || settingsController || !loggedIn) return;
  const controller = new AbortController(); settingsController = controller;
  const timeout = setTimeout(() => controller.abort(new Error('读取设置超时，请手动刷新')), 8000);
  clearTimeout(settingsTimer);
  try {
    const next = await api('/api/desktop/settings', { signal: controller.signal });
    if (settingsController !== controller || !$('desktop-settings-dialog').open) return;
    const fill = resetForm || !desktopSettings || !settingsDirty();
    if (desktopSettings?.revision !== next.revision || desktopSettings?.session?.pid !== next.session?.pid) $('confirm-desktop-restart').checked = false;
    desktopSettings = next;
    if (fill) {
      $('desktop-width').value = next.saved.width; $('desktop-height').value = next.saved.height; $('terminal-font-size').value = next.saved.fontSize;
      const size = `${next.saved.width}x${next.saved.height}`;
      $('resolution-preset').value = ['1280x1280', '1600x1600', '1600x3200', '1920x1600'].includes(size) ? size : 'custom';
    }
    renderDesktopSettings();
    if (next.busy) settingsTimer = setTimeout(() => void loadDesktopSettings(), 800);
  } catch (error) {
    if (settingsController === controller && loggedIn) $('desktop-settings-status').textContent = error.message;
  } finally { clearTimeout(timeout); if (settingsController === controller) settingsController = null; }
}
async function settingsAction(path, body) {
  if (settingsBusy || !desktopSettings || !loggedIn || !owned) return;
  stopSettingsPolling();
  const pausesInput = path.endsWith('/apply') || (path.endsWith('/terminal-display') && body.action === 'font');
  if (pausesInput) { maintenancePending = true; controlsState = { ...controlsState, maintenance: true }; renderConnection(); }
  settingsBusy = true; renderDesktopSettings();
  try {
    const result = await api(path, { method: 'POST', body, signal: AbortSignal.timeout(10000) });
    if (result.job) desktopSettings = { ...desktopSettings, job: result.job, busy: true };
    else $('desktop-settings-status').textContent = '已保存。分辨率与字号需分别显式应用。';
    $('confirm-desktop-restart').checked = false;
    stopSettingsPolling();
    await loadDesktopSettings(true);
  } catch (error) { $('desktop-settings-status').textContent = error.message; }
  finally {
    settingsBusy = false;
    if (pausesInput) { maintenancePending = false; stopPolling(); void poll(); }
    renderConnection();
  }
}
$('desktop-settings-button').addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  $('desktop-settings-dialog').showModal();
  $('desktop-settings-status').textContent = '';
  $('confirm-desktop-restart').checked = false;
  await loadDesktopSettings(true);
});
$('close-desktop-settings').addEventListener('click', () => $('desktop-settings-dialog').close());
$('desktop-settings-dialog').addEventListener('close', stopSettingsPolling);
$('refresh-desktop-settings').addEventListener('click', () => { if (settingsBusy) return; $('confirm-desktop-restart').checked = false; stopSettingsPolling(); void loadDesktopSettings(true); });
$('resolution-preset').addEventListener('change', () => {
  if ($('resolution-preset').value !== 'custom') {
    const [width, height] = $('resolution-preset').value.split('x');
    $('desktop-width').value = width; $('desktop-height').value = height;
  }
  $('confirm-desktop-restart').checked = false; renderDesktopSettings();
});
for (const id of ['desktop-width', 'desktop-height', 'terminal-font-size']) $(id).addEventListener('input', () => {
  const size = `${$('desktop-width').value}x${$('desktop-height').value}`;
  $('resolution-preset').value = ['1280x1280', '1600x1600', '1600x3200', '1920x1600'].includes(size) ? size : 'custom';
  $('confirm-desktop-restart').checked = false; renderDesktopSettings();
});
$('confirm-desktop-restart').addEventListener('change', renderDesktopSettings);
$('desktop-settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('save-desktop-settings').disabled && $('desktop-settings-form').reportValidity()) void settingsAction('/api/desktop/settings', { ...settingsValues(), revision: desktopSettings.revision });
});
$('apply-desktop-settings').addEventListener('click', () => {
  if ($('apply-desktop-settings').disabled) return;
  void settingsAction('/api/desktop/apply', { revision: desktopSettings.revision, panePid: desktopSettings.session.pid, resumeId: desktopSettings.session.resumeId, confirm: $('confirm-desktop-restart').checked });
});
for (const [id, action] of [['apply-terminal-font', 'font'], ['maximize-terminal', 'maximize'], ['restore-terminal', 'restore']]) $(id).addEventListener('click', () => {
  if (!$(id).disabled) void settingsAction('/api/desktop/terminal-display', { action, revision: desktopSettings.revision });
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('desktop-frame').contentWindow || !owned) return;
  if (event.data?.frame !== String(frameEpoch) || !frameLoaded) return;
  if (event.data?.type === 'codex-direct-prepare') {
    if (!Number.isSafeInteger(event.data.id) || event.data.id < 1) return;
    const allowed = loggedIn && owned && !accessExpired && panelState === 'online' && frameState === 'connected' && !inputPaused() && !inputBusy && !clipboardController && !$('clipboard-dialog').open && !controlPending && !settingsBusy && !controlsState.inputBusy && !controlsState.clipboardBusy;
    if (allowed) {
      transportSwitching = true;
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => { transportSwitching = false; renderConnection(); }, 15000);
      renderConnection();
    }
    $('desktop-frame').contentWindow.postMessage({ type: 'codex-direct-approved', frame: String(frameEpoch), id: event.data.id, allowed }, location.origin);
    return;
  }
  if (event.data?.type === 'codex-direct-finished') {
    clearTimeout(switchTimer); transportSwitching = false; renderConnection(); return;
  }
  if (event.data?.type === 'codex-control-state') {
    controlReady = event.data.ready === true && frameState === 'connected' && frameTransport === 'direct';
    if (!controlReady) resetDirectControl();
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-control-result') {
    if (!controlPending || event.data.id !== controlPending.id) return;
    const error = event.data.ok === true ? null : Object.assign(new Error(event.data.error?.message || '直连操作失败'), { outcome: event.data.error?.outcome || 'unknown', status: event.data.error?.status });
    finishDirectControl(error, event.data.value); return;
  }
  if (event.data?.type === 'codex-desktop-view') {
    if (event.data.revision !== displayRevision) return;
    nativeIdle = event.data.idle === true;
    if (nativeIdle) scheduleViewport();
    if (Number.isFinite(event.data.scale) && event.data.scale > 0 && event.data.scale <= 16) {
      displayScale = event.data.scale;
      scaleRevision = event.data.revision;
      renderDisplayControls();
    }
    if (Number.isInteger(event.data.width) && Number.isInteger(event.data.height) && event.data.width > 0 && event.data.height > 0 && event.data.width <= 16384 && event.data.height <= 16384) frameDimensions = { width: event.data.width, height: event.data.height };
    viewportWaiter?.();
    renderConnection();
    return;
  }
  if (event.data?.type !== 'codex-desktop') return;
  if (event.data.state === 'ready') { sendDisplayPreferences(); return; }
  if (event.data.state === 'connected') { frameState = 'connected'; frameTransport = event.data.transport === 'direct' ? 'direct' : 'relay'; sendDisplayPreferences(); }
  else if (event.data.state === 'disconnected') { resetDirectControl(); frameState = 'reconnecting'; scaleRevision = -1; clearClipboard(); renderClipboard(); }
  else if (event.data.state === 'connecting') { if (frameState !== 'reconnecting') frameState = 'connecting'; }
  else return;
  renderConnection();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });

try { await showWorkspace(await api('/api/me')); } catch (error) { showLogin(accessExpired ? error.message : ''); }
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
