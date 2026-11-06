import { createShortcutMenu } from './shortcut-menu.js';
import { SHORTCUT_BY_KEY } from './shortcuts.js';
import { createForwardUI } from './forward-ui.js';
import { createWorkspacePanels, createHistoryToolsPortal } from './workspace-panels.js';
import { createTerminalState, validTerminalIdentity } from './terminal-state.js';
import { createTerminalTabs } from './terminal-tabs.js';
import { createAccessUI } from './access-ui.js';

const $ = id => document.getElementById(id);
let csrf = '', viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), pollTimer, toastTimer, frameLoaded = false, owned = false, loggedIn = false, pollController = null;
let forwardingUI;
let accessUI;
let permissions = { role: 'admin', full: false, screenLockEnabled: false, requiresUnlock: false, canClaim: true, canForward: true, canReverse: true, canManageDevices: true };
let fastConnectEnabled = false;
let streamProtocolEnabled = false;
let draftStorage;
try { draftStorage = sessionStorage; } catch {}
const terminalState = createTerminalState(draftStorage);
let draftIdentity = { id: '', token: '' }, draftNotice = '';
let inputBusy = false;
let inputComposing = false;
let inputController = null, inputFeedback = false, maintenancePending = false;
let controlsState = { available: false, maintenance: false, inputBusy: false };
let clipboardController = null, clipboardGeneration = 0, clipboardCopyBusy = false, clipboardText = '';
let panelState = 'connecting', desktopReady = null, frameState = 'idle', frameEpoch = 0, frameDimensions = null, accessExpired = false;
let diagnosticsController = null, diagnosticsTimer;
let frameTransport = '';
let frameNetwork = null, directIssue = '';
const directIssues = { unsupported: '当前浏览器环境不支持直连', disabled: '服务端已关闭直连', signaling: '直连协商请求未完成',
  negotiation: '直连未建立，等待后续探测', timeout: '直连协商超时，等待后续探测',
  'signaling-timeout': '直连协商请求超时，等待后续探测',
  'ice-timeout': '直连 UDP 探测超时；请检查浏览器本地网络权限及 UDP 通道',
  'channel-timeout': '直连 UDP 已接通，加密数据通道建立超时',
  connection: '原直连已断开，正在恢复', heartbeat: '直连心跳无回复，已开始回退中转' };
let controlReady = false, controlPending = null, controlSequence = 0;
let transportSwitching = false, switchTimer;
let desktopSettings = null, settingsController = null, settingsTimer, settingsBusy = false;
let viewportTimer, viewportController, viewportWaiter, viewportApplied = '', viewportResizing = false, nativeIdle = false, frameResizeReady = false;
let confirmation = null, uiGeneration = 0;
let terminalCatalog = [], selectedTerminal = '', terminalBusy = false, terminalController = null, terminalLoadAttempted = false;
let selectedTerminalToken = '', terminalSelectionState = 'loading', terminalCatalogVerified = false, adoptWindowDraft = false, frameComposing = false;
let frameTerminalKey = '', terminalGeometry = null, terminalReviewing = false;
let screenLock = null, wakeOperation = null, wakeEligible = false, wakeGeneration = 0, wakeFailed = false, pageLeaving = false;
const shortcutMenu = createShortcutMenu({ button: $('shortcuts-button'), menu: $('shortcuts-menu'), list: $('shortcuts-list'),
  available: key => !terminalOnly || key !== 'Ctrl+Shift+V',
  canSend: () => !confirmation && canInput() && !inputBusy && !inputCollapsed(),
  send: key => sendShortcut(key), changed: () => { sendDisplayPreferences(); scheduleViewport(); } });
const wakeSupported = window.isSecureContext && typeof navigator.wakeLock?.request === 'function';
$('mobile-input').value = terminalState.read(draftIdentity);
$('mobile-input').addEventListener('input', () => { rememberDraft(); renderTerminalSelection(); });
$('mobile-input').addEventListener('compositionstart', () => { inputComposing = true; renderInputControls(); sendDisplayPreferences(); });
$('mobile-input').addEventListener('compositionend', () => { inputComposing = false; renderInputControls(); sendDisplayPreferences(); });
$('mobile-input').addEventListener('blur', () => { inputComposing = false; renderInputControls(); sendDisplayPreferences(); });

// One bounded browser preference entry; it contains no terminal text or credentials.
const displayKey = 'codex-cloud.display.v1';
const displayPreferences = { layout: 2, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, autoResolution: false, keepAwake: false, mode: 'desktop', terminalFontSize: 15, terminalWidthMode: 'viewport', terminalInputCollapsed: true, pointerMode: 'touch', scrollTarget: 'viewport' };
let terminalOnly = false;
const terminalMode = () => displayPreferences.mode === 'terminal';
function inputCollapsed() { return terminalMode() ? displayPreferences.terminalInputCollapsed : displayPreferences.collapsed; }
const followsViewport = () => displayPreferences.autoResolution;
const fixedSize = () => controlsState.viewport?.fixed || { width: 1600, height: 3200 };
let displayScale = 0, displayRevision = 0, scaleRevision = -1;
try {
  const stored = localStorage.getItem(displayKey);
  if (stored && stored.length <= 512) {
    const value = JSON.parse(stored);
    if (value && (['fit', 'width'].includes(value.zoom) || (Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 2)) && typeof value.pan === 'boolean' && typeof value.collapsed === 'boolean' && (value.controlsCollapsed === undefined || typeof value.controlsCollapsed === 'boolean')) {
      Object.assign(displayPreferences, { pan: value.pan, collapsed: value.collapsed });
      if (typeof value.controlsCollapsed === 'boolean') displayPreferences.controlsCollapsed = value.controlsCollapsed;
      if (value.layout === 2) {
        displayPreferences.zoom = value.zoom;
        if (typeof value.autoResolution === 'boolean') displayPreferences.autoResolution = value.autoResolution;
        if (typeof value.keepAwake === 'boolean') displayPreferences.keepAwake = value.keepAwake;
        if (['desktop', 'terminal'].includes(value.mode)) displayPreferences.mode = value.mode;
        if (Number.isInteger(value.terminalFontSize) && value.terminalFontSize >= 10 && value.terminalFontSize <= 28) displayPreferences.terminalFontSize = value.terminalFontSize;
        if (['viewport', 'scale', 'manual'].includes(value.terminalWidthMode)) displayPreferences.terminalWidthMode = value.terminalWidthMode;
        if (typeof value.terminalInputCollapsed === 'boolean') displayPreferences.terminalInputCollapsed = value.terminalInputCollapsed;
        if (['touch', 'trackpad'].includes(value.pointerMode)) displayPreferences.pointerMode = value.pointerMode;
        if (['viewport', 'remote'].includes(value.scrollTarget)) displayPreferences.scrollTarget = value.scrollTarget;
      }
    }
  }
} catch {}
const workspacePanels = createWorkspacePanels({ tools: $('workspace-tools'), input: $('input-dock'),
  toolsButton: $('toggle-controls-button'), inputButton: $('toggle-input-button'), close: closeWorkspacePanel });
const historyToolsPortal = createHistoryToolsPortal({ frame: $('desktop-frame'), container: $('desktop-card'),
  valid: frame => loggedIn && owned && !accessExpired && frameLoaded && terminalMode() && frame === String(frameEpoch),
  opened: () => { shortcutMenu.close(); hideWorkspacePanels(); },
  composing: value => { if (frameComposing !== value) { frameComposing = value; renderInputControls(); } },
});
const terminalTabs = createTerminalTabs({ bar: $('terminal-session-bar'), tabs: $('terminal-tabs'), mobileButton: $('terminal-session-button'),
  dialog: $('terminal-switch-dialog'), list: $('terminal-switch-list'), choose: selectTerminal, manage: openTerminalManager, changed: sendDisplayPreferences });
function rememberDraft() {
  const saved = terminalState.save(draftIdentity, $('mobile-input').value);
  draftNotice = saved ? '' : '草稿空间已满，请先复制当前文字或在终端管理中清理旧终端草稿。';
  return saved;
}
function initializeTerminalSelection() {
  const saved = terminalState.selection;
  draftIdentity = saved || { id: '', token: '' };
  selectedTerminal = saved?.id || (terminalMode() ? 'main' : '');
  selectedTerminalToken = saved?.token || '';
  terminalSelectionState = 'loading'; adoptWindowDraft = terminalMode() && !saved?.id;
  terminalCatalogVerified = false;
  $('mobile-input').value = terminalState.read(draftIdentity);
}
function activateTerminal(identity, { adopt = false } = {}) {
  if (!rememberDraft()) return false;
  if (adopt) terminalState.adoptWindow(identity);
  draftIdentity = { ...identity }; selectedTerminal = identity.id; selectedTerminalToken = identity.token;
  terminalSelectionState = 'ready'; terminalState.choose(identity);
  $('mobile-input').value = terminalState.read(identity);
  if ($('input-status').dataset.outcome !== 'unknown') { inputFeedback = false; $('input-status').hidden = true; }
  return true;
}
function reconcileTerminalSelection(opened) {
  if (opened) {
    const terminal = terminalCatalog.find(item => item.id === opened && item.supported);
    if (terminal) activateTerminal({ id: terminal.id, token: terminal.token });
  } else if (!selectedTerminal && !terminalMode()) {
    terminalSelectionState = 'ready'; terminalState.choose({ id: '', token: '' });
  } else {
    const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
    if (terminal && !selectedTerminalToken && selectedTerminal === 'main') activateTerminal({ id: terminal.id, token: terminal.token }, { adopt: adoptWindowDraft });
    else terminalSelectionState = terminal?.token === selectedTerminalToken ? 'ready' : 'invalid';
  }
  adoptWindowDraft = false;
  if (terminalMode() && terminalSelectionState === 'invalid' && frameLoaded) stopFrame();
}
function selectTerminal(id) {
  if (confirmation) { closeConfirmation(); renderTerminalList(); return false; }
  if (!canManageTerminals() || inputComposing || frameComposing) { renderTerminalList(); return false; }
  const terminal = terminalCatalog.find(item => item.id === id && item.supported);
  if (id && !terminal || !id && terminalMode()) return false;
  const identity = id ? { id: terminal.id, token: terminal.token } : { id: '', token: '' };
  if (!activateTerminal(identity)) { renderTerminalSelection(); return false; }
  shortcutMenu.close(); renderTerminalList(); if (terminalMode()) syncTerminalView();
  return true;
}
function openTerminalManager() {
  shortcutMenu.close(); $('terminals-dialog').showModal(); sendDisplayPreferences(); void loadTerminals();
}
function renderTerminalSelection() {
  const invalid = terminalSelectionState === 'invalid' || terminalSelectionState === 'error';
  const disabled = !canManageTerminals() || inputComposing || frameComposing || !!confirmation;
  terminalTabs.render(terminalCatalog, selectedTerminal, { visible: owned && terminalMode() && (terminalCatalog.length > 1 || invalid), disabled, invalid, loading: terminalSelectionState === 'loading' });
  const message = invalid ? '原终端未通过身份校验，草稿已保留；请刷新列表或手动选择目标。'
    : draftNotice || (terminalState.persistenceFailed ? '浏览器未能保存草稿，刷新前请复制重要文字。' : '');
  $('draft-status').textContent = message; $('draft-status').hidden = !message;
  $('terminal-switch-status').textContent = invalid ? message : terminalSelectionState === 'loading' ? '正在核对终端…' : '';
  $('terminal-switch-refresh').disabled = !loggedIn || terminalBusy;
  $('terminal-switch-manage').disabled = !loggedIn || terminalBusy;
  const stale = terminalCatalogVerified ? terminalState.stale(terminalCatalog, draftIdentity) : 0;
  $('clear-stale-drafts').disabled = !stale || terminalBusy || !!confirmation;
  $('clear-stale-drafts').textContent = stale ? `清理旧终端草稿（${stale}）` : '清理旧终端草稿';
}
function closeWorkspacePanel(name = workspacePanels.active) {
  shortcutMenu.close();
  updateDisplayPreferences(name === 'tools' ? { controlsCollapsed: true } : terminalMode() ? { terminalInputCollapsed: true } : { collapsed: true });
}
function hideWorkspacePanels() {
  if (workspacePanels.active) updateDisplayPreferences({ controlsCollapsed: true, collapsed: true, terminalInputCollapsed: true });
}
function toggleWorkspacePanel(name) {
  historyToolsPortal.dismiss();
  const opening = workspacePanels.active !== name;
  shortcutMenu.close();
  updateDisplayPreferences({ controlsCollapsed: name !== 'tools' || !opening,
    ...(terminalMode() ? { terminalInputCollapsed: name !== 'input' || !opening } : { collapsed: name !== 'input' || !opening }) });
  if (opening) { workspacePanels.focus(); if (name === 'input') $('mobile-input').focus({ preventScroll: true }); }
}
function sendDisplayPreferences() {
  if (!frameLoaded || !owned) return;
  $('desktop-frame').contentWindow.postMessage({ type: 'codex-desktop-options', zoom: displayPreferences.zoom, pan: displayPreferences.pan, blocked: inputPaused() || !!accessUI?.blocking,
    pointerMode: displayPreferences.pointerMode, scrollTarget: displayPreferences.scrollTarget,
    handoff: (transportSwitching || viewportResizing) && !maintenancePending && !controlsState.maintenance && controlsState.available,
    csrf, ...(terminalMode() ? { terminalFontSize: displayPreferences.terminalFontSize, terminalWidthMode: displayPreferences.terminalWidthMode } : {}),
    busy: inputBusy || inputComposing || terminalBusy || $('terminals-dialog').open || $('terminal-switch-dialog').open || !!clipboardController || controlsState.inputBusy || controlsState.clipboardBusy || settingsBusy || !!confirmation || shortcutMenu.open || !!accessUI?.blocking, revision: displayRevision }, location.origin);
}
function zoomBase() { return typeof displayPreferences.zoom === 'number' ? displayPreferences.zoom : scaleRevision === displayRevision ? displayScale : 0; }
function renderDisplayControls() {
  for (const id of ['toggle-controls-button', 'toggle-input-button', 'fullscreen-button']) $(id).hidden = loggedIn && !owned;
  $('desktop-mode').hidden = $('terminal-mode').hidden = terminalOnly || loggedIn && !owned;
  $('desktop-mode').parentElement.hidden = terminalOnly || loggedIn && !owned;
  $('desktop-settings-button').hidden = $('clipboard-button').hidden = terminalOnly;
  $('create-terminal').textContent = terminalOnly ? '新建终端' : '新建辅助终端';
  $('diag-desktop').previousElementSibling.textContent = terminalOnly ? '终端服务' : '远程桌面';
  $('diag-frame').previousElementSibling.textContent = terminalMode() ? '终端界面' : '桌面画面';
  $('diag-resolution').previousElementSibling.textContent = terminalMode() ? '终端尺寸' : '实际分辨率';
  $('desktop-card').classList.toggle('terminal-mode', terminalMode());
  $('desktop-mode').setAttribute('aria-pressed', String(!terminalMode())); $('terminal-mode').setAttribute('aria-pressed', String(terminalMode()));
  $('view-title').textContent = terminalMode() ? '网页终端' : '开发桌面';
  $('fullscreen-button').setAttribute('aria-label', terminalMode() ? '全屏终端' : '全屏桌面');
  $('terminal-view-controls').hidden = !terminalMode();
  $('terminal-font-label').textContent = String(displayPreferences.terminalFontSize);
  const fittedFont = terminalGeometry?.fontSize;
  $('terminal-font-label').title = displayPreferences.terminalWidthMode === 'scale' && fittedFont > displayPreferences.terminalFontSize
    ? `基础字号 ${displayPreferences.terminalFontSize}，适应宽度后为 ${fittedFont}` : `字号 ${displayPreferences.terminalFontSize}`;
  $('terminal-width-mode').value = displayPreferences.terminalWidthMode;
  $('terminal-font-down').disabled = displayPreferences.terminalFontSize <= 10; $('terminal-font-up').disabled = displayPreferences.terminalFontSize >= 28;
  renderWakeStatus();
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
  $('pointer-mode').value = displayPreferences.pointerMode;
  $('scroll-target').value = displayPreferences.scrollTarget;
  $('pointer-options').hidden = terminalMode();
  // Older saved preferences could have both inline sections expanded.
  // Input takes the shared panel slot until the user chooses another tool.
  workspacePanels.render(!inputCollapsed() ? 'input' : !displayPreferences.controlsCollapsed ? 'tools' : '');
  $('tools-title').textContent = terminalMode() ? '终端工具' : '桌面工具';
  $('terminal-button').hidden = terminalMode();
  $('desktop-card').classList.toggle('controls-collapsed', displayPreferences.controlsCollapsed);
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
function wakeAllowed() {
  return wakeSupported && displayPreferences.keepAwake && loggedIn && owned && !accessExpired && !document.hidden && !pageLeaving;
}
function renderWakeStatus() {
  const active = screenLock && !screenLock.released;
  const text = !wakeSupported ? '不支持亮屏' : !displayPreferences.keepAwake ? '保持亮屏' : active ? '亮屏已开启' : wakeOperation === 'request' ? '亮屏申请中' : wakeEligible ? '亮屏已暂停' : '亮屏待恢复';
  $('awake-button').textContent = text;
  $('awake-button').disabled = !wakeSupported;
  $('awake-button').setAttribute('aria-pressed', String(displayPreferences.keepAwake));
  $('awake-button').title = !wakeSupported ? '需要安全连接及支持 Screen Wake Lock 的浏览器' : active ? '点击关闭保持亮屏' : displayPreferences.keepAwake ? '系统可能已暂停亮屏；关闭后重新开启可重试' : '保持当前设备屏幕亮起；后台、锁屏或省电时可能暂停';
  $('diag-awake').textContent = !wakeSupported ? '当前浏览器不支持保持亮屏' : active ? '保持亮屏中' : displayPreferences.keepAwake ? '已暂停，返回前台后尝试恢复' : '未开启保持亮屏';
}
async function releaseScreenLock(lock) {
  try { if (!lock.released) await lock.release(); }
  catch { if (!lock.released) { screenLock = lock; wakeFailed = true; } }
}
function syncScreenLock(retry = false) {
  const eligible = wakeAllowed();
  if (eligible !== wakeEligible) { wakeEligible = eligible; wakeGeneration++; if (eligible) wakeFailed = false; }
  if (retry) wakeFailed = false;
  if (screenLock?.released) screenLock = null;
  if (!wakeOperation && !eligible && screenLock && !wakeFailed) {
    const current = screenLock; screenLock = null; wakeOperation = 'release';
    void releaseScreenLock(current).finally(() => { wakeOperation = null; syncScreenLock(); });
  } else if (!wakeOperation && eligible && !screenLock && !wakeFailed) {
    const generation = wakeGeneration; wakeOperation = 'request';
    void (async () => {
      try {
        const current = await navigator.wakeLock.request('screen');
        if (generation !== wakeGeneration || !wakeAllowed()) { await releaseScreenLock(current); return; }
        if (current.released) { wakeFailed = true; return; }
        screenLock = current;
        current.addEventListener('release', () => {
          if (screenLock !== current) return;
          screenLock = null; wakeFailed = true; renderWakeStatus();
        }, { once: true });
      } catch { if (generation === wakeGeneration && wakeAllowed()) wakeFailed = true; }
    })().finally(() => { wakeOperation = null; syncScreenLock(); });
  }
  renderWakeStatus();
}
$('awake-button').addEventListener('click', () => {
  if (!wakeSupported) return;
  updateDisplayPreferences({ keepAwake: !displayPreferences.keepAwake });
  syncScreenLock(true);
});
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
$('pointer-mode').addEventListener('change', () => updateDisplayPreferences({ pointerMode: $('pointer-mode').value, pan: false }));
$('scroll-target').addEventListener('change', () => updateDisplayPreferences({ scrollTarget: $('scroll-target').value }));
$('toggle-input-button').addEventListener('click', () => toggleWorkspacePanel('input'));
$('toggle-controls-button').addEventListener('click', () => toggleWorkspacePanel('tools'));
$('close-input-button').addEventListener('click', () => closeWorkspacePanel('input'));
$('close-controls-button').addEventListener('click', () => closeWorkspacePanel('tools'));
$('tools-fullscreen-button').addEventListener('click', () => { closeWorkspacePanel('tools'); $('fullscreen-button').click(); });
for (const id of ['input-keyboard-button', 'assistant-send-button']) $(id).addEventListener('click', () => $('mobile-input').focus({ preventScroll: true }));
renderDisplayControls();

function inputPaused() { return viewportResizing || controlsState.viewportBusy || transportSwitching || maintenancePending || controlsState.maintenance || !controlsState.available; }
function scheduleViewport(delay = 500) {
  clearTimeout(viewportTimer);
  if (!loggedIn || !owned || !frameLoaded || !frameResizeReady || frameState !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
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
  if (terminalMode() || !loggedIn || !owned || !frameLoaded || !frameResizeReady || frameState !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
  if (!nativeIdle || inputPaused() || inputBusy || terminalBusy || $('terminals-dialog').open || clipboardController || controlsState.inputBusy || controlsState.clipboardBusy || settingsBusy || confirmation || shortcutMenu.open || accessUI?.blocking || document.hidden) { scheduleViewport(1000); return; }
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
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && desktopReady === true && frameState === 'connected' && !inputPaused() && !terminalBusy && terminalSelectionState === 'ready' && (!terminalMode() || !terminalReviewing) && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardController && !accessUI?.blocking;
}
function canManageTerminals() {
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && controlsState.available && !inputPaused() && !inputBusy && !terminalBusy && !settingsBusy && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardController && !accessUI?.blocking;
}
function renderInputControls() {
  const disabled = inputBusy || inputComposing || frameComposing || !canInput();
  for (const control of [$('paste-button'), $('terminal-button'), $('shortcuts-button'), ...document.querySelectorAll('[data-key], [data-shortcut]')]) control.disabled = disabled;
  if (disabled) shortcutMenu.close();
  for (const control of [$('terminals-button'), $('create-terminal'), ...$('terminal-list').querySelectorAll('button, input')]) control.disabled = !canManageTerminals() || control.closest('.terminal-row')?.dataset.supported === 'false';
  $('input-terminal').disabled = !canManageTerminals() || inputComposing || frameComposing || !!confirmation;
  $('create-terminal').disabled = !canManageTerminals() || terminalCatalog.length >= 4;
  $('refresh-terminals').disabled = !loggedIn || terminalBusy;
  $('paste-target').disabled = !!selectedTerminal;
  $('desktop-mode').disabled = $('terminal-mode').disabled = modeChangeBusy() || !!confirmation;
  $('terminal-view-select').disabled = !canManageTerminals() || inputComposing || frameComposing || !!confirmation;
  $('terminal-view-manage').disabled = !canManageTerminals();
  renderTerminalSelection();
  sendDisplayPreferences();
}
function renderConnection() {
  forwardingUI?.update();
  accessUI?.update();
  if (confirmation && !confirmationValid(confirmation)) closeConfirmation();
  syncScreenLock();
  let label;
  if (accessExpired) label = '访问验证已过期';
  else if (!navigator.onLine || panelState === 'offline') label = '等待网络';
  else if (!owned) label = permissions.role === 'temporary' ? '临时访问' : permissions.requiresUnlock ? '屏幕已锁定' : '等待接管';
  else if (desktopReady === false) label = terminalOnly ? '终端后台未就绪' : '桌面未就绪';
  else if (transportSwitching) label = '正在优化连接';
  else if (maintenancePending || controlsState.maintenance) label = '桌面操作进行中';
  else if (!controlsState.available) label = '输入服务未就绪';
  else if (terminalMode() && ['invalid', 'error'].includes(terminalSelectionState)) label = '终端目标待确认';
  else if (frameState === 'connected') label = terminalMode() ? '终端在线' : '桌面在线';
  else label = frameState === 'reconnecting' ? '画面重连中' : '画面连接中';
  $('connection-status').classList.toggle('offline', !['桌面在线', '终端在线'].includes(label));
  $('connection-status').lastChild.textContent = label;
  $('diag-panel').textContent = accessExpired ? '访问验证已过期' : panelState === 'online' ? '可访问' : panelState === 'offline' ? '连接中断' : '等待检测';
  $('diag-desktop').textContent = desktopReady === null ? '等待检测' : desktopReady ? '已就绪' : '未就绪';
  $('diag-frame').textContent = !owned ? '等待接管' : frameState === 'connected' ? '已连接' : frameState === 'reconnecting' ? '重连中' : '等待连接';
  $('diag-transport').textContent = frameState !== 'connected' ? '等待连接' : frameTransport === 'terminal' ? 'HTTPS / WebSocket 文字终端' : frameTransport === 'direct' ? terminalMode() ? 'WebRTC 加密直连 · 文字终端' : 'WebRTC 加密直连' : 'HTTPS / WebSocket 中转';
  $('diag-input-transport').textContent = frameState !== 'connected' ? '等待连接' : frameTransport === 'terminal' ? '网页终端加密通道' : controlReady ? 'WebRTC 加密直连' : 'HTTPS';
  const route = frameState === 'connected' && frameTransport === 'direct' ? frameNetwork : null;
  const endpoint = value => `${value.address === null ? '浏览器隐藏地址' : value.address.includes(':') ? `[${value.address}]` : value.address}${value.port ? `:${value.port}` : ''}`;
  $('diag-network').textContent = route ? `${route.family} / ${route.protocol}` : frameTransport === 'direct' && frameState === 'connected' ? '浏览器尚未提供路径详情' : '当前未使用直连';
  $('diag-peer').textContent = route ? `${endpoint(route.local)} ↔ ${endpoint(route.remote)}` : '—';
  $('diag-latency').textContent = route?.rttMs != null ? `${route.rttMs} ms` : '—';
  $('diag-direct-status').textContent = frameTransport === 'direct' && frameState === 'connected' ? '已建立加密直连' : directIssues[directIssue] || '尚未检测';
  $('diag-resolution').textContent = terminalMode() ? terminalGeometry ? `${terminalGeometry.cols} 列 × ${terminalGeometry.rows} 行` : '等待终端尺寸' : frameDimensions ? `${frameDimensions.width} × ${frameDimensions.height}${frameState === 'connected' ? '' : '（上次连接）'}` : '等待画面连接';
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
  } else if (!owned && permissions.role === 'temporary') overlay('临时访问', '此账号仅可查看连接状态、配置服务器访问本地设备的映射，以及上传和下载共享中转文件。');
  else if (!owned && permissions.requiresUnlock) overlay('屏幕已锁定', '输入屏幕锁密码后才能在这里使用。连接状态、本地设备映射和文件中转继续可用，原任务不会停止。', true);
  else if (!owned) overlay('在这里继续工作', terminalOnly ? '终端已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启任务。' : '桌面已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启 Codex。', true);
  else if (terminalMode() && ['invalid', 'error'].includes(terminalSelectionState)) {
    overlay('请选择终端', '原终端未通过身份校验，草稿仍保留。请刷新列表或手动选择目标。');
    $('choose-terminal-button').hidden = false;
  }
  else if (desktopReady === false && frameState !== 'connected') overlay(terminalOnly ? '终端后台未就绪' : '桌面未就绪', terminalOnly ? '正在等待终端后台。网页不会自动重启后台或重新执行任务。' : '正在等待桌面服务。网页不会自动重启桌面或重新执行任务。');
  else if ((viewportResizing || controlsState.viewportBusy || transportSwitching) && frameState === 'connected') $('desktop-overlay').hidden = true;
  else if (inputPaused()) overlay(label, '输入暂时暂停。当前操作完成后恢复，不会自动重发输入。');
  else if (frameState === 'connected') $('desktop-overlay').hidden = true;
  else overlay(label, terminalMode() ? '正在连接终端，原任务继续运行。' : '正在连接画面，桌面任务继续运行。');
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
    const { tunnel, services } = await api('/api/diagnostics', { signal: controller.signal });
    if (diagnosticsController !== controller || !$('connection-dialog').open) return;
    $('diag-tunnel').textContent = tunnel?.available ? tunnel.connections > 0 ? `已连接 · ${tunnel.connections} 条连接` : '未建立连接' : '诊断不可用';
    $('diag-families').textContent = tunnel?.available ? `${tunnel.ipv6} / ${tunnel.ipv4}` : '—';
    $('diag-recovery').textContent = !services?.available ? '状态未知' : services.panel.limited ? '自动恢复已停止，需要检查服务' : services.panel.state !== 'active' ? '服务未就绪' : services.panel.restarts ? `已自动恢复 · ${services.panel.restarts} 次` : '正常运行';
    $('diag-services').previousElementSibling.textContent = terminalOnly ? '终端后台' : '输入与桌面执行';
    $('diag-services').textContent = !services?.available ? '状态未知' : terminalOnly ? `管理：${services.manager.state === 'active' ? '正常' : '未就绪'} / 终端：${services.terminal?.state === 'active' ? '正常' : '未就绪'}` : `输入：${services.manager.state === 'active' ? '正常' : '未就绪'} / 桌面执行：${services.actions.state === 'active' ? '正常' : '未就绪'}`;
    $('diag-note').textContent = tunnel?.available ? `更新于 ${new Date(tunnel.checkedAt).toLocaleTimeString()}；仅统计当前活动边缘连接。` : 'Tunnel 未启动、未配置或诊断接口暂不可用；这不表示桌面任务已停止。';
  } catch (error) {
    if (diagnosticsController === controller && loggedIn) {
      $('diag-tunnel').textContent = '状态未知';
      $('diag-families').textContent = '—';
      $('diag-recovery').textContent = $('diag-services').textContent = '状态未知';
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
  hideWorkspacePanels();
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
  if (!response.ok) {
    if (!signal?.aborted && data.access) updateAccess(data.access);
    const error = new Error(data.error || `请求失败（${response.status}）`); error.outcome = data.outcome; error.status = response.status; error.code = data.code; throw error;
  }
  return data;
}
function overlay(title, description, takeover = false) {
  $('overlay-title').textContent = title;
  $('overlay-description').textContent = description;
  $('takeover-button').hidden = !takeover;
  $('access-refresh-button').hidden = true;
  $('choose-terminal-button').hidden = true;
  $('desktop-overlay').hidden = false;
}
function stopFrame({ keepLogout = false } = {}) {
  historyToolsPortal.reset();
  terminalController?.abort();
  shortcutMenu.close();
  if (!keepLogout || confirmation?.kind !== 'logout') closeConfirmation();
  clearTimeout(viewportTimer); viewportController?.abort(); viewportController = null; viewportResizing = false; viewportApplied = ''; nativeIdle = false; frameResizeReady = false;
  clearTimeout(switchTimer); transportSwitching = false;
  resetDirectControl();
  frameLoaded = false;
  frameState = 'idle';
  frameTransport = '';
  frameTerminalKey = ''; terminalGeometry = null; terminalReviewing = false;
  frameComposing = false;
  frameNetwork = null; directIssue = '';
  frameEpoch++;
  displayScale = 0;
  scaleRevision = -1;
  renderDisplayControls();
  $('desktop-frame').hidden = true;
  $('desktop-frame').src = 'about:blank';
}
function restrictWorkspace() {
  hideWorkspacePanels(); shortcutMenu.close();
  inputController?.abort(); terminalController?.abort(); settingsController?.abort(); clipboardController?.abort();
  for (const id of ['desktop-settings-dialog', 'terminals-dialog', 'terminal-switch-dialog', 'clipboard-dialog']) if ($(id).open) $(id).close();
  if (confirmation && confirmation.kind !== 'logout') closeConfirmation();
  if (frameLoaded) stopFrame({ keepLogout: true });
}
function updateAccess(value) {
  if (!value) return;
  permissions = { ...permissions, ...value };
  if (!permissions.full && owned) { rememberDraft(); owned = false; restrictWorkspace(); }
  renderConnection();
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
  if (terminalMode() && ['paste', 'key'].includes(action) && !controlReady) return Promise.reject(Object.assign(new Error('网页终端未就绪，本次输入未发送'), { outcome: 'rejected' }));
  if (!controlReady || !action || (terminalMode() && action === 'clipboard')) return api(path, { method: 'POST', body, signal });
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
  accessUI?.close();
  if (loggedIn) rememberDraft();
  forwardingUI?.reset();
  uiGeneration++; closeConfirmation();
  clearClipboard();
  inputController?.abort(); inputController = null; inputBusy = false; inputFeedback = false;
  controlsState = { available: false, maintenance: false, inputBusy: false };
  maintenancePending = false;
  $('input-status').hidden = true;
  loggedIn = false; owned = false; csrf = '';
  terminalController?.abort(); terminalController = null; terminalBusy = false; terminalLoadAttempted = false; terminalCatalog = []; selectedTerminal = ''; selectedTerminalToken = ''; terminalSelectionState = 'loading'; renderTerminalList();
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
  if ($('terminals-dialog').open) $('terminals-dialog').close();
  if ($('terminal-switch-dialog').open) $('terminal-switch-dialog').close();
  renderConnection();
}
function frameUrl() {
  const query = new URLSearchParams({ viewer, frame: String(frameEpoch) });
  if (fastConnectEnabled) query.set('fast', '1');
  if (streamProtocolEnabled) query.set('stream', '1');
  if (terminalMode()) {
    const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
    query.set('terminalId', terminal.id); query.set('terminalToken', terminal.token);
    return `/terminal/index.html?${query}`;
  }
  return `/desktop/index.html?${query}`;
}
function openFrame() {
  if (frameLoaded || !owned) return;
  if (terminalMode()) {
    if (terminalSelectionState !== 'ready') return;
    const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
    if (!terminal || terminal.token !== selectedTerminalToken) return;
    frameTerminalKey = `${terminal.id}:${terminal.token}`;
  }
  frameLoaded = true;
  frameState = 'connecting';
  $('desktop-frame').src = frameUrl();
  $('desktop-frame').title = terminalMode() ? 'Codex 网页终端' : 'Ubuntu 开发桌面';
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
    let mine = state.mine;
    if (state.access) permissions = { ...permissions, ...state.access };
    if (!mine && owned && state.claimable === true && !permissions.requiresUnlock && permissions.canClaim) {
      // A restarted gateway has no owner. Recover only if it is still free at
      // admission; never take over another page or replay uncertain input.
      owned = false; inputController?.abort(); stopFrame(); renderConnection();
      const recovered = await api('/api/desktop/claim', { method: 'POST', body: { viewer, ifFree: true }, signal: controller.signal });
      if (!loggedIn || pollController !== controller) return;
      if (recovered.access) permissions = { ...permissions, ...recovered.access };
      mine = true;
    }
    owned = mine;
    panelState = 'online';
    desktopReady = state.desktop.ready === true;
    controlsState = state.controls || { available: false, maintenance: false, inputBusy: false };
    scheduleViewport();
    if (!inputBusy && !inputFeedback && controlsState.input?.status === 'unknown') inputMessage('unknown', '上一项输入结果未知，请先查看桌面确认，避免重复执行。');
    $('version-label').textContent = state.desktop.version;
    if (state.desktop.transferDir) $('transfer-path').textContent = state.desktop.transferDir;
    if (!mine) {
      restrictWorkspace();
    } else if (state.desktop.ready) openFrame();
    if (mine && state.desktop.ready && !terminalLoadAttempted) { terminalLoadAttempted = true; void loadTerminals(); }
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
async function claim(lockPassword, signal) {
  if (!permissions.canClaim) return;
  if (permissions.requiresUnlock && !lockPassword) { accessUI?.unlock(); return; }
  const restore = !owned;
  const result = await api('/api/desktop/claim', { method: 'POST', body: { viewer, ...(lockPassword ? { lockPassword } : {}) }, signal });
  if (result.access) permissions = { ...permissions, ...result.access };
  if (!loggedIn) return;
  // A successful claim invalidates every state snapshot fetched before it.
  stopPolling();
  owned = true;
  if (restore) initializeTerminalSelection();
  terminalSelectionState = 'loading'; terminalCatalogVerified = false; terminalLoadAttempted = false;
  stopFrame();
  renderConnection();
  // Let the old iframe unload and close its socket before opening a new viewer.
  await new Promise(resolve => setTimeout(resolve, 300));
  await poll();
}
async function showWorkspace(user) {
  uiGeneration++; closeConfirmation();
  loggedIn = true; csrf = user.csrf; fastConnectEnabled = user.fastConnect === true; streamProtocolEnabled = user.streamProtocol === 1;
  if (user.access) permissions = { ...permissions, ...user.access };
  terminalOnly = user.mode === 'terminal';
  if (terminalOnly) displayPreferences.mode = 'terminal';
  renderDisplayControls();
  accessExpired = false; panelState = 'online'; desktopReady = null;
  if (permissions.canClaim && !permissions.requiresUnlock) initializeTerminalSelection();
  else { selectedTerminal = ''; selectedTerminalToken = ''; terminalCatalog = []; $('mobile-input').value = ''; }
  $('user-label').textContent = user.username + (permissions.role === 'temporary' ? ' · 临时访问' : '');
  $('password').value = '';
  $('login-view').hidden = true;
  $('workspace-view').hidden = false;
  try {
    if (permissions.role === 'temporary' || permissions.requiresUnlock) { owned = false; restrictWorkspace(); await poll(); if (permissions.requiresUnlock) accessUI?.unlock(); }
    else await claim();
  } catch (error) {
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
function confirmationValid(pending) {
  if (!loggedIn || accessExpired || pending.generation !== uiGeneration) return false;
  if (pending.kind === 'logout') return true;
  if (pending.kind === 'drafts-clear') return terminalCatalogVerified && !inputBusy && !inputComposing && terminalState.stale(terminalCatalog, draftIdentity) > 0;
  if (pending.epoch !== frameEpoch || pending.frameState !== frameState || pending.owned !== owned) return false;
  if (pending.kind === 'mode') return !document.hidden && pending.body?.from === displayPreferences.mode && ['desktop', 'terminal'].includes(pending.body.mode) && pending.body.mode !== displayPreferences.mode && !modeChangeBusy();
  if (pending.destination && JSON.stringify(pending.destination) !== JSON.stringify(inputDestination(false))) return false;
  if (pending.kind === 'terminal-open' && !terminalCatalog.some(item => item.id === pending.body?.terminalId && item.token === pending.body.terminalToken && item.supported)) return false;
  if (['terminal-open', 'terminal-create'].includes(pending.kind)) return canManageTerminals();
  return pending.kind === 'reconnect' ? panelState === 'online' && navigator.onLine && !maintenancePending && !controlsState.maintenance : !inputBusy && canInput();
}
function closeConfirmation() {
  confirmation = null;
  if ($('action-confirmation').open) $('action-confirmation').close();
  sendDisplayPreferences(); scheduleViewport();
}
function requestConfirmation(kind, key, body) {
  if (confirmation || $('action-confirmation').open) return;
  const shortcut = kind === 'shortcut' ? SHORTCUT_BY_KEY.get(key) : null;
  if (kind === 'shortcut' && !shortcut?.confirm) return;
  shortcutMenu.close();
  const pending = { kind, key: shortcut?.key, generation: uiGeneration, epoch: frameEpoch, frameState, owned,
    destination: ['interrupt', 'shortcut'].includes(kind) ? inputDestination(false) : null, body: body ? { ...body } : null };
  if (!confirmationValid(pending)) return;
  const copy = {
    logout: ['退出当前登录？', '退出后需要重新登录。远程桌面和正在运行的任务会继续保留。', '确认退出'],
    terminal: ['打开远程终端？', '将打开或切换到已有终端，改变当前桌面的窗口焦点。原有任务继续运行。', '确认打开终端'],
    reconnect: [terminalMode() ? '重新连接终端？' : '重新连接桌面画面？', terminalMode() ? '将重新建立当前终端连接，必要时接管到这里。原任务和草稿保留，已发送的输入不会重发。' : '将重新建立当前观看连接；如果桌面在其他页面打开，会接管到这里。远程桌面和任务继续运行。', '确认重新连接'],
    interrupt: ['中断当前任务？', '将发送 Ctrl+C，可能终止当前正在执行的命令。请确认你确实需要中断。', '发送 Ctrl+C'],
    shortcut: shortcut ? [`发送 ${shortcut.key}？`, shortcut.description, `发送 ${shortcut.key}`] : null,
    'terminal-create': [terminalOnly ? '新建终端？' : '新建辅助终端？', `将创建并打开“${body?.name}”，原有任务继续运行。`, '确认新建'],
    'terminal-open': ['切换远程终端？', '将打开或切换到所选终端，并将输入助手的目标设为该终端。原有任务继续运行。', '确认切换'],
    'drafts-clear': ['清理已结束终端的旧草稿？', '仅清理身份已失效且当前未在编辑的终端草稿。当前草稿和仍可用终端的草稿会保留。', '确认清理草稿'],
    mode: [`切换到${body?.mode === 'terminal' ? '网页终端' : '桌面'}？`, '切换后会重新建立连接。当前任务继续运行，输入草稿会保留，已发送的输入不会重发。', '确认切换'],
  }[kind];
  if (!copy) return;
  confirmation = pending;
  $('confirmation-title').textContent = copy[0]; $('confirmation-description').textContent = copy[1]; $('accept-confirmation').textContent = copy[2];
  $('action-confirmation').dataset.kind = kind;
  $('action-confirmation').showModal(); $('cancel-confirmation').focus({ preventScroll: true });
  sendDisplayPreferences();
}
$('cancel-confirmation').addEventListener('click', closeConfirmation);
$('action-confirmation').addEventListener('pointerdown', event => {
  if (event.target === $('action-confirmation')) { event.preventDefault(); $('cancel-confirmation').focus({ preventScroll: true }); }
});
$('action-confirmation').addEventListener('click', event => {
  if (event.target === $('action-confirmation')) $('cancel-confirmation').focus({ preventScroll: true });
});
$('action-confirmation').addEventListener('keydown', event => {
  if (event.key === 'Enter' && document.activeElement !== $('accept-confirmation')) { event.preventDefault(); closeConfirmation(); }
});
$('action-confirmation').addEventListener('cancel', event => { event.preventDefault(); closeConfirmation(); });
$('action-confirmation').addEventListener('close', () => { if (!$('action-confirmation').open) { confirmation = null; sendDisplayPreferences(); scheduleViewport(); } });
$('accept-confirmation').addEventListener('click', () => {
  const pending = confirmation;
  if (!pending || !$('action-confirmation').open) return;
  const valid = confirmationValid(pending);
  closeConfirmation();
  if (!valid) return;
  if (pending.kind === 'logout') return void action($('logout-button'), async () => {
    await api('/api/logout', { method: 'POST', body: {}, signal: AbortSignal.timeout(8000) });
    if (pending.generation === uiGeneration) showLogin();
  });
  if (pending.kind === 'reconnect') return void action($('reconnect-button'), claim);
  if (pending.kind === 'drafts-clear') { terminalState.clearStale(terminalCatalog, draftIdentity); draftNotice = ''; renderTerminalSelection(); return; }
  if (pending.kind === 'terminal') return void inputAction('/api/terminal', {}, '打开终端', '已打开终端，连接原有 tmux 会话');
  if (pending.kind === 'mode') return changeMode(pending.body.mode);
  if (['terminal-create', 'terminal-open'].includes(pending.kind)) return void manageTerminals(pending.body);
  if (pending.kind === 'interrupt') void inputAction('/api/key', { key: 'Ctrl+C' }, '发送中断', 'Ctrl C 已发送', pending.destination);
  if (pending.kind === 'shortcut' && SHORTCUT_BY_KEY.get(pending.key)?.confirm) void inputAction('/api/key', { key: pending.key }, '发送按键', `${pending.key} 已发送`, pending.destination);
});
function sendShortcut(key) {
  if (terminalOnly && key === 'Ctrl+Shift+V') return;
  const shortcut = SHORTCUT_BY_KEY.get(key);
  if (!shortcut || inputBusy || !canInput()) return;
  if (key === 'Ctrl+C') return requestConfirmation('interrupt');
  if (shortcut.confirm) return requestConfirmation('shortcut', key);
  void inputAction('/api/key', { key }, '发送按键', `${key} 已发送`);
}
function inputMessage(outcome, message) {
  inputFeedback = true;
  $('input-status').hidden = false;
  $('input-status').dataset.outcome = outcome;
  $('input-status').textContent = message;
}
async function inputAction(path, body, label, success, destination) {
  if (inputBusy || inputComposing || frameComposing || !canInput()) return;
  if (['/api/key', '/api/paste'].includes(path)) {
    try { body = { ...body, ...(destination || inputDestination()) }; }
    catch (error) { return inputMessage('rejected', error.message); }
  }
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
function inputDestination(strict = true) {
  if (!selectedTerminal) return {};
  const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
  if ((!terminal || terminal.token !== selectedTerminalToken || terminalSelectionState !== 'ready') && strict) throw new Error('所选终端不可用，请刷新列表后重新选择；本次输入未发送');
  return { terminalId: selectedTerminal, terminalToken: selectedTerminalToken };
}
function renderTerminalList() {
  const select = $('input-terminal');
  select.replaceChildren(new Option('当前窗口（跟随桌面焦点）', ''));
  select.options[0].disabled = terminalMode();
  const viewSelect = $('terminal-view-select'); viewSelect.replaceChildren();
  for (const terminal of terminalCatalog) {
    const option = new Option(`${terminal.name}${terminal.supported ? '' : '（布局不支持）'}`, terminal.id); option.disabled = !terminal.supported; select.add(option);
    const viewOption = new Option(terminal.name, terminal.id); viewOption.disabled = !terminal.supported; viewSelect.add(viewOption);
  }
  const invalid = ['invalid', 'error'].includes(terminalSelectionState);
  if (selectedTerminal && invalid) {
    select.add(new Option('原目标已失效，请重新选择', 'stale'));
    viewSelect.add(new Option('原目标已失效，请重新选择', 'stale'));
  }
  select.value = selectedTerminal && invalid ? 'stale' : selectedTerminal;
  viewSelect.value = selectedTerminal && invalid ? 'stale' : selectedTerminal;
  $('terminal-target-note').textContent = terminalMode() ? '输入直接发送到当前网页终端；粘贴与 Enter 提交分开。' : selectedTerminal ? '按键和粘贴发送前会切换到所选终端；关闭的窗口需先重新打开。' : '发送到桌面当前获得焦点的位置。';
  if (selectedTerminal) $('paste-target').value = 'terminal';
  const list = $('terminal-list'); list.replaceChildren();
  for (const terminal of terminalCatalog) {
    const row = document.createElement('div'); row.className = 'terminal-row'; row.dataset.terminal = terminal.id; row.dataset.supported = String(terminal.supported);
    const title = document.createElement('strong'), detail = document.createElement('p'), input = document.createElement('input'), rename = document.createElement('button'), open = document.createElement('button');
    title.textContent = terminal.name; detail.className = 'muted'; detail.textContent = terminal.supported ? `${terminal.primary ? '主终端' : '辅助终端'} · ${terminal.command || '运行中'}` : '包含多个窗格或布局无法识别';
    input.value = terminal.name; input.maxLength = 24; input.setAttribute('aria-label', `${terminal.id} 终端名称`);
    rename.type = open.type = 'button'; rename.textContent = '保存名称'; open.textContent = '打开 / 切换';
    rename.className = 'secondary'; open.className = 'primary';
    const target = { terminalId: terminal.id, terminalToken: terminal.token };
    rename.addEventListener('click', () => { if (terminal.supported) void manageTerminals({ action: 'rename', ...target, name: input.value }); });
    open.addEventListener('click', () => { if (terminal.supported) requestConfirmation('terminal-open', null, { action: 'open', ...target }); });
    row.append(title, detail, input, rename, open); list.append(row);
  }
  renderInputControls();
}
async function terminalRequest(body) {
  if (!loggedIn || terminalBusy || (body && !canManageTerminals())) return;
  const controller = new AbortController(), generation = uiGeneration;
  if (body && terminalMode()) body = { ...body, view: 'terminal' };
  terminalController = controller; terminalBusy = true; shortcutMenu.close();
  const timeout = setTimeout(() => controller.abort(), 6500);
  $('terminals-status').textContent = body ? '正在处理终端操作…' : '正在读取终端列表…'; renderInputControls(); sendDisplayPreferences();
  try {
    const result = await api('/api/terminals', { method: body ? 'POST' : 'GET', body, signal: controller.signal });
    if (terminalController !== controller || generation !== uiGeneration || !loggedIn || (body && !owned)) return;
    if (!Array.isArray(result.terminals) || result.terminals.length > 4 || result.terminals.some(item =>
      !['main', 'aux1', 'aux2', 'aux3'].includes(item?.id) || typeof item.supported !== 'boolean' ||
      (item.supported ? !validTerminalIdentity(item) : item.token !== null) || typeof item.name !== 'string' || item.name.length > 96
    ) || new Set(result.terminals.map(item => item.id)).size !== result.terminals.length) throw new Error('终端列表格式无效，请手动刷新');
    terminalCatalog = result.terminals;
    terminalCatalogVerified = true;
    reconcileTerminalSelection(result.opened);
    if (body?.action === 'create') $('new-terminal-name').value = '';
    $('terminals-status').textContent = body ? '终端操作已完成。' : `共 ${terminalCatalog.length} / 4 个终端。`;
    renderTerminalList();
  } catch (error) {
    if (terminalController === controller && generation === uiGeneration) {
      $('terminals-status').textContent = body && error.outcome !== 'rejected' ? '操作结果未知，请手动刷新列表确认；不会自动重试。' : error.message;
      if (!body && terminalSelectionState === 'loading') terminalSelectionState = 'error';
    }
  } finally {
    clearTimeout(timeout);
    if (terminalController === controller) { terminalController = null; terminalBusy = false; renderInputControls(); sendDisplayPreferences(); scheduleViewport(); if (terminalMode()) syncTerminalView(); renderConnection(); }
  }
}
async function loadTerminals() { return terminalRequest(); }
async function manageTerminals(body) { return terminalRequest(body); }
$('terminals-button').addEventListener('click', openTerminalManager);
$('terminal-view-manage').addEventListener('click', openTerminalManager);
$('close-terminals').addEventListener('click', () => $('terminals-dialog').close());
$('terminals-dialog').addEventListener('close', () => { sendDisplayPreferences(); scheduleViewport(); });
$('refresh-terminals').addEventListener('click', () => void loadTerminals());
$('terminal-switch-refresh').addEventListener('click', () => void loadTerminals());
$('terminal-switch-dialog').addEventListener('close', () => { sendDisplayPreferences(); scheduleViewport(); });
$('terminal-switch-dialog').addEventListener('toggle', () => sendDisplayPreferences());
$('choose-terminal-button').addEventListener('click', () => { $('terminal-switch-dialog').showModal(); sendDisplayPreferences(); });
$('clear-stale-drafts').addEventListener('click', () => requestConfirmation('drafts-clear'));
$('create-terminal-form').addEventListener('submit', event => { event.preventDefault(); if (canManageTerminals()) requestConfirmation('terminal-create', null, { action: 'create', name: $('new-terminal-name').value }); });
$('input-terminal').addEventListener('change', () => selectTerminal($('input-terminal').value));
function syncTerminalView() {
  if (!terminalMode() || !loggedIn || !owned || terminalSelectionState !== 'ready') return;
  const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
  if (!terminal || terminal.token !== selectedTerminalToken) return;
  if (frameLoaded && frameTerminalKey === `${terminal.id}:${terminal.token}`) return;
  stopFrame(); openFrame(); renderConnection();
}
function modeChangeBusy() {
  return !owned || inputBusy || inputComposing || frameComposing || terminalBusy || settingsBusy || maintenancePending || controlsState.maintenance || transportSwitching || viewportResizing || controlsState.viewportBusy || !!clipboardController || !!controlPending || controlsState.inputBusy || controlsState.clipboardBusy || !!accessUI?.blocking;
}
function changeMode(mode) {
  if (terminalOnly && mode !== 'terminal') return;
  if (!['desktop', 'terminal'].includes(mode) || mode === displayPreferences.mode || modeChangeBusy() || confirmation) return;
  shortcutMenu.close(); closeConfirmation(); stopFrame();
  if (mode === 'terminal' && !selectedTerminal) {
    const main = terminalCatalog.find(item => item.id === 'main' && item.supported);
    if (main) { if (!activateTerminal({ id: main.id, token: main.token }, { adopt: true })) return; }
    else { selectedTerminal = 'main'; selectedTerminalToken = ''; terminalSelectionState = 'loading'; adoptWindowDraft = true; }
  }
  updateDisplayPreferences({ mode }); renderTerminalList(); openFrame();
  if (mode === 'terminal' && !frameLoaded) void loadTerminals();
  renderConnection();
}
for (const mode of ['desktop', 'terminal']) $(`${mode}-mode`).addEventListener('click', () => {
  if (mode !== displayPreferences.mode) requestConfirmation('mode', null, { from: displayPreferences.mode, mode });
});
$('terminal-view-select').addEventListener('change', () => selectTerminal($('terminal-view-select').value));
$('terminal-font-down').addEventListener('click', () => updateDisplayPreferences({ terminalFontSize: Math.max(10, displayPreferences.terminalFontSize - 1) }));
$('terminal-font-up').addEventListener('click', () => updateDisplayPreferences({ terminalFontSize: Math.min(28, displayPreferences.terminalFontSize + 1) }));
$('terminal-width-mode').addEventListener('change', () => updateDisplayPreferences({ terminalWidthMode: $('terminal-width-mode').value }));
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('login-button'), async () => {
    $('login-error').textContent = '';
    try { await showWorkspace(await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } })); }
    catch (error) { $('login-error').textContent = error.message; }
  });
});
$('logout-button').addEventListener('click', () => requestConfirmation('logout'));
$('takeover-button').addEventListener('click', () => void action($('takeover-button'), claim));
$('reconnect-button').addEventListener('click', () => requestConfirmation('reconnect'));
$('terminal-button').addEventListener('click', () => requestConfirmation('terminal'));
$('paste-button').addEventListener('click', () => {
  const text = $('mobile-input').value;
  if (!text) return inputMessage('rejected', '先输入要粘贴的文字');
  if (text.includes('\0') || new TextEncoder().encode(text).length > 32768) return inputMessage('rejected', '请输入不超过 32 KiB 的文字');
  void inputAction('/api/paste', { text, target: $('paste-target').value }, '粘贴', '已粘贴。确认内容后，按 Enter 提交');
});
for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => {
  if (button.dataset.key === 'Ctrl+C') return requestConfirmation('interrupt');
  void inputAction('/api/key', { key: button.dataset.key }, '发送按键', `${button.textContent.trim()} 已发送`);
});
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
$('clipboard-send-button').addEventListener('click', () => { $('clipboard-dialog').close(); if (workspacePanels.active !== 'input') toggleWorkspacePanel('input'); $('mobile-input').focus({ preventScroll: true }); });
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
  const writable = loggedIn && owned && !accessExpired && !transportSwitching && panelState === 'online' && controlsState.available && !controlsState.maintenance && !controlsState.inputBusy && !controlsState.clipboardBusy && !controlsState.viewportBusy && !viewportResizing && !clipboardController && !inputBusy && desktopSettings && !settingsBusy && !desktopSettings.busy;
  const adaptive = followsViewport() && controlsState.viewport?.supported;
  const live = desktopSettings?.canResize === true;
  for (const id of ['resolution-preset', 'desktop-width', 'desktop-height']) $(id).disabled = !!adaptive || viewportResizing;
  const dirty = settingsDirty();
  $('save-desktop-settings').disabled = !writable || !dirty;
  for (const id of ['apply-terminal-font', 'maximize-terminal', 'restore-terminal']) $(id).disabled = !writable || (id === 'apply-terminal-font' && dirty);
  $('apply-desktop-settings').disabled = !!adaptive || !writable || dirty || !desktopSettings?.applyRequired || (live ? !frameResizeReady || !nativeIdle || frameState !== 'connected' : !desktopSettings?.session?.recoverable || !$('confirm-desktop-restart').checked);
  $('desktop-restart-notice').hidden = !desktopSettings?.restartRequired;
  if (!desktopSettings) return;
  const { actual, saved, session, job } = desktopSettings;
  $('settings-current').textContent = actual ? `当前实际分辨率：${actual.width} × ${actual.height}` : '桌面尚未就绪，仍可保存下次启动的配置。';
  $('settings-pending').textContent = adaptive ? '桌面尺寸正在跟随浏览器窗口；关闭此选项后使用固定尺寸。'
    : desktopSettings.applyRequired ? `待应用：${saved.width} × ${saved.height}；${live ? '可立即生效，当前任务继续运行。' : '当前显示无法直接调整，需确认重启。'}` : `已应用：${saved.width} × ${saved.height}；当前分辨率无需重启。`;
  $('settings-recovery').textContent = session?.resumeId ? `将恢复会话 ${session.resumeId}，项目：${session.cwd}` : session?.recoverable ? '当前为 shell，重启后打开新的 shell，不自动启动任务。' : '当前会话无法准确识别或存在多个窗格。结束前台任务后再应用分辨率。';
  $('apply-desktop-settings').textContent = live ? '立即应用分辨率' : session?.resumeId ? '重启桌面并恢复会话' : '重启桌面应用设置';
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
    if (desktopSettings?.revision !== next.revision || desktopSettings?.session?.pid !== next.session?.pid || desktopSettings?.restartRequired !== next.restartRequired) $('confirm-desktop-restart').checked = false;
    desktopSettings = next;
    if (controlsState.viewport && next.fixed) controlsState.viewport = { ...controlsState.viewport, fixed: next.fixed, ...(next.maximum ? { maximum: next.maximum } : {}) };
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
  const live = path.endsWith('/resolution');
  if (live && (viewportController || !frameResizeReady || !nativeIdle || inputPaused())) return;
  stopSettingsPolling();
  const controller = live ? new AbortController() : null;
  const timeout = live ? setTimeout(() => controller.abort(), 10000) : null;
  const expected = { width: desktopSettings.saved.width, height: desktopSettings.saved.height };
  if (live) { viewportController = controller; viewportResizing = true; renderInputControls(); }
  const pausesInput = path.endsWith('/apply') || (path.endsWith('/terminal-display') && body.action === 'font');
  if (pausesInput) { maintenancePending = true; controlsState = { ...controlsState, maintenance: true }; renderConnection(); }
  settingsBusy = true; renderDesktopSettings();
  try {
    const result = await api(path, { method: 'POST', body, signal: controller?.signal || AbortSignal.timeout(10000) });
    if (live) {
      clearTimeout(timeout);
      controlsState.viewport = { ...controlsState.viewport, ...result };
      viewportApplied = '';
      await waitForViewport(result.actual, controller.signal);
    }
    if (result.job) desktopSettings = { ...desktopSettings, job: result.job, busy: true };
    else $('desktop-settings-status').textContent = '已保存。分辨率与字号需分别显式应用。';
    $('confirm-desktop-restart').checked = false;
    stopSettingsPolling();
    await loadDesktopSettings(true);
    if (live) $('desktop-settings-status').textContent = '分辨率已立即应用，当前任务保留，无需重启。';
  } catch (error) {
    if (live && !controller.signal.aborted && (!error.status || error.status >= 500)) {
      clearTimeout(timeout);
      await waitForViewport(expected, controller.signal).catch(() => {});
    }
    if (live) await loadDesktopSettings(true);
    $('desktop-settings-status').textContent = live && (!error.status || error.status >= 500) ? '分辨率应用结果未确认，请刷新设置查看；不会自动重试或重启桌面。' : error.message;
  }
  finally {
    clearTimeout(timeout);
    if (live && viewportController === controller) { viewportController = null; viewportResizing = false; viewportApplied = ''; }
    settingsBusy = false;
    if (pausesInput || live) { if (pausesInput) maintenancePending = false; stopPolling(); void poll(); }
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
  if (desktopSettings.canResize) return void settingsAction('/api/desktop/resolution', { revision: desktopSettings.revision });
  void settingsAction('/api/desktop/apply', { revision: desktopSettings.revision, panePid: desktopSettings.session.pid, resumeId: desktopSettings.session.resumeId, confirm: $('confirm-desktop-restart').checked });
});
for (const [id, action] of [['apply-terminal-font', 'font'], ['maximize-terminal', 'maximize'], ['restore-terminal', 'restore']]) $(id).addEventListener('click', () => {
  if (!$(id).disabled) void settingsAction('/api/desktop/terminal-display', { action, revision: desktopSettings.revision });
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('desktop-frame').contentWindow || !owned) return;
  if (event.data?.frame !== String(frameEpoch) || !frameLoaded) return;
  if (event.data?.type === 'codex-terminal-composition' && terminalMode() && typeof event.data.composing === 'boolean') {
    frameComposing = event.data.composing || historyToolsPortal.composing; renderInputControls(); return;
  }
  if (event.data?.type === 'codex-pointer-options') {
    if (!terminalMode() && canInput() && ['viewport', 'remote'].includes(event.data.scrollTarget)) updateDisplayPreferences({ scrollTarget: event.data.scrollTarget });
    return;
  }
  if (event.data?.type === 'codex-transport') {
    if (typeof event.data.issue === 'string' && (Object.hasOwn(directIssues, event.data.issue) || event.data.issue === '')) directIssue = event.data.issue;
    const route = event.data.details;
    const validEnd = value => value && (value.address === null || typeof value.address === 'string' && value.address.length <= 253 && /^[a-zA-Z0-9:.%-]+$/.test(value.address)) && (value.port === null || Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535);
    frameNetwork = route && ['IPv4', 'IPv6', 'unknown'].includes(route.family) && ['UDP', 'TCP', 'unknown'].includes(route.protocol) && validEnd(route.local) && validEnd(route.remote) && (route.rttMs === null || Number.isInteger(route.rttMs) && route.rttMs >= 0 && route.rttMs <= 600000)
      ? { family: route.family, protocol: route.protocol, rttMs: route.rttMs, local: { address: route.local.address, port: route.local.port }, remote: { address: route.remote.address, port: route.remote.port } } : null;
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-direct-prepare') {
    if (!Number.isSafeInteger(event.data.id) || event.data.id < 1) return;
    const allowed = loggedIn && owned && !accessExpired && panelState === 'online' && frameState === 'connected' && !inputPaused() && !inputBusy && !inputComposing && !frameComposing && !terminalBusy && !terminalReviewing && !$('terminals-dialog').open && !$('terminal-switch-dialog').open && !clipboardController && !$('clipboard-dialog').open && !controlPending && !settingsBusy && !confirmation && !shortcutMenu.open && !controlsState.inputBusy && !controlsState.clipboardBusy;
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
  if (event.data?.type === 'codex-stream-state' && typeof event.data.paused === 'boolean') {
    transportSwitching = event.data.paused; renderConnection(); return;
  }
  if (event.data?.type === 'codex-stream-reset' && ['input-unknown', 'input-pressure'].includes(event.data.reason)) {
    inputMessage('unknown', '部分输入结果未知，请先查看远程画面；不会自动重发提示词、Enter 或审批。');
    toast('部分输入结果未知，请先核对远程画面，避免重复执行。', true); return;
  }
  if (event.data?.type === 'codex-control-state') {
    controlReady = event.data.ready === true && frameState === 'connected' && ['direct', 'terminal'].includes(frameTransport);
    if (!controlReady) resetDirectControl();
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-terminal-size' && terminalMode()) {
    if (Number.isInteger(event.data.cols) && Number.isInteger(event.data.rows) && event.data.cols >= 2 && event.data.cols <= 500 && event.data.rows >= 1 && event.data.rows <= 200) terminalGeometry = { cols: event.data.cols, rows: event.data.rows,
      fontSize: Number.isFinite(event.data.fontSize) && event.data.fontSize >= 10 && event.data.fontSize <= 112 ? event.data.fontSize : displayPreferences.terminalFontSize };
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-terminal-history' && terminalMode() && typeof event.data.reviewing === 'boolean') {
    terminalReviewing = event.data.reviewing; renderInputControls(); return;
  }
  if (event.data?.type === 'codex-control-result') {
    if (!controlPending || event.data.id !== controlPending.id) return;
    const error = event.data.ok === true ? null : Object.assign(new Error(event.data.error?.message || '直连操作失败'), { outcome: event.data.error?.outcome || 'unknown', status: event.data.error?.status });
    finishDirectControl(error, event.data.value); return;
  }
  if (event.data?.type === 'codex-desktop-view') {
    if (event.data.revision !== displayRevision) return;
    nativeIdle = event.data.idle === true;
    if (typeof event.data.resizeReady === 'boolean') frameResizeReady = event.data.resizeReady;
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
  if (event.data.state === 'connected') { frameState = 'connected'; frameTransport = event.data.transport === 'direct' ? 'direct' : terminalMode() ? 'terminal' : 'relay'; sendDisplayPreferences(); }
  else if (event.data.state === 'disconnected') { resetDirectControl(); frameState = 'reconnecting'; scaleRevision = -1; clearClipboard(); renderClipboard(); }
  else if (event.data.state === 'connecting') { if (frameState !== 'reconnecting') frameState = 'connecting'; }
  else return;
  renderConnection();
});
document.addEventListener('fullscreenchange', () => shortcutMenu.close());
document.addEventListener('visibilitychange', () => { syncScreenLock(); if (!document.hidden) void poll(); else { shortcutMenu.close(); closeConfirmation(); } });
window.addEventListener('pagehide', () => { historyToolsPortal.reset(); if (loggedIn) rememberDraft(); pageLeaving = true; shortcutMenu.close(); closeConfirmation(); syncScreenLock(); });
window.addEventListener('pageshow', () => { pageLeaving = false; syncScreenLock(); });

accessUI = createAccessUI({ api, allowed: () => loggedIn && owned && permissions.role !== 'temporary' && !accessExpired,
  canUnlock: () => loggedIn && permissions.canClaim && !accessExpired, needsUnlock: () => permissions.requiresUnlock,
  lockEnabled: () => permissions.screenLockEnabled, claim, changed: updateAccess, activity: () => { renderInputControls(); scheduleViewport(); }, toast });
forwardingUI = createForwardUI({ api, allowed: () => loggedIn && !accessExpired && navigator.onLine && panelState === 'online',
  capabilities: () => ({ directions: permissions.canForward ? ['forward', 'reverse'] : ['reverse'], manageDevices: permissions.canManageDevices }) });
try { await showWorkspace(await api('/api/me')); } catch (error) { showLogin(accessExpired ? error.message : ''); }
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
