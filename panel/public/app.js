import { createShortcutMenu } from './shortcut-menu.js';
import { SHORTCUT_BY_KEY } from './shortcuts.js';
import { createForwardUI } from './forward-ui.js';
import { createWorkspaceLayout, createWorkspacePanels, createHistoryToolsPortal } from './workspace-panels.js';
import { createTerminalState, validTerminalIdentity, STATE_LIMIT } from './terminal-state.js';
import { createViewLifecycle } from './view-lifecycle.js';
import { TERMINAL_IDS, TERMINAL_CAPACITY, DEFAULT_TERMINAL_LIMIT } from './terminal-slots.js';
import { createTerminalTabs, createTerminalActions } from './terminal-tabs.js';
import { createAccessUI } from './access-ui.js';
import { HISTORY_ROWS } from './terminal-history-limits.js';
import { createBrowserPreferences, decodeBrowserPreferences, BROWSER_PREFERENCES_KEY } from './browser-preferences.js';
import { createRTCHints, hintIP } from './rtc-hints.js';
import { createServiceLink, serviceAction } from './service-link.js';
import { uploadHeaders } from './file-upload.js';
import { FILE_PAGE_LIMITS } from './file-list.js';
import { createWorkbenchFiles } from './workbench-files.js';
import { createWorkbenchClipboard } from './workbench-clipboard.js';
import { createWorkspaceLifetime } from './workspace-lifetime.js';
import { readFileDownload } from './file-transfer.js';
import { createRoundTrip } from './health.js';
import { createConnectionTrace, traceDescription, connectionProgress, TRACE_REASONS } from './connection-trace.js';
import { createInputNotices } from './input-notices.js';
import { nodeIdentity, nodeHeaders, nodeLink } from './node-scope.js';
import { entryPath, entryBasePath } from './entry-path.js';
import { rtcIceServers } from './rtc-ice.js';
import { createOfferBridge } from './rtc-offers.js';
import { rtcRouteKind, rtcRouteLabel, rtcDirectKind } from './rtc-stats.js';

const $ = id => document.getElementById(id);
const views = createViewLifecycle($('desktop-frame'));
const offerBridge = createOfferBridge({
  priority: entry => entry === views.active ? 0 : 2,
  allowed: entry => loggedIn && owned && !accessExpired && !pageLeaving && !cachedResumePending && !document.hidden && [views.active, views.standby].includes(entry),
  reply: (entry, value) => entry.element.contentWindow?.postMessage(value, location.origin),
});
window.addEventListener('pagehide', () => offerBridge.clear());
let csrf = '', viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), pollTimer, toastTimer, owned = false, loggedIn = false, pollController = null;
let forwardingUI;
let accessUI;
let fileWorkbench, inputDirection = 'send';
let transferDirectory = '';
let permissions = { role: 'admin', full: false, screenLockEnabled: false, requiresUnlock: false, canClaim: true, canManageHelpers: false, canViewHelperKeys: false };
let fastConnectEnabled = false;
let streamProtocolEnabled = false, modeStandbyEnabled = false;
let draftStorage;
try { draftStorage = sessionStorage; } catch {}
const terminalState = createTerminalState(draftStorage, nodeIdentity());
let draftIdentity = { id: '', token: '' }, draftNotice = '', desktopFocusFailureKey = '';
let draftLeavePending, draftUnloadApproved = false, draftUnloadListening = false, draftCopyBusy = false;
let inputBusy = false;
let inputComposing = false;
let inputController = null, inputFeedback = false, maintenancePending = false;
let controlsState = { available: false, maintenance: false, inputBusy: false };
let clipboardUI;
let panelState = 'connecting', desktopReady = null, accessExpired = false, nodeMismatch = false;
let diagnosticsController = null, diagnosticsTimer;
const relayLatency = createRoundTrip();
let browserStorage;
try { browserStorage = localStorage; } catch {}
const browserPreferences = createBrowserPreferences(browserStorage, { compact: matchMedia('(max-width: 700px)').matches }), displayPreferences = browserPreferences.value;
const connectionTrace = createConnectionTrace(undefined, { storage: draftStorage, scope: nodeIdentity() || entryBasePath, enabled: displayPreferences.networkDebug });
const inputNotices = createInputNotices();
let inputNoticeSequence = 0, statusNoticeCode = '', statusNoticeDismissed = false, inputHistoryChecked = false;
function renderInputNoticeHistory() {
  const list = $('input-notice-list'); list.replaceChildren();
  for (const record of inputNotices.snapshot().reverse()) {
    const item = document.createElement('li'), detail = document.createElement('p');
    item.textContent = `${new Date(record.at).toLocaleTimeString()} · ${record.dismissed ? '已收起' : '待核对'} · ${record.message}`;
    detail.className = 'muted'; detail.textContent = record.detail; item.append(detail); list.append(item);
  }
}
function addInputNotice(value, options) {
  const record = inputNotices.add(value, options); renderInputNoticeHistory(); return record;
}
function clearInputNotices() {
  inputNotices.clear(); views.active.inputNoticeKey = ''; statusNoticeCode = ''; statusNoticeDismissed = false; inputHistoryChecked = false; renderInputNoticeHistory();
}
function noticeTarget(id = selectedTerminal, token = selectedTerminalToken) {
  return terminalCatalog.find(item => item.id === id && item.token === token)?.name || (id === 'main' ? '主终端' : id || '当前窗口');
}
function streamInputNotice(value, { mode = displayPreferences.mode, epoch = views.active.epoch, standby = false, target = mode === 'terminal' ? noticeTarget() : '' } = {}) {
  const eventId = typeof value.eventId === 'string' && /^[a-f0-9]{32}$/.test(value.eventId) ? value.eventId : `legacy${++inputNoticeSequence}`;
  return addInputNotice({ key: `stream:${epoch}:${eventId}`, source: 'stream', mode, standby, target, reason: value.reason, path: value.path }, { activate: !standby });
}
$('close-connection-notice').addEventListener('click', event => {
  event.stopPropagation();
  const key = $('connection-notice').dataset.noticeKey;
  if (key) inputNotices.dismiss(key); else statusNoticeDismissed = true;
  renderInputNoticeHistory(); renderConnectionNotice();
  $('connection-button').focus({ preventScroll: true });
});
for (const name of ['keydown', 'keyup']) $('close-connection-notice').addEventListener(name, event => event.stopPropagation());
function recordConnection(type, detail, mode, standby = false, view = mode === 'service' ? undefined : views.active.epoch) {
  if (mode === 'service') { const progress = connectionProgress(type, detail); if (progress) serviceProgress = progress; }
  if (!loggedIn || !connectionTrace.enabled) return;
  if (connectionTrace.add({ ...detail, type }, { mode, standby, view }) && $('connection-dialog').open) traceRenderFrame ??= requestAnimationFrame(() => { traceRenderFrame = undefined; renderConnectionTrace(); });
}
let connectionTraceTimer, traceDownloadURL, traceDownloadTimer, traceRenderFrame, traceExportGeneration = 0;
let serviceProgress = {};
const connectionRequestFaults = new Map(); // Seven fixed request categories.
function connectionLogCurrent() {
  const route = value => rtcRouteKind(value) === 'relay' ? 'turn' : rtcRouteKind(value) === 'direct' ? rtcDirectKind(value) : 'unknown';
  return { online: navigator.onLine, visible: !document.hidden,
    platform: /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'other',
    revision: document.querySelector('meta[name="ui-revision"]')?.content,
    views: [views.active, views.standby].filter(entry => entry?.mode).map(entry => ({ mode: entry.mode, standby: entry === views.standby, state: entry.state, path: entry.transport === 'terminal' ? 'relay' : entry.transport,
      moduleReady: entry.moduleReady, firstFrame: entry.firstFrame, probe: entry.probe, probeReason: entry.probeReason,
      route: entry.transport === 'direct' ? route(entry.network) : ['relay', 'terminal'].includes(entry.transport) ? 'wss' : 'unknown',
      reason: connectionTrace.latest(entry.mode, entry.epoch)?.reason || entry.issue })).concat({ mode: 'service', state: serviceLink.ready ? 'connected' : serviceLink.running ? 'connecting' : 'idle', path: serviceLink.ready ? 'direct' : 'relay', route: serviceLink.ready ? route(serviceLink.state.route) : 'https', reason: serviceLink.state.issue, ...(serviceLink.running ? serviceProgress : {}) }) };
}
function renderConnectionTrace() {
  const list = $('connection-trace-list');
  if (!list || !$('connection-dialog').open) return;
  $('connection-debug-toggle').checked = displayPreferences.networkDebug;
  for (const id of ['copy-connection-trace', 'download-connection-trace', 'clear-connection-trace']) $(id).disabled = !connectionTrace.enabled;
  const names = { desktop: '桌面', terminal: '网页终端', service: '文件与映射服务' };
  $('connection-trace-current').textContent = connectionLogCurrent().views.map(view => {
    const entry = view.mode === views.active.mode && !view.standby ? views.active : view.standby ? views.standby : null;
    const latest = connectionTrace.latest(view.mode, entry?.epoch);
    const preparation = entry ? ` · ${view.moduleReady ? '模块已加载' : '模块加载中'} · ${view.firstFrame ? '首帧已接收' : '等待首帧'}` : '';
    const probe = ({ probing: '开始探测', gathering: '收集地址', queued: '等待协商名额', signaling: '交换连接信息', connecting: '建立通道', ready: '通道就绪', retrying: '等待重试', stopped: '自动探测已停止' })[view.probe];
    return `${names[view.mode]}${view.standby ? '（待命）' : ''}：${({ connected: '已连接', connecting: '连接中', reconnecting: '恢复中', idle: '未启动' })[view.state] || '等待连接'} · ${view.path === 'direct' ? 'WebRTC' : view.path === 'relay' ? '中转' : '路径待确认'}${preparation}${probe ? `\n  WebRTC：${probe}${TRACE_REASONS[view.probeReason] ? ' · ' + TRACE_REASONS[view.probeReason] : ''}` : ''}${latest ? '\n  ' + traceDescription(latest) : ''}`;
  }).join('\n');
  const capture = connectionTrace.stats;
  $('connection-trace-retention').textContent = !connectionTrace.enabled ? '调试日志已关闭，不采集过程记录。开启后立即生效，无需重新连接；关闭会清空本标签页当前节点的记录。' : `正在记录，已保留 ${capture.retained} 条${capture.droppedEvents ? `，已淘汰 ${capture.droppedEvents} 条` : ''}${capture.suppressedEvents ? `，已合并 ${capture.suppressedEvents} 次重复` : ''}。本标签页每节点最多 200 条、64 KiB、24 小时，最多 4 个节点；刷新后可查看。${connectionTrace.persisted ? '' : '浏览器存储不可用，当前仅保留内存记录。'}不记录终端文字、凭据或 IP。`;
  if (!$('connection-trace').open && connectionTrace.enabled) return;
  list.replaceChildren();
  for (const event of connectionTrace.snapshot().reverse()) {
    const item = document.createElement('li');
    const time = new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    item.textContent = `${time} · ${names[event.mode]}${event.standby ? '（待命）' : ''}${event.path ? event.path === 'direct' ? ' · 直连' : ' · 中转' : ''} · ${traceDescription(event)}`;
    item.dataset.level = ['probe-stopped', 'request-failed', 'heartbeat-timeout'].includes(event.type) ? 'error' : event.type === 'probe-waiting' || event.type === 'retry' ? 'wait' : 'normal';
    list.append(item);
  }
}
function clearConnectionTrace() {
  connectionTrace.clear();
  clearTraceExports();
  renderConnectionTrace();
}
function clearTraceExports() {
  traceExportGeneration++;
  if ($('connection-trace-copy')) { $('connection-trace-copy').value = ''; $('connection-trace-copy').hidden = true; }
  clearTimeout(traceDownloadTimer); if (traceDownloadURL) URL.revokeObjectURL(traceDownloadURL); traceDownloadURL = undefined;
}
function syncNetworkDebug() {
  if (connectionTrace.setEnabled(displayPreferences.networkDebug)) {
    connectionRequestFaults.clear(); clearTraceExports();
    if (connectionTrace.enabled) recordConnection('capture-start', {}, displayPreferences.mode);
    for (const entry of [views.active, views.standby]) if (entry?.loaded) entry.element.contentWindow?.postMessage({ type: 'codex-network-debug', frame: String(entry.epoch), enabled: displayPreferences.networkDebug }, location.origin);
  }
  $('network-debug').checked = displayPreferences.networkDebug;
  clearInterval(connectionTraceTimer); connectionTraceTimer = undefined;
  if ($('connection-dialog').open && connectionTrace.enabled) connectionTraceTimer = setInterval(() => { if (!document.hidden) renderConnectionTrace(); }, 1000);
  renderConnectionTrace();
}
$('connection-dialog').addEventListener('toggle', () => {
  syncNetworkDebug();
});
$('connection-trace').addEventListener('toggle', renderConnectionTrace);
for (const id of ['network-debug', 'connection-debug-toggle']) $(id).addEventListener('change', () => updateDisplayPreferences({ networkDebug: $(id).checked }));
window.addEventListener('storage', event => {
  if (event.storageArea !== browserStorage || event.key !== null && event.key !== BROWSER_PREFERENCES_KEY) return;
  displayPreferences.networkDebug = decodeBrowserPreferences(event.newValue).networkDebug;
  syncNetworkDebug();
});
$('clear-connection-trace')?.addEventListener('click', clearConnectionTrace);
$('copy-connection-trace')?.addEventListener('click', async () => {
  if (!loggedIn || !connectionTrace.enabled) return;
  const text = connectionTrace.text(connectionLogCurrent()), generation = uiGeneration, capture = traceExportGeneration;
  try { await navigator.clipboard.writeText(text); if (generation === uiGeneration && capture === traceExportGeneration && loggedIn && connectionTrace.enabled) toast('网络日志已复制，可直接粘贴分析'); }
  catch {
    if (generation !== uiGeneration || capture !== traceExportGeneration || !loggedIn || !connectionTrace.enabled || !$('connection-dialog').open) return;
    const field = $('connection-trace-copy'); field.value = text; field.hidden = false; field.focus(); field.select();
    toast('诊断已选中，可长按或按 Ctrl/Cmd+C 复制。');
  }
});
$('download-connection-trace').addEventListener('click', () => {
  if (!loggedIn || !connectionTrace.enabled || traceDownloadURL) return;
  const link = document.createElement('a');
  traceDownloadURL = URL.createObjectURL(new Blob([connectionTrace.text(connectionLogCurrent())], { type: 'application/json' }));
  link.href = traceDownloadURL; link.download = `codex-network-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link); link.click(); link.remove();
  traceDownloadTimer = setTimeout(() => { URL.revokeObjectURL(traceDownloadURL); traceDownloadURL = undefined; }, 1000);
});
window.addEventListener('pagehide', () => { connectionTrace.flush(); clearInterval(connectionTraceTimer); cancelAnimationFrame(traceRenderFrame); traceRenderFrame = undefined; clearTraceExports(); });
let relayProbeController, relayProbeAt = -Infinity;
const directIssues = { quality: '保留当前延迟更低的连接，备用通道继续待命', 'heartbeat-suspect': '心跳延迟，正在复核连接', busy: '服务器协商繁忙，稍后重试', auth: '连接权限已变化，请重新登录或接管', target: '终端身份已变化，请重新选择目标', protocol: '连接参数未被服务器接受，请检查配置', 'signal-failed': '协商服务暂不可达，稍后重试', unsupported: '当前浏览器环境不支持 WebRTC', disabled: '服务端已关闭 WebRTC', signaling: 'WebRTC 协商请求未完成',
  negotiation: 'WebRTC 未建立，等待后续探测', timeout: 'WebRTC 协商超时，等待后续探测',
  'signaling-timeout': 'WebRTC 协商请求超时，等待后续探测',
  'queue-timeout': '等待本页 WebRTC 协商名额超时，稍后重试',
  'negotiation-timeout': '本次 WebRTC 协商总时限已到，等待后续探测',
  'native-busy': '浏览器仍有未结束的原生协商，等待释放后再试',
  'gathering-timeout': 'WebRTC 地址收集超时，等待后续探测',
  'ice-timeout': 'WebRTC 路径探测超时；请检查网络权限、UDP 通道及中继配置',
  'channel-timeout': 'WebRTC 路径已接通，加密数据通道建立超时',
  connection: '原 WebRTC 通道已断开，正在恢复', heartbeat: 'WebRTC 心跳无回复，已开始回退 HTTPS / WebSocket' };
let controlReady = false, controlPending = null, controlSequence = 0, desktopTextInput = false, desktopTextFrame = '', desktopTextSequence = 0;
let panelSequence = 0, panelRoute = 'https', rtcConfig;
const panelRequests = new Map();
let switchTimer;
let desktopSettings = null, settingsController = null, settingsTimer, settingsBusy = false, settingsLoadError = '';
let viewportTimer, viewportController, viewportWaiter, viewportApplied = '', viewportResizing = false;
let confirmation = null, uiGeneration = 0;
let terminalCatalog = [], terminalSlots = [], selectedTerminal = '', terminalBusy = false, terminalFocusBusy = false, terminalSwitching = false, terminalController = null, terminalLoadAttempted = false;
let maxTerminals = DEFAULT_TERMINAL_LIMIT;
let selectedTerminalToken = '', terminalSelectionState = 'loading', terminalCatalogVerified = false, adoptWindowDraft = false;
let screenLock = null, wakeOperation = null, wakeEligible = false, wakeGeneration = 0, wakeFailed = false, pageLeaving = false, cachedResumePending = false, cachedViewReset = false;
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

const directHints = createRTCHints(browserStorage, { nodeId: nodeIdentity(), basePath: entryBasePath });
let hintProbe, hintProbeSequence = 0;
let workspaceInitialized = false, serviceProtocol = 0;
const serviceLink = createServiceLink({ viewer, options: () => ({ ...rtcConfig, csrf, hints: directHints.value }), changed: () => renderConnection(),
  canReplace: () => !fileWorkbench?.busy,
  trace: (type, detail) => recordConnection(type, detail, 'service') });
let terminalOnly = false;
const terminalMode = () => displayPreferences.mode === 'terminal';
function inputCollapsed() { return terminalMode() ? displayPreferences.terminalInputCollapsed : displayPreferences.collapsed; }
const followsViewport = () => displayPreferences.autoResolution;
const fixedSize = () => controlsState.viewport?.fixed || { width: 1600, height: 3200 };
let displayRevision = 0;
const workspacePanels = createWorkspacePanels({ tools: $('workspace-tools'), input: $('input-dock'),
  toolsButton: $('toggle-controls-button'), inputButton: $('toggle-input-button'), composing: () => inputComposing,
  close: name => closeWorkspacePanel(name, false) });
const historyToolsPortal = createHistoryToolsPortal({ frame: $('desktop-frame'), container: $('desktop-card'),
  valid: frame => loggedIn && owned && !accessExpired && views.active.loaded && terminalMode() && frame === String(views.active.epoch),
  opened: () => { shortcutMenu.close(); hideWorkspacePanels(); },
  composing: value => { if (views.active.composing !== value) { views.active.composing = value; renderInputControls(); } },
});
const terminalActions = createTerminalActions({ closeTerminal: requestCloseTerminal, changed: () => { sendDisplayPreferences(); scheduleViewport(); },
  renameTerminal: (terminal, name) => manageTerminals({ action: 'rename', terminalId: terminal.id, terminalToken: terminal.token, name }) });
const terminalTabs = createTerminalTabs({ bar: $('terminal-session-bar'), tabs: $('terminal-tabs'), mobileButton: $('terminal-session-button'),
  mobileActions: $('terminal-session-actions'), dialog: $('terminal-switch-dialog'), list: $('terminal-switch-list'),
  choose: id => terminalMode() ? selectTerminal(id) : selectDesktopTerminal(id), openActions: terminalActions.open, manage: openTerminalManager, changed: sendDisplayPreferences });
const workspaceLayout = createWorkspaceLayout({ workspace: $('workspace-view'), sidebar: $('workspace-sidebar'),
  preference: () => displayPreferences.workspaceLayout, changed: () => { renderTerminalSelection(); terminalTabs.layout(); historyToolsPortal.layout(); } });
function rememberDraft() {
  const saved = terminalState.save(draftIdentity, $('mobile-input').value);
  draftNotice = saved ? '' : '草稿空间已满，请先复制当前文字或在终端管理中清理旧终端草稿。';
  return saved;
}
function draftsAtRisk() {
  return permissions.role !== 'temporary' && (!!draftNotice && !!$('mobile-input').value || terminalState.persistenceFailed && terminalState.hasDrafts);
}
function beforeDraftUnload(event) {
  if (draftUnloadApproved) return;
  rememberDraft();
  if (!draftsAtRisk()) return;
  event.preventDefault(); event.returnValue = '';
}
function renderDraftSafety() {
  const risk = draftsAtRisk(), field = $('mobile-input'), backup = !!field.value || terminalState.hasDrafts;
  const text = risk ? '草稿仅在当前页面；离开前请复制或导出。' : field.value ? '当前草稿已保存在此浏览器标签页。' : terminalState.hasDrafts ? '本节点其他终端的草稿已保留。' : '当前草稿为空。';
  if ($('draft-save-state').textContent !== text) $('draft-save-state').textContent = text;
  $('draft-save-state').dataset.saved = String(!risk);
  for (const id of ['copy-draft', 'copy-leave-draft']) $(id).disabled = !field.value || draftCopyBusy || permissions.role === 'temporary';
  for (const id of ['export-drafts', 'export-leave-drafts']) $(id).disabled = !backup || permissions.role === 'temporary';
  $('draft-backup-button').disabled = !backup || permissions.role === 'temporary';
  if (risk && !draftUnloadListening) { window.addEventListener('beforeunload', beforeDraftUnload); draftUnloadListening = true; }
  else if (!risk && draftUnloadListening) { window.removeEventListener('beforeunload', beforeDraftUnload); draftUnloadListening = false; }
}
function closeDraftLeave() {
  draftLeavePending = undefined;
  if ($('draft-leave-dialog').open) $('draft-leave-dialog').close();
  $('draft-leave-preview').value = ''; $('draft-leave-preview').hidden = true; $('draft-leave-status').textContent = '';
  renderInputControls();
}
function leaveWorkspace(kind, force = false) {
  if (!['gateway', 'logout', 'refresh'].includes(kind) || kind !== 'refresh' && !loggedIn) return;
  const gatewayEntry = document.querySelector('meta[name="gateway-entry"]')?.content;
  if (kind === 'gateway' && (permissions.role === 'temporary' || !gatewayEntry)) return;
  if (kind === 'gateway' && !canLeaveNode()) return toast('请等待输入、配置或文件传输完成后再切换。', true);
  rememberDraft(); renderDraftSafety();
  if (!force && draftsAtRisk()) {
    if ($('draft-leave-dialog').open) return;
    draftLeavePending = { kind, generation: uiGeneration };
    $('draft-leave-title').textContent = '草稿尚未安全保存';
    $('draft-leave-description').textContent = '部分文字仅保留在当前页面。离开前请复制当前草稿，或导出本节点全部草稿。';
    $('confirm-draft-leave').hidden = false; $('cancel-draft-leave').textContent = '留在当前页面';
    $('draft-leave-status').textContent = ''; $('draft-leave-dialog').showModal(); $('cancel-draft-leave').focus(); renderInputControls(); return;
  }
  closeDraftLeave();
  if (kind === 'refresh') { draftUnloadApproved = true; location.reload(); return; }
  if (kind === 'gateway') { draftUnloadApproved = true; pageLeaving = true; syncScreenLock(); location.assign(gatewayEntry); return; }
  const generation = uiGeneration;
  void action($('logout-button'), async () => {
    await api('/api/logout', { method: 'POST', body: {}, signal: AbortSignal.timeout(8000) });
    if (generation === uiGeneration) { showLogin(); clearConnectionTrace(); }
  });
}
function initializeTerminalSelection() {
  const unsaved = draftNotice && $('mobile-input').value ? { ...draftIdentity, text: $('mobile-input').value } : null;
  const saved = terminalState.selection;
  draftIdentity = saved || { id: '', token: '' };
  selectedTerminal = saved?.id || (terminalMode() ? 'main' : '');
  selectedTerminalToken = saved?.token || '';
  terminalSelectionState = 'loading'; adoptWindowDraft = terminalMode() && !saved?.id;
  terminalCatalogVerified = false;
  $('mobile-input').value = terminalState.read(draftIdentity);
  if (unsaved) {
    draftIdentity = { id: unsaved.id, token: unsaved.token }; selectedTerminal = unsaved.id; selectedTerminalToken = unsaved.token;
    $('mobile-input').value = unsaved.text; adoptWindowDraft = false;
  }
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
    const terminal = terminalCatalog.find(item => item.id === selectedTerminal);
    if (terminal?.supported && !selectedTerminalToken && selectedTerminal === 'main') activateTerminal({ id: terminal.id, token: terminal.token }, { adopt: adoptWindowDraft });
    else terminalSelectionState = terminal?.supported && terminal.token === selectedTerminalToken ? 'ready' : !terminal && terminalSlots.some(item => item.id === selectedTerminal) ? 'closed' : 'invalid';
  }
  adoptWindowDraft = false;
  if (terminalMode() && ['invalid', 'closed'].includes(terminalSelectionState) && views.active.loaded && !views.active.terminalAttachment) stopFrame();
}
function terminalEntries() {
  const entries = TERMINAL_IDS.map(id => terminalCatalog.find(item => item.id === id)).filter(Boolean);
  if (terminalSlots.length) entries.push({ id: 'new', name: '新开终端', available: true,
    supported: terminalCatalog.length < maxTerminals && terminalSlots.some(slot => !terminalCatalog.some(item => item.id === slot.id)) });
  return entries;
}
function selectTerminal(id) {
  if (confirmation) { closeConfirmation(); renderTerminalList(); return false; }
  if (!canManageTerminals() || inputComposing || views.active.composing) { renderTerminalList(); return false; }
  if (id === 'new') {
    const slot = terminalSlots.find(item => !terminalCatalog.some(terminal => terminal.id === item.id));
    if (!slot || terminalCatalog.length >= maxTerminals) return false;
    if (!rememberDraft()) return false;
    void manageTerminals({ action: 'create', terminalId: slot.id, name: slot.name }); return true;
  }
  const terminal = terminalCatalog.find(item => item.id === id && item.supported);
  if (id && !terminal || !id && terminalMode()) return false;
  const identity = id ? { id: terminal.id, token: terminal.token } : { id: '', token: '' };
  if (terminalMode() && views.active.loaded && views.active.terminalSwitchReady && (views.active.key !== `${identity.id}:${identity.token}` || views.active.terminalAttachment && views.active.attachmentState !== 'ready')) {
    if (!rememberDraft()) return false;
    void switchTerminalStream(identity); return true;
  }
  if (!activateTerminal(identity)) { renderTerminalSelection(); return false; }
  shortcutMenu.close(); renderTerminalList(); if (terminalMode()) syncTerminalView(true); else syncModeStandby();
  return true;
}
function requestCloseTerminal(terminal) {
  if (!canManageTerminals() || inputComposing || views.active.composing || confirmation || !terminalCatalog.some(item => item.id === terminal.id && item.token === terminal.token && item.supported)) return;
  $('terminal-switch-dialog').close();
  requestConfirmation('terminal-close', null, { action: 'close', terminalId: terminal.id, terminalToken: terminal.token });
}
function selectDesktopTerminal(id) {
  const terminal = terminalCatalog.find(item => item.id === id && item.supported);
  if (!terminal || !canManageTerminals() || inputComposing || views.active.composing || confirmation || !rememberDraft()) return false;
  const generation = uiGeneration;
  void manageTerminals({ action: 'open', terminalId: terminal.id, terminalToken: terminal.token }).then(result => {
    if (generation !== uiGeneration || !owned) return;
    if (!result?.ok) { if (result?.outcome === 'unknown') { desktopFocusFailureKey = `${selectedTerminal}:${selectedTerminalToken}`; renderConnection(); } return; }
    if (selectedTerminal === terminal.id && selectedTerminalToken === terminal.token && terminalSelectionState === 'ready') toast(`已切换到 ${terminal.name}，输入助手目标已同步。`);
    else toast('终端窗口已打开，输入助手目标尚未切换；请先保存草稿，再手动选择目标。', true);
  });
  return true;
}
function desktopFocusUnconfirmed() { return !terminalMode() && desktopFocusFailureKey === `${selectedTerminal}:${selectedTerminalToken}`; }
function openTerminalManager() {
  shortcutMenu.close(); $('terminals-dialog').showModal(); sendDisplayPreferences(); void loadTerminals();
}
function renderTerminalSelection() {
  const invalid = terminalSelectionState === 'invalid' || terminalSelectionState === 'error';
  const disabled = !canManageTerminals() || inputComposing || views.active.composing || !!confirmation;
  const entries = terminalMode() ? terminalEntries() : terminalEntries().filter(item => !item.available);
  terminalTabs.render(entries, terminalSelectionState === 'closed' ? 'new' : selectedTerminal, { visible: owned && entries.length > 0, disabled, invalid, loading: terminalSelectionState === 'loading', desktop: !terminalMode() });
  terminalActions.render(entries, { visible: owned, disabled });
  const message = desktopFocusUnconfirmed() ? '桌面窗口尚未确认切换，草稿已保留；请重新点击目标终端标签。'
    : invalid ? '原终端未通过身份校验，草稿已保留；请刷新列表或手动选择目标。'
    : draftNotice || (terminalState.persistenceFailed ? '浏览器未能保存草稿，刷新前请复制重要文字。' : '');
  $('draft-status').textContent = message; $('draft-status').hidden = !message;
  renderDraftSafety();
  $('terminal-switch-status').textContent = invalid || desktopFocusUnconfirmed() ? message : terminalSelectionState === 'loading' ? '正在核对终端…' : '';
  $('terminal-switch-refresh').disabled = !loggedIn || terminalBusy;
  $('terminal-switch-manage').disabled = !loggedIn || terminalBusy;
  const stale = terminalCatalogVerified ? terminalState.stale(terminalCatalog, draftIdentity) : 0;
  $('clear-stale-drafts').disabled = !stale || terminalBusy || !!confirmation;
  $('clear-stale-drafts').textContent = stale ? `清理旧终端草稿（${stale}）` : '清理旧终端草稿';
}
function closeWorkspacePanel(name = workspacePanels.active, desktopFocus = true) {
  shortcutMenu.close();
  updateDisplayPreferences(name === 'tools' ? { controlsCollapsed: true } : terminalMode() ? { terminalInputCollapsed: true } : { collapsed: true });
  if (desktopFocus) restoreDesktopFocus();
}
function restoreDesktopFocus() {
  if (!terminalMode() && !workspacePanels.active && canInput(true) && !inputBusy && !confirmation && !document.querySelector('dialog[open]')) {
    const frame = $('desktop-frame'); frame.focus({ preventScroll: true });
    frame.contentWindow.postMessage({ type: 'codex-desktop-focus', frame: String(views.active.epoch) }, location.origin);
  }
}
function hideWorkspacePanels() {
  if (workspacePanels.active) updateDisplayPreferences({ controlsCollapsed: true, collapsed: true, terminalInputCollapsed: true });
}
function toggleWorkspacePanel(name, desktopFocus = true) {
  historyToolsPortal.dismiss();
  const opening = workspacePanels.active !== name;
  shortcutMenu.close();
  updateDisplayPreferences({ controlsCollapsed: name !== 'tools' || !opening,
    ...(terminalMode() ? { terminalInputCollapsed: name !== 'input' || !opening } : { collapsed: name !== 'input' || !opening }) });
  if (opening) { workspacePanels.focus(); if (name === 'input') $('mobile-input').focus({ preventScroll: true }); }
  else if (desktopFocus) restoreDesktopFocus();
}
function sendDisplayPreferences() {
  if (views.standby) sendStandbyPreferences();
  if (!views.active.loaded || !owned) return;
  $('desktop-frame').contentWindow.postMessage({ type: 'codex-desktop-options', frame: String(views.active.epoch), standby: false, rtc: { ...rtcConfig, hints: directHints.value }, zoom: displayPreferences.zoom, pan: displayPreferences.pan, blocked: inputPaused() || !!accessUI?.blocking,
    pointerMode: displayPreferences.pointerMode, scrollTarget: displayPreferences.scrollTarget, networkDebug: displayPreferences.networkDebug,
    handoff: (views.active.paused || viewportResizing) && !maintenancePending && !controlsState.maintenance && controlsState.available,
    csrf, desktopIme: displayPreferences.desktopIme, ...(terminalMode() ? { terminalFontSize: displayPreferences.terminalFontSize, terminalWidthMode: displayPreferences.terminalWidthMode, terminalHistoryRows: displayPreferences.terminalHistoryRows, terminalMouseReporting: displayPreferences.terminalMouseReporting } : {}),
    busy: views.active.activationPending || (inputBusy && !desktopTextInput) || inputComposing || terminalBusy || terminalActions.busy || $('terminals-dialog').open || $('terminal-switch-dialog').open || $('draft-leave-dialog').open || !!clipboardUI?.busy || (controlsState.inputBusy && !desktopTextInput) || controlsState.clipboardBusy || settingsBusy || !!confirmation || shortcutMenu.open || !!accessUI?.blocking, revision: displayRevision }, location.origin);
}
function zoomBase() { return typeof displayPreferences.zoom === 'number' ? displayPreferences.zoom : views.active.scaleRevision === displayRevision ? views.active.scale : 0; }
function desktopPanActive() { return !terminalMode() && displayPreferences.pan; }
function renderFullscreenControls() {
  const active = Boolean(document.fullscreenElement);
  const label = active ? '退出全屏' : terminalMode() ? '全屏终端' : '全屏桌面';
  const button = $('fullscreen-button');
  if (button.title === label) return;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('.sidebar-only').textContent = active ? '退出全屏' : '全屏';
  button.querySelector('path').setAttribute('d', active
    ? 'M3 8h5V3m13 5h-5V3m5 13h-5v5M3 16h5v5'
    : 'M8 3H3v5m13-5h5v5m0 8v5h-5m-8 0H3v-5');
  $('tools-fullscreen-button').textContent = active ? '退出全屏' : '全屏';
}
function renderDisplayControls() {
  workspaceLayout.render();
  $('workspace-layout').value = displayPreferences.workspaceLayout;
  const toolsMode = terminalMode() ? 'terminal' : 'desktop';
  // Use hidden attributes so later panel layout rules cannot expose controls
  // for the other mode. Switching visibility never resets stored preferences.
  for (const control of $('workspace-tools').querySelectorAll('[data-tools-mode]')) control.hidden = control.dataset.toolsMode !== toolsMode;
  $('mode-standby-option').hidden = terminalOnly;
  $('mode-standby').checked = displayPreferences.modeStandby;
  $('network-debug').checked = displayPreferences.networkDebug;
  $('desktop-ime').checked = displayPreferences.desktopIme;
  $('mode-standby').disabled = !modeStandbyEnabled || modeChangeBusy() || !!confirmation;
  $('display-controls').setAttribute('aria-label', terminalMode() ? '网页终端显示控制' : '桌面显示控制');
  $('tools-display-title').textContent = terminalMode() ? '终端显示' : '画面显示';
  const preferencesNote = browserPreferences.persisted ? '显示偏好仅存于当前浏览器，所有终端共用。' : '浏览器未能保存显示偏好，刷新后可能恢复默认。';
  if ($('browser-preferences-note').textContent !== preferencesNote) $('browser-preferences-note').textContent = preferencesNote;
  $('browser-preferences-note').dataset.saved = String(browserPreferences.persisted);
  for (const id of ['toggle-controls-button', 'toggle-input-button', 'fullscreen-button']) $(id).hidden = loggedIn && !owned;
  $('desktop-mode').hidden = $('terminal-mode').hidden = terminalOnly || loggedIn && !owned;
  $('desktop-mode').parentElement.hidden = terminalOnly || loggedIn && !owned;
  $('clipboard-button').hidden = terminalOnly;
  $('create-terminal').textContent = terminalOnly ? '新建终端' : '新建辅助终端';
  $('diag-desktop').previousElementSibling.textContent = terminalOnly ? '终端服务' : '远程桌面';
  $('diag-frame').previousElementSibling.textContent = terminalMode() ? '终端界面' : '桌面画面';
  $('diag-resolution').previousElementSibling.textContent = terminalMode() ? '终端尺寸' : '实际分辨率';
  $('desktop-card').classList.toggle('terminal-mode', terminalMode());
  $('desktop-mode').setAttribute('aria-pressed', String(!terminalMode())); $('terminal-mode').setAttribute('aria-pressed', String(terminalMode()));
  $('desktop-mode').parentElement.setAttribute('aria-label', `操作模式，当前为${terminalMode() ? '网页终端' : '桌面'}`);
  $('desktop-mode').title = '切换到桌面'; $('terminal-mode').title = '切换到网页终端';
  $('view-title').textContent = terminalMode() ? '网页终端' : '开发桌面';
  renderFullscreenControls();
  $('terminal-font-label').textContent = String(displayPreferences.terminalFontSize);
  const fittedFont = views.active.geometry?.fontSize;
  $('terminal-font-label').title = displayPreferences.terminalWidthMode === 'scale' && fittedFont > displayPreferences.terminalFontSize
    ? `基础字号 ${displayPreferences.terminalFontSize}，适应宽度后为 ${fittedFont}` : `字号 ${displayPreferences.terminalFontSize}`;
  $('terminal-width-mode').value = displayPreferences.terminalWidthMode;
  $('terminal-history-rows').value = String(displayPreferences.terminalHistoryRows);
  $('terminal-mouse-reporting').checked = displayPreferences.terminalMouseReporting;
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
  const pan = desktopPanActive();
  $('pan-input-note').hidden = !pan;
  $('mobile-input').setAttribute('aria-describedby', pan ? 'terminal-target-note pan-input-note' : 'terminal-target-note');
  $('pointer-mode').value = displayPreferences.pointerMode;
  $('scroll-target').value = displayPreferences.scrollTarget;
  // Older saved preferences could have both inline sections expanded.
  // Input takes the shared panel slot until the user chooses another tool.
  workspacePanels.render(!inputCollapsed() ? 'input' : !displayPreferences.controlsCollapsed ? 'tools' : '');
  $('end-pan-button').hidden = !(pan && loggedIn && owned && views.active.state === 'connected' && !workspacePanels.active);
  if (workspacePanels.active !== 'input' || terminalOnly) { clearClipboard(); inputDirection = 'send'; }
  renderClipboard();
  $('tools-title').textContent = terminalMode() ? '终端工具' : '桌面工具';
  $('desktop-card').classList.toggle('controls-collapsed', displayPreferences.controlsCollapsed);
  const base = zoomBase(), ready = views.active.loaded && views.active.state === 'connected';
  $('zoom-label').textContent = base ? `${Math.round(base * 100)}%` : '—';
  $('zoom-out-button').disabled = !ready || !base || base <= 0.1;
  $('zoom-in-button').disabled = !ready || !base || base >= 2;
  historyToolsPortal.layout();
}
function updateDisplayPreferences(change) {
  if (change.zoom !== undefined && change.zoom !== displayPreferences.zoom) displayRevision++;
  browserPreferences.update(change);
  if (change.networkDebug !== undefined) { syncNetworkDebug(); if (Object.keys(change).length === 1) return; }
  renderDisplayControls();
  if (change.pan !== undefined) renderInputControls();
  else sendDisplayPreferences();
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
$('end-pan-button').addEventListener('click', () => {
  updateDisplayPreferences({ pan: false });
  restoreDesktopFocus();
});
$('pointer-mode').addEventListener('change', () => updateDisplayPreferences({ pointerMode: $('pointer-mode').value, pan: false }));
$('scroll-target').addEventListener('change', () => updateDisplayPreferences({ scrollTarget: $('scroll-target').value }));
$('toggle-input-button').addEventListener('click', event => toggleWorkspacePanel('input', event.detail > 0));
$('toggle-controls-button').addEventListener('click', event => toggleWorkspacePanel('tools', event.detail > 0));
$('workspace-layout').addEventListener('change', () => updateDisplayPreferences({ workspaceLayout: $('workspace-layout').value }));
$('sidebar-top-layout').addEventListener('click', () => updateDisplayPreferences({ workspaceLayout: 'top' }));
$('close-input-button').addEventListener('click', event => closeWorkspacePanel('input', event.detail > 0));
$('close-controls-button').addEventListener('click', event => closeWorkspacePanel('tools', event.detail > 0));
$('tools-fullscreen-button').addEventListener('click', () => { closeWorkspacePanel('tools'); $('fullscreen-button').click(); });
for (const id of ['input-keyboard-button', 'assistant-send-button']) $(id).addEventListener('click', () => setInputDirection('send', true));
renderDisplayControls();

function inputPaused() { return pageLeaving || cachedResumePending || viewportResizing || controlsState.viewportBusy || views.active.paused || maintenancePending || controlsState.maintenance || !controlsState.available; }
function scheduleViewport(delay = 500) {
  clearTimeout(viewportTimer);
  if (!loggedIn || !owned || !views.active.loaded || !views.active.resizeReady || views.active.state !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
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
    const check = () => { if (views.active.dimensions?.width === actual.width && views.active.dimensions?.height === actual.height) finish(); };
    const timer = setTimeout(() => finish(new Error('等待画面尺寸更新超时')), 3000);
    viewportWaiter = check; signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}
async function resizeViewport() {
  viewportTimer = null;
  if (terminalMode() || !loggedIn || !owned || !views.active.loaded || !views.active.resizeReady || views.active.state !== 'connected' || !controlsState.viewport?.supported || viewportController) return;
  if (!views.active.nativeIdle || views.active.touchInput || document.documentElement.classList.contains('workspace-keyboard-open') || inputPaused() || inputBusy || terminalBusy || terminalActions.busy || $('terminals-dialog').open || clipboardUI?.busy || controlsState.inputBusy || controlsState.clipboardBusy || settingsBusy || confirmation || shortcutMenu.open || accessUI?.blocking || document.hidden) { scheduleViewport(1000); return; }
  const rect = $('desktop-stage').getBoundingClientRect();
  const size = followsViewport() ? { width: Math.min(8192, Math.max(160, Math.floor(rect.width))), height: Math.min(8192, Math.max(160, Math.floor(rect.height))) } : fixedSize();
  if (!followsViewport() && (controlsState.viewport.maximum.width < size.width || controlsState.viewport.maximum.height < size.height)) return;
  const signature = `${views.active.epoch}:${size.width}x${size.height}`;
  if (signature === viewportApplied) return;
  if (views.active.dimensions?.width === size.width && views.active.dimensions?.height === size.height) { viewportApplied = signature; return; }
  const controller = viewportController = new AbortController(), epoch = views.active.epoch;
  const timer = setTimeout(() => controller.abort(), 7000);
  viewportResizing = true; renderInputControls(); sendDisplayPreferences();
  try {
    const result = await api('/api/desktop/viewport', { method: 'POST', body: size, signal: controller.signal });
    clearTimeout(timer);
    await waitForViewport(result.actual, controller.signal);
    if (viewportController === controller && views.active.epoch === epoch) viewportApplied = signature;
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
function canInput(focused = false) {
  if (desktopPanActive()) return false;
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && desktopReady === true && views.inputReady() && !inputPaused() && !terminalBusy && (focused === true && !terminalMode() || terminalSelectionState === 'ready' && !desktopFocusUnconfirmed()) && (!terminalMode() || !views.active.reviewing) && !$('draft-leave-dialog').open && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardUI?.busy && !accessUI?.blocking;
}
function canManageTerminals(allowPaused = false) {
  return loggedIn && owned && !pageLeaving && !cachedResumePending && !accessExpired && navigator.onLine && panelState === 'online' && controlsState.available && (allowPaused === true || !inputPaused()) && !inputBusy && !terminalBusy && !settingsBusy && !controlsState.inputBusy && !controlsState.clipboardBusy && !clipboardUI?.busy && !accessUI?.blocking;
}
function renderInputControls() {
  $('desktop-frame').inert = terminalFocusBusy || pageLeaving || cachedResumePending;
  $('gateway-switch-button').hidden = !document.querySelector('meta[name="gateway-entry"]') || permissions.role === 'temporary';
  const disabled = inputBusy || inputComposing || views.active.composing || !canInput();
  for (const control of [$('paste-button'), $('terminal-button'), $('shortcuts-button'), ...document.querySelectorAll('[data-key], [data-shortcut]')]) control.disabled = disabled;
  if (disabled) shortcutMenu.close();
  for (const control of [$('terminals-button'), $('create-terminal'), ...$('terminal-list').querySelectorAll('button, input')]) control.disabled = !canManageTerminals() || control.closest('.terminal-row')?.dataset.supported === 'false';
  $('input-terminal').disabled = !canManageTerminals() || inputComposing || views.active.composing || !!confirmation;
  $('create-terminal').disabled = !canManageTerminals() || terminalCatalog.length >= maxTerminals;
  $('new-terminal-name').disabled = !canManageTerminals() || terminalCatalog.length >= maxTerminals;
  $('refresh-terminals').disabled = !loggedIn || terminalBusy;
  $('paste-target').disabled = !!selectedTerminal;
  $('desktop-mode').disabled = $('terminal-mode').disabled = modeChangeBusy() || !!confirmation;
  $('terminal-view-select').disabled = !canManageTerminals() || inputComposing || views.active.composing || !!confirmation;
  $('terminal-view-manage').disabled = !canManageTerminals();
  renderTerminalSelection();
  renderFileControls();
  sendDisplayPreferences();
}
function needsRelayProbe() {
  return workspaceInitialized && loggedIn && !accessExpired && !pageLeaving && !document.hidden && navigator.onLine &&
    (!owned ? !serviceLink.ready : views.active.state === 'connected' && views.active.transport !== 'direct' && !streamProtocolEnabled && !terminalMode());
}
function syncRelayLatency() {
  if (!needsRelayProbe()) {
    relayProbeController?.abort(); relayProbeController = null; relayProbeAt = -Infinity; relayLatency.clear(); return;
  }
  if (relayProbeController || performance.now() - relayProbeAt < 3000) return;
  const controller = relayProbeController = new AbortController();
  relayProbeAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), 6000), startedAt = relayProbeAt;
  // Only restricted HTTPS access and older desktop relays lack an application
  // heartbeat. A tiny uncached read measures that route without desktop input.
  void (async () => {
    try {
      const response = await fetch(entryPath('/healthz'), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok || (await response.json()).ok !== true) throw Error('往返检测未完成');
      if (relayProbeController === controller && needsRelayProbe()) relayLatency.set(performance.now() - startedAt);
    } catch { if (relayProbeController === controller) relayLatency.clear(); }
    finally {
      clearTimeout(timeout);
      if (relayProbeController === controller) { relayProbeController = null; renderConnection(); }
    }
  })();
}
function renderConnectionNotice() {
  let message = '', code = '', record;
  if (loggedIn && owned) {
    if (accessExpired) { code = 'access'; message = '访问验证已过期，输入已暂停；请刷新页面完成验证。'; }
    else if (!navigator.onLine) { code = 'offline'; message = '网络已断开，输入已暂停；恢复后继续原会话，不会补发输入。'; }
    else if (panelState === 'offline') { code = 'service'; message = '服务连接中断，输入已暂停；正在恢复，不会补发输入。'; }
    else if ((record = inputNotices.current)) message = record.message;
    else if (views.active.paused) { code = 'switch'; message = '正在复核或切换连接，输入暂时暂停；已发送内容不会重发。'; }
    else if (terminalMode() && ['invalid', 'error'].includes(terminalSelectionState)) { code = 'target'; message = '终端目标待确认，输入已暂停；请选择有效终端。'; }
    else if (maintenancePending || controlsState.maintenance) { code = 'maintenance'; message = '桌面操作进行中，输入已暂停；请等待操作完成。'; }
    else if (!controlsState.available) { code = 'input-service'; message = '输入服务暂不可用，输入已暂停；当前任务继续运行。'; }
    else if (views.active.state !== 'connected' && !(terminalMode() && terminalSelectionState === 'closed')) { code = 'reconnect'; message = '正在恢复连接，输入已暂停；原任务继续运行。'; }
  }
  if (statusNoticeCode !== code) { statusNoticeCode = code; statusNoticeDismissed = false; }
  // Dismissing a network episode must not also silence a new input event.
  if (!record && statusNoticeDismissed && loggedIn && owned && (record = inputNotices.current)) message = record.message;
  const notice = $('connection-notice');
  $('connection-notice-text').textContent = message; notice.dataset.noticeKey = record?.key || '';
  $('close-connection-notice').title = record ? '收起提示，可在连接状态中查看详情' : '收起提示，连接状态和输入限制保持';
  notice.hidden = !message || (!record && statusNoticeDismissed);
}
function renderConnection() {
  fileWorkbench?.revalidate();
  if (workspaceInitialized && !pageLeaving && !cachedResumePending && loggedIn && !owned && !accessExpired && serviceProtocol === 1) serviceLink.start();
  syncRelayLatency();
  forwardingUI?.update();
  accessUI?.update();
  if (confirmation && !confirmationValid(confirmation)) closeConfirmation();
  syncScreenLock();
  let label;
  if (nodeMismatch) label = '入口已切换';
  else if (accessExpired) label = '访问验证已过期';
  else if (!navigator.onLine || panelState === 'offline') label = '等待网络';
  else if (pageLeaving || cachedResumePending) label = '正在核对会话';
  else if (!owned) label = permissions.role === 'temporary' ? '临时访问' : permissions.requiresUnlock ? '屏幕已锁定' : '等待接管';
  else if (desktopReady === false) label = terminalOnly ? '终端后台未就绪' : '桌面未就绪';
  else if (views.active.paused) label = '正在优化连接';
  else if (maintenancePending || controlsState.maintenance) label = '桌面操作进行中';
  else if (!controlsState.available) label = '输入服务未就绪';
  else if (terminalSwitching) label = '正在切换终端…';
  else if (terminalMode() && terminalSelectionState === 'closed') label = '终端已关闭';
  else if (terminalMode() && views.active.terminalAttachment && views.active.attachmentState === 'exited') label = '终端已退出';
  else if (terminalMode() && views.active.terminalAttachment && views.active.attachmentState === 'failed') label = '终端附加失败';
  else if (terminalMode() && views.active.terminalAttachment && views.active.attachmentState === 'expired') label = '查看连接已释放';
  else if (terminalMode() && views.active.terminalAttachment && views.active.attachmentState === 'attaching') label = '正在附加终端';
  else if (terminalMode() && ['invalid', 'error'].includes(terminalSelectionState)) label = '终端目标待确认';
  else if (views.active.state === 'connected') label = terminalMode() ? '终端在线' : '桌面在线';
  else label = views.active.state === 'reconnecting' ? '画面重连中' : '画面连接中';
  $('connection-status').classList.toggle('offline', !['桌面在线', '终端在线', '正在切换终端…', '终端已关闭'].includes(label));
  $('connection-status').lastChild.textContent = label;
  const overviewState = ['桌面在线', '终端在线'].includes(label) ? 'healthy' : nodeMismatch || accessExpired || !navigator.onLine || panelState === 'offline' ? 'offline' : !owned ? 'limited' : 'pending';
  $('connection-overview').dataset.state = overviewState;
  if ($('connection-summary').textContent !== label) $('connection-summary').textContent = label;
  const overviewNote = nodeMismatch ? '入口节点已切换，请刷新页面连接新节点。' : accessExpired ? '请重新验证访问，服务器上的既有任务继续运行。' : !navigator.onLine || panelState === 'offline' ? '正在等待网络恢复，服务器上的既有任务继续运行。' : !owned ? '画面访问与文件、映射服务分别授权，已有映射不受影响。' : overviewState === 'healthy' ? '当前会话可用。画面、输入和文件分别显示各自使用的通道。' : views.active.state === 'reconnecting' ? '正在恢复画面连接，状态恢复前请勿重复提交操作。' : '请查看下方会话信息；后台服务详情可展开查看。';
  if ($('connection-summary-note').textContent !== overviewNote) $('connection-summary-note').textContent = overviewNote;
  renderConnectionNotice();
  const route = views.active.state === 'connected' && views.active.transport === 'direct' ? views.active.network : null;
  const selected = route || serviceLink.state.route, hints = directHints.value;
  $('direct-hints-active').textContent = !selected ? '当前未确认 WebRTC 端点，保存的提示尚不能证明已生效。' :
    (route ? '工作区当前路径：' : '文件与服务当前路径：') + rtcRouteLabel(selected) + '。' + [['server', 'remote', '节点'], ['browser', 'local', '浏览器']].filter(([key]) => hints[key]).map(([key, side, label]) =>
      `${label}提示：${!selected[side]?.address ? '端点被隐藏，无法确认' : hintIP(selected[side].address) === hints[key] ? '与当前端点一致' : '与当前端点不同'}`).join('；');
  const panelPath = panelRoute === 'service' ? rtcRouteLabel(serviceLink.state.route) : panelRoute === 'direct' ? rtcRouteLabel(route) : panelRoute === 'terminal' ? 'HTTPS / WebSocket' : 'HTTPS';
  const routeStatus = value => ({ direct: '已建立加密直连', relay: '已建立 TURN 中继（端到端加密）', unknown: '已建立 WebRTC 加密通道，路径待确认' })[rtcRouteKind(value)];
  $('diag-panel').textContent = accessExpired ? '访问验证已过期' : panelState === 'online' ? `可访问（${panelPath}）` : panelState === 'offline' ? '连接中断' : '等待检测';
  $('diag-desktop').textContent = desktopReady === null ? '等待检测' : desktopReady ? '已就绪' : '未就绪';
  $('diag-frame').textContent = !owned ? '等待接管' : views.active.state === 'connected' ? '已连接' : views.active.state === 'reconnecting' ? '重连中' : '等待连接';
  $('diag-transport').textContent = views.active.state !== 'connected' ? '等待连接' : views.active.transport === 'terminal' ? 'HTTPS / WebSocket 文字终端' : views.active.transport === 'direct' ? rtcRouteLabel(route) + (terminalMode() ? ' · 文字终端' : '') : 'HTTPS / WebSocket 中转';
  $('diag-input-transport').textContent = views.active.state !== 'connected' ? '等待连接' : views.active.transport === 'terminal' ? '网页终端加密通道' : controlReady ? rtcRouteLabel(route) : 'HTTPS';
  renderFileTransport();
  const endpoint = value => `${value.address === null ? '浏览器隐藏地址' : value.address.includes(':') ? `[${value.address}]` : value.address}${value.port ? `:${value.port}` : ''}（${({ host: '主机地址', srflx: 'NAT 映射地址', prflx: '对端发现地址', relay: 'TURN 中继地址' })[value.type] || '类型未知'}）`;
  $('diag-network').textContent = route ? `${route.family} / ${route.protocol}` : views.active.transport === 'direct' && views.active.state === 'connected' ? '浏览器尚未提供路径详情' : '当前未使用 WebRTC';
  $('diag-peer').textContent = route ? `${endpoint(route.local)} ↔ ${endpoint(route.remote)}` : '—';
  $('diag-direct-status').textContent = views.active.transport === 'direct' && views.active.state === 'connected' ? routeStatus(route) : directIssues[views.active.issue] || '尚未检测';
  if (!owned && loggedIn && serviceProtocol === 1) {
    const service = serviceLink.state;
    $('diag-panel').textContent = service.ready ? `可访问（${rtcRouteLabel(service.route)}）` : panelState === 'online' ? '可访问（HTTPS）' : '连接中断';
    $('diag-transport').textContent = service.ready ? `${rtcRouteLabel(service.route)} · 受限服务` : 'HTTPS 中转 · 受限服务';
    $('diag-direct-status').textContent = service.ready ? routeStatus(service.route) : service.issue === 'connecting' ? '正在探测服务 WebRTC' : directIssues[service.issue] || '等待后续探测';
    $('diag-network').textContent = service.route ? `${service.route.family} / ${service.route.protocol}` : service.ready ? '浏览器尚未提供路径详情' : '当前未使用 WebRTC';
    $('diag-peer').textContent = service.route ? `${endpoint(service.route.local)} ↔ ${endpoint(service.route.remote)}` : '—';
    $('diag-input-transport').textContent = '当前账号无桌面输入权限';
  }
  const latencyActive = loggedIn && !accessExpired && !document.hidden && navigator.onLine && (!owned || views.active.state === 'connected');
  const httpsLatency = needsRelayProbe();
  const rttMs = !latencyActive ? null : !owned && serviceLink.ready ? serviceLink.rttMs : httpsLatency ? relayLatency.value : owned ? views.active.latency.value : null;
  $('diag-latency').textContent = rttMs !== null ? `${rttMs} ms` : latencyActive ? '检测中…' : '—';
  $('diag-latency').title = httpsLatency ? '浏览器与服务器之间的 HTTPS 请求往返时间，前台约每 4 秒检测。' : '浏览器与服务器之间当前数据通道的心跳往返时间，前台约每 3 秒更新。';
  $('diag-resolution').textContent = terminalMode() ? views.active.geometry ? `${views.active.geometry.cols} 列 × ${views.active.geometry.rows} 行` : '等待终端尺寸' : views.active.dimensions ? `${views.active.dimensions.width} × ${views.active.dimensions.height}${views.active.state === 'connected' ? '' : '（上次连接）'}` : '等待画面连接';
  renderInputControls();
  renderDisplayControls();
  renderDesktopSettings();
  renderClipboard();
  syncModeStandby();
  sendDisplayPreferences();
  renderConnectionTrace();
  if (!loggedIn) return;
  if (nodeMismatch) {
    overlay('入口已切换', '请保存草稿后刷新页面，连接当前节点；已发送操作不会重试。');
    $('access-refresh-button').hidden = false;
  } else if (accessExpired) {
    overlay('访问验证已过期', '刷新页面完成外层访问验证，然后返回原来的工作会话。');
    $('access-refresh-button').hidden = false;
  } else if (!navigator.onLine || panelState === 'offline') {
    if (views.active.state !== 'connected') overlay('等待网络恢复', '连接恢复后会继续原来的会话。未确认成功的输入不会自动重发。');
    else $('desktop-overlay').hidden = true;
  } else if (!owned && permissions.role === 'temporary') overlay('临时访问', '此账号仅可查看连接状态、配置服务器访问本地设备的映射，以及上传和下载共享中转文件。');
  else if (!owned && permissions.requiresUnlock) overlay('屏幕已锁定', '既有双向端口映射仍可连接；新增或管理本机 → 服务器映射需先解锁。连接状态、本地设备映射和文件中转仍可用。', true);
  else if (!owned) overlay('在这里继续工作', terminalOnly ? '终端已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启任务。' : '桌面已在另一页面打开，或服务刚刚重启。接管只切换观看位置，不会重启 Codex。', true);
  else if (terminalMode() && terminalSelectionState === 'closed') {
    overlay('已关闭', '点击下方入口新开终端，或切换到其他终端。');
    $('choose-terminal-button').textContent = '新开终端';
    $('choose-terminal-button').disabled = !canManageTerminals() || terminalCatalog.length >= maxTerminals || !!confirmation;
    $('choose-terminal-button').hidden = false;
  }
  else if (terminalMode() && ['invalid', 'error'].includes(terminalSelectionState)) {
    overlay('请选择终端', '原终端未通过身份校验，草稿仍保留。请刷新列表或手动选择目标。');
    $('choose-terminal-button').textContent = '选择终端'; $('choose-terminal-button').disabled = false;
    $('choose-terminal-button').hidden = false;
  }
  else if (terminalMode() && views.active.loaded && views.active.terminalAttachment && ['idle', 'exited', 'failed', 'expired'].includes(views.active.attachmentState)) $('desktop-overlay').hidden = true;
  else if (desktopReady === false && views.active.state !== 'connected') overlay(terminalOnly ? '终端后台未就绪' : '桌面未就绪', terminalOnly ? '正在等待终端后台。网页不会自动重启后台或重新执行任务。' : '正在等待桌面服务。网页不会自动重启桌面或重新执行任务。');
  else if ((viewportResizing || controlsState.viewportBusy || views.active.paused) && views.active.state === 'connected') $('desktop-overlay').hidden = true;
  else if (inputPaused()) overlay(label, '输入暂时暂停。当前操作完成后恢复，不会自动重发输入。');
  else if (views.active.state === 'connected') $('desktop-overlay').hidden = true;
  else overlay(label, terminalMode() ? '正在连接终端，原任务继续运行。' : '正在连接画面，桌面任务继续运行。');
}
function stopDiagnostics() {
  clearTimeout(diagnosticsTimer);
  diagnosticsController?.abort();
  diagnosticsController = null;
  $('refresh-connection').disabled = false; $('refresh-connection').textContent = '刷新状态';
}
async function loadDiagnostics() {
  if (!$('connection-dialog').open || !loggedIn || accessExpired || diagnosticsController) return;
  const controller = new AbortController();
  diagnosticsController = controller;
  $('refresh-connection').disabled = true; $('refresh-connection').textContent = '正在刷新…';
  const timeout = setTimeout(() => controller.abort(new Error('诊断响应超时，请稍后重试')), 6000);
  clearTimeout(diagnosticsTimer);
  try {
    const { tunnel, services, files } = await api('/api/diagnostics', { signal: controller.signal });
    if (diagnosticsController !== controller || !$('connection-dialog').open) return;
    $('diag-tunnel').textContent = tunnel?.available ? tunnel.connections > 0 ? `已连接 · ${tunnel.connections} 条连接` : '未建立连接' : '诊断不可用';
    $('diag-families').textContent = tunnel?.available ? `${tunnel.ipv6} / ${tunnel.ipv4}` : '—';
    $('diag-recovery').textContent = !services?.available ? '状态未知' : services.panel.limited ? '自动恢复已停止，需要检查服务' : services.panel.state !== 'active' ? '服务未就绪' : services.panel.restarts ? `已自动恢复 · ${services.panel.restarts} 次` : '正常运行';
    $('diag-services').previousElementSibling.textContent = terminalOnly ? '终端后台' : '输入与桌面执行';
    $('diag-services').textContent = !services?.available ? '状态未知' : terminalOnly ? `管理：${services.manager.state === 'active' ? '正常' : '未就绪'} / 终端：${services.terminal?.state === 'active' ? '正常' : '未就绪'}` : `输入：${services.manager.state === 'active' ? '正常' : '未就绪'} / 桌面执行：${services.actions.state === 'active' ? '正常' : '未就绪'}`;
    const fileService = services?.available ? services.files : null;
    const fileState = !fileService ? '服务状态未知' : fileService.limited ? '自动恢复已停止' : fileService.state === 'missing' ? '服务未安装' : fileService.state === 'active' ? '服务运行中' : fileService.state === 'failed' ? '服务失败' : '服务未就绪';
    $('diag-files').textContent = `${fileState} · ${files?.ready === true ? '接口正常' : files?.ready === false ? '接口未就绪' : '接口状态未知'}`;
    $('diag-note').textContent = tunnel?.available ? `更新于 ${new Date(tunnel.checkedAt).toLocaleTimeString()}；仅统计当前活动边缘连接。` : 'Tunnel 未启动、未配置或诊断接口暂不可用；这不表示桌面任务已停止。';
    $('connection-refresh-state').textContent = `节点状态更新于 ${new Date().toLocaleTimeString()} · 每 5 秒自动更新`;
  } catch (error) {
    if (diagnosticsController === controller && loggedIn) {
      $('diag-tunnel').textContent = '状态未知';
      $('diag-families').textContent = '—';
      $('diag-recovery').textContent = $('diag-services').textContent = $('diag-files').textContent = '状态未知';
      $('diag-note').textContent = error.message;
      $('connection-refresh-state').textContent = '节点状态未更新，请重试；会话连接信息仍单独更新。';
    }
  } finally {
    clearTimeout(timeout);
    if (diagnosticsController === controller) {
      diagnosticsController = null;
      $('refresh-connection').disabled = false; $('refresh-connection').textContent = '刷新状态';
      if ($('connection-dialog').open && loggedIn && !accessExpired) diagnosticsTimer = setTimeout(loadDiagnostics, 5000);
    }
  }
}
function expireAccess() {
  accessExpired = true;
  serviceLink.stop();
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
async function api(path, { method = 'GET', body, raw, signal, upload, progress, downloadSize, downloadVersion, transferId } = {}) {
  if (method !== 'GET' && (pageLeaving || cachedResumePending)) throw Object.assign(Error('正在核对返回页面的会话，本次操作未发送'), { outcome: 'rejected' });
  if (path === '/api/terminals' && method === 'POST' && body?.action === 'create' && terminalMode() && views.active.terminalCreateReady && owned && views.active.state === 'connected') {
    return framePanelRequest('create-terminal', { name: body.name, ...(body.terminalId === undefined ? {} : { terminalId: body.terminalId }) }, signal);
  }
  if (path === '/api/terminals' && method === 'POST' && body?.action === 'open' && !terminalMode() && views.active.terminalOpenReady && owned && views.active.state === 'connected') {
    return framePanelRequest('open-terminal', { terminalId: body.terminalId, terminalToken: body.terminalToken }, signal);
  }
  const service = serviceAction(path, method);
  if (!cachedResumePending && service && raw === undefined && serviceLink.ready && !serviceLink.busy && !signal?.aborted) {
    const serviceBody = service === 'files' && path.includes('?') ? { page: new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('page'), pageItems: FILE_PAGE_LIMITS.pageItems } : body || {};
    try { const value = await serviceLink.request(service, serviceBody, signal); if (path === '/api/state') panelRoute = 'service'; return value; }
    catch (error) { if (error.status === 401) showLogin('登录已过期，请重新登录'); if (method !== 'GET' || [401, 403, 423].includes(error.status) || signal?.aborted) throw error; }
  }
  if (!cachedResumePending && method === 'GET' && views.active.panelReady && owned && views.active.state === 'connected' && ['/api/state', '/api/terminals'].includes(path)) {
    const generation = uiGeneration, route = views.active.transport;
    try {
      const value = await framePanelRequest(path === '/api/state' ? 'state' : 'terminals', {}, signal);
      if (path === '/api/state') panelRoute = route;
      return value;
    } catch (error) {
      // Only these read-only operations may fall back once. Keep the caller's
      // deadline and never carry a read across logout, cancellation or denial.
      if (signal?.aborted || generation !== uiGeneration || !loggedIn || !owned || accessExpired) throw error;
      if (error.status === 401) showLogin('登录已过期，请重新登录');
      if (error.code === 'node_changed' || [401, 403, 423].includes(error.status)) throw error;
    }
  }
  const headers = { 'x-viewer-id': viewer, ...nodeHeaders() };
  if (service === 'files' && path.includes('?')) headers['x-codex-file-page-items'] = String(FILE_PAGE_LIMITS.pageItems);
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (upload !== undefined) Object.assign(headers, uploadHeaders(upload));
  if (transferId) headers['x-codex-transfer-id'] = transferId;
  const operation = path === '/api/state' ? 'state' : path === '/api/terminals' ? 'terminals' : path.startsWith('/api/files') ? 'files' : path.startsWith('/api/forward') ? 'forward' : /^\/api\/(?:paste|edit|key|terminal)$/.test(path) ? 'input' : path.startsWith('/api/desktop') ? 'desktop' : 'other';
  const requestMode = displayPreferences.mode, requestView = views.active.epoch, requestAt = performance.now();
  let response;
  try { response = await fetch(entryPath(path), { method, credentials: 'same-origin', headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual', signal }); }
  catch (error) {
    if (!signal?.aborted && connectionTrace.enabled) {
      const previous = connectionRequestFaults.get(operation);
      const at = performance.now(), report = !previous || previous.status !== 0 || at - previous.at >= 15000;
      if (report) recordConnection('request-failed', { operation, reason: 'network', durationMs: Math.round(at - requestAt) }, requestMode, false, requestView);
      connectionRequestFaults.set(operation, { status: 0, at: report ? at : previous.at });
    }
    throw error;
  }
  if (connectionTrace.enabled && !response.ok && (loggedIn || response.status !== 401)) {
    const previous = connectionRequestFaults.get(operation), at = performance.now();
    const report = !previous || previous.status !== response.status || at - previous.at >= 15000;
    if (report) recordConnection('request-failed', { operation, status: response.status, reason: response.type === 'opaqueredirect' || [401, 403, 423].includes(response.status) ? 'auth' : undefined, durationMs: Math.round(at - requestAt) }, requestMode, false, requestView);
    connectionRequestFaults.set(operation, { status: response.status, at: report ? at : previous.at });
  } else if (response.ok && connectionRequestFaults.delete(operation)) recordConnection('request-recovered', { operation, status: response.status, durationMs: Math.round(performance.now() - requestAt) }, requestMode, false, requestView);
  if (response.type === 'opaqueredirect') {
    if (!signal?.aborted) expireAccess();
    throw new Error('外层访问验证已过期，请刷新页面完成验证');
  }
  const invalidResponse = () => Object.assign(new Error('服务响应不完整，请刷新状态确认结果'), { status: response.status, outcome: 'unknown', code: 'invalid_response' });
  if (response.ok && method === 'PUT' && raw instanceof Blob && !signal?.aborted) progress?.(raw.size, raw.size);
  if (downloadSize !== undefined && response.ok) return readFileDownload(response, downloadSize, signal, progress, downloadVersion);
  const data = await response.json().catch(error => {
    if (signal?.aborted) throw signal.reason || error;
    if (response.ok) throw invalidResponse();
    return {};
  });
  if (!signal?.aborted && response.status === 401 && path !== '/api/login') showLogin(loggedIn ? '登录已过期，请重新登录' : '');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse();
  if (data.code === 'node_changed') {
    nodeMismatch = accessExpired = true; owned = false; serviceLink.stop(); stopPolling(); stopFrame(); stopDiagnostics(); renderConnection();
  }
  if (!response.ok) {
    if (!signal?.aborted && data.access) updateAccess(data.access);
    const error = new Error(data.error || `请求失败（${response.status}）`); error.outcome = data.outcome || (method !== 'GET' && response.status >= 500 ? 'unknown' : undefined); error.status = response.status; error.code = data.code;
    if (['file_busy', 'file_exists'].includes(data.fileCode)) error.fileCode = data.fileCode;
    throw error;
  }
  if (path === '/api/state' && !signal?.aborted) panelRoute = 'https';
  return data;
}
function cacheRTC(value) {
  if (typeof value?.webrtc === 'boolean' && typeof value.rtcStunUrl === 'string' && value.rtcStunUrl.length <= 256) rtcConfig = { webrtc: value.webrtc, rtcStunUrl: value.rtcStunUrl, rtcIceServers: rtcIceServers(value), rtcIceExpiresAt: Number.isSafeInteger(value.rtcIceExpiresAt) ? value.rtcIceExpiresAt : undefined };
}
function finishPanelRequest(id, error, value) {
  const pending = panelRequests.get(id); if (!pending) return;
  panelRequests.delete(id); clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
  error ? pending.reject(error) : pending.resolve(value);
}
function framePanelRequest(action, body = {}, signal) {
  const capable = action === 'switch-terminal' ? views.active.terminalSwitchReady : action === 'create-terminal' ? views.active.terminalCreateReady : action === 'open-terminal' ? views.active.terminalOpenReady : views.active.panelReady;
  if (!['state', 'terminals', 'switch-terminal', 'create-terminal', 'open-terminal'].includes(action) || !capable || !owned || !views.active.loaded || signal?.aborted || [...panelRequests.values()].some(p => p.action === action) || panelSequence >= 2147483647) return Promise.reject(Object.assign(new Error('连接操作未就绪或仍在处理'), { status: 409, outcome: 'rejected' }));
  return new Promise((resolve, reject) => {
    const id = ++panelSequence, abort = () => {
      $('desktop-frame').contentWindow.postMessage({ type: 'codex-panel-cancel', frame: String(views.active.epoch), id }, location.origin);
      finishPanelRequest(id, signal?.reason || Object.assign(new Error('连接操作已取消或结果未知'), { status: 409, outcome: ['switch-terminal', 'create-terminal', 'open-terminal'].includes(action) ? 'unknown' : 'rejected' }));
    };
    panelRequests.set(id, { action, resolve, reject, signal, abort, timer: setTimeout(abort, action === 'switch-terminal' ? 11000 : ['create-terminal', 'open-terminal'].includes(action) ? 6500 : 6000) });
    signal?.addEventListener('abort', abort, { once: true });
    $('desktop-frame').contentWindow.postMessage({ type: 'codex-panel-request', frame: String(views.active.epoch), id, action, body }, location.origin);
  });
}
function resetPanelRequests({ preserveView = false } = {}) {
  if (!preserveView) views.invalidate();
  for (const id of [...panelRequests.keys()]) finishPanelRequest(id, Object.assign(new Error('查看连接已变化'), { status: 409, outcome: 'unknown' }));
}
async function switchTerminalStream(identity) {
  const entry = views.active, expectedFrame = entry.epoch, generation = uiGeneration, key = `${identity.id}:${identity.token}`;
  if (!views.requestTarget(entry, key)) return false;
  // Attaching temporarily hides the retained route's read capability. Do not
  // introduce an HTTPS dependency while that same connection is still alive.
  stopPolling();
  historyToolsPortal.reset(); terminalBusy = terminalSwitching = true; shortcutMenu.close(); renderConnection();
  try {
    const target = await framePanelRequest('switch-terminal', { terminalId: identity.id, terminalToken: identity.token });
    if (views.active.epoch !== expectedFrame || generation !== uiGeneration || !owned) return;
    if (target?.terminalId !== identity.id || target?.terminalToken !== identity.token || !activateTerminal(identity)) throw Object.assign(new Error('切换后目标未确认，请重新选择终端；草稿已保留'), { outcome: 'unknown' });
    if (!views.confirmTarget(entry, key)) throw Object.assign(new Error('终端目标已变化，切换结果待确认'), { outcome: 'unknown' });
    renderTerminalList();
    const deadline = performance.now() + 8000;
    while (views.active.epoch === expectedFrame && owned && (views.active.state !== 'connected' || !views.active.terminalSwitchReady) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (views.active.epoch === expectedFrame && owned && (views.active.state !== 'connected' || !views.active.terminalSwitchReady)) throw Object.assign(new Error('终端附加未完成，请重新选择目标'), { outcome: 'unknown' });
    return true;
  } catch (error) {
    if (views.active.epoch !== expectedFrame || generation !== uiGeneration || !owned) return;
    if (error.outcome === 'rejected' && views.active.key !== `${selectedTerminal}:${selectedTerminalToken}`) {
      const previous = terminalCatalog.find(item => item.supported && `${item.id}:${item.token}` === views.active.key);
      if (!previous || !activateTerminal({ id: previous.id, token: previous.token })) { terminalSelectionState = 'error'; stopFrame(); }
      renderTerminalList();
    } else if (error.outcome !== 'rejected') { terminalSelectionState = 'error'; stopFrame(); }
    toast(error.message, error.code !== 'terminal_switch_busy' || error.outcome !== 'rejected');
    return false;
  } finally { views.cancelTarget(entry); if (generation === uiGeneration) { terminalBusy = !!terminalController; terminalSwitching = false; renderConnection(); if (loggedIn && !accessExpired && !pollController && !terminalController) { stopPolling(); void poll(); } } }
}
function overlay(title, description, takeover = false) {
  $('overlay-title').textContent = title;
  $('overlay-description').textContent = description;
  $('takeover-button').hidden = !takeover;
  $('access-refresh-button').hidden = true;
  $('choose-terminal-button').hidden = true;
  $('desktop-overlay').hidden = false;
}
function stopFrame({ keepLogout = false, replaceElement = false } = {}) {
  offerBridge.cancel(views.active);
  if (hintProbe?.phase === 'workspace') finishHintProbe();
  discardStandby();
  historyToolsPortal.reset();
  terminalController?.abort();
  terminalSwitching = false;
  shortcutMenu.close();
  if (!keepLogout || confirmation?.kind !== 'logout') closeConfirmation();
  clearTimeout(viewportTimer); viewportController?.abort(); viewportController = null; viewportResizing = false; viewportApplied = ''; views.active.nativeIdle = false; views.active.resizeReady = false;
  clearTimeout(switchTimer); views.active.paused = false;
  resetDirectControl();
  resetPanelRequests();
  const previous = views.active.element, element = replaceElement ? previous.cloneNode(false) : previous;
  if (replaceElement) { element.removeAttribute('src'); element.hidden = true; }
  views.reset(displayPreferences.mode, element);
  if (replaceElement) { previous.replaceWith(element); historyToolsPortal.setFrame(element); }
  renderDisplayControls();
  element.hidden = true;
  if (!replaceElement) element.src = 'about:blank';
}
function restrictWorkspace() {
  terminalActions.close();
  hideWorkspacePanels(); shortcutMenu.close();
  inputController?.abort(); terminalController?.abort(); settingsController?.abort(); clipboardUI?.suspend();
  for (const id of ['desktop-settings-dialog', 'terminals-dialog', 'terminal-switch-dialog']) if ($(id).open) $(id).close();
  if (confirmation && confirmation.kind !== 'logout') closeConfirmation();
  if (views.active.loaded || views.standby) stopFrame({ keepLogout: true });
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
  finishDirectControl(Object.assign(new Error('连接已变化，操作结果未知，请先查看桌面确认'), { outcome: 'unknown', code: 'input_connection_changed' }));
}
function assistantRequest(path, body, signal) {
  const action = { '/api/paste': 'paste', '/api/edit': 'edit', '/api/key': 'key', '/api/clipboard/read': 'clipboard' }[path];
  if (terminalMode() && ['paste', 'edit', 'key'].includes(action) && !controlReady) return Promise.reject(Object.assign(new Error('网页终端未就绪，本次输入未发送'), { outcome: 'rejected' }));
  if (!controlReady || !action || (terminalMode() && action === 'clipboard')) return api(path, { method: 'POST', body, signal });
  if (controlPending || signal?.aborted || controlSequence >= 2147483647) return Promise.reject(Object.assign(new Error('输入通道未就绪，本次操作未发送'), { outcome: 'rejected' }));
  return new Promise((resolve, reject) => {
    const id = ++controlSequence;
    const abort = () => {
      $('desktop-frame').contentWindow.postMessage({ type: 'codex-control-cancel', frame: String(views.active.epoch), id }, location.origin);
      finishDirectControl(Object.assign(new Error('输入操作结果未知，请先查看桌面确认'), { outcome: 'unknown' }));
    };
    controlPending = { id, resolve, reject, signal, abort, timer: setTimeout(abort, 8000) };
    signal?.addEventListener('abort', abort, { once: true });
    $('desktop-frame').contentWindow.postMessage({ type: 'codex-control-request', frame: String(views.active.epoch), id, action, body }, location.origin);
  });
}
function stopPolling() {
  clearTimeout(pollTimer); pollTimer = undefined;
  pollController?.abort();
  pollController = null;
}
function showLogin(message = '') {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  cachedResumePending = cachedViewReset = false;
  finishHintProbe();
  clearInputNotices();
  fileWorkbench?.reset();
  workspaceInitialized = false; serviceProtocol = 0; serviceLink.stop();
  rtcConfig = undefined; panelRoute = 'https';
  accessUI?.close();
  if (loggedIn) rememberDraft();
  forwardingUI?.reset();
  uiGeneration++; closeConfirmation();
  clearClipboard();
  inputController?.abort(); inputController = null; inputBusy = false; inputFeedback = false;
  controlsState = { available: false, maintenance: false, inputBusy: false };
  maintenancePending = false;
  $('input-status').hidden = true;
  loggedIn = false; owned = false; csrf = ''; transferDirectory = ''; desktopFocusFailureKey = '';
  closeDraftLeave();
  $('transfer-path').textContent = '等待读取…';
  terminalController?.abort(); terminalController = null; terminalBusy = terminalFocusBusy = false; terminalLoadAttempted = false; terminalCatalog = []; terminalSlots = []; selectedTerminal = ''; selectedTerminalToken = ''; terminalSelectionState = 'loading'; renderTerminalList();
  desktopReady = null; views.active.dimensions = null; panelState = 'auth';
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
  clearClipboard();
  if ($('terminals-dialog').open) $('terminals-dialog').close();
  if ($('terminal-switch-dialog').open) $('terminal-switch-dialog').close();
  terminalActions.close();
  renderConnection();
}
function standbyCapable() { return modeStandbyEnabled && !terminalOnly; }
function standbyEnabled() { return standbyCapable() && displayPreferences.modeStandby; }
function discardStandby() {
  const previous = views.discard(); if (!previous) return;
  offerBridge.cancel(previous);
  recordConnection('view-discarded', { path: previous.transport, reason: document.hidden ? 'hidden' : 'closed' }, previous.mode, true, previous.epoch);
  previous.element.src = 'about:blank'; previous.element.remove();
}
function standbyTarget() {
  // Preparing the main terminal must not change the input target or adopt a draft.
  return terminalCatalog.find(item => item.supported && (selectedTerminal
    ? item.id === selectedTerminal && item.token === selectedTerminalToken && terminalSelectionState === 'ready'
    : item.id === 'main'));
}
function sendStandbyPreferences() {
  const entry = views.standby; if (!entry || !owned) return;
  entry.element.contentWindow.postMessage({ type: 'codex-desktop-options', frame: String(entry.epoch), standby: true,
    // Load modules alongside the active viewer, but admit a new standby stream
    // only after the active connection. Its initial offer keeps priority.
    rtc: { ...rtcConfig, hints: directHints.value }, ...(views.active.state === 'connected' ? { csrf } : {}), zoom: displayPreferences.zoom, pan: displayPreferences.pan, networkDebug: displayPreferences.networkDebug,
    blocked: true, busy: true, revision: displayRevision, pointerMode: displayPreferences.pointerMode, scrollTarget: displayPreferences.scrollTarget,
    terminalFontSize: displayPreferences.terminalFontSize, terminalWidthMode: displayPreferences.terminalWidthMode, terminalHistoryRows: displayPreferences.terminalHistoryRows, terminalMouseReporting: displayPreferences.terminalMouseReporting }, location.origin);
}
function syncModeStandby() {
  if (!standbyEnabled() || !loggedIn || !owned || accessExpired || pageLeaving || cachedResumePending || maintenancePending || controlsState.maintenance || desktopReady !== true) return discardStandby();
  // Screen-off suspends both viewers' network work through their own visibility
  // handlers. Keep the one bounded standby context warm for foreground recovery;
  // pagehide, revoked ownership and disabling the preference still retire it.
  if (document.hidden) return;
  const mode = terminalMode() ? 'desktop' : 'terminal', target = mode === 'terminal' ? standbyTarget() : null;
  const key = target ? `${target.id}:${target.token}` : '';
  // A parked terminal can attach the next target on its retained stream when
  // foregrounded. Changing the desktop selection must not tear that stream down.
  if (views.standby && (views.standby.mode !== mode || views.standby.key !== key &&
    (!streamProtocolEnabled || terminalCatalogVerified && !terminalCatalog.some(item => item.supported && `${item.id}:${item.token}` === views.standby.key)))) discardStandby();
  if (views.standby || mode === 'terminal' && (!target || terminalBusy) || !streamProtocolEnabled && (views.active.state !== 'connected' || terminalBusy)) return;
  const element = document.createElement('iframe');
  element.id = 'standby-frame'; element.inert = true; element.setAttribute('aria-hidden', 'true'); element.tabIndex = -1;
  element.referrerPolicy = 'same-origin'; element.allow = $('desktop-frame').allow;
  element.title = mode === 'terminal' ? '待命网页终端' : '待命开发桌面';
  views.prepare(element, mode, key, mode === 'terminal' ? noticeTarget(target.id, target.token) : '');
  recordConnection('view-start', { reason: 'standby' }, mode, true, views.standby.epoch);
  element.src = frameUrl(mode, views.standby.epoch, target);
  $('desktop-stage').insertBefore(element, $('desktop-overlay'));
}
function updateView(entry, value) {
  return views.update(entry, value, { revision: displayRevision, fontSize: displayPreferences.terminalFontSize, terminalSwitching, issues: Object.keys(directIssues), probeReasons: Object.keys(TRACE_REASONS) });
}
function receiveStandby(value) {
  const entry = views.standby;
  updateView(entry, value);
  if (['codex-connection-progress', 'codex-view-first-frame'].includes(value.type)) { renderConnectionTrace(); return; }
    if (value.type === 'codex-network-event') { recordConnection(value.event?.type, value.event, entry.mode, true, entry.epoch); return; }
  if (value.type === 'codex-desktop') {
    if (value.state === 'ready') { recordConnection('view-ready', {}, entry.mode, true, entry.epoch); sendStandbyPreferences(); renderConnectionTrace(); return; }
    if (value.state === 'connected') sendStandbyPreferences();
  } else if (value.type === 'codex-stream-reset' && ['input-unknown', 'input-pressure'].includes(value.reason)) {
    const record = streamInputNotice(value, { mode: entry.mode, epoch: entry.epoch, standby: true, target: entry.noticeTarget });
    if (record && record.key !== entry.inputNoticeKey) toast(record.message, true);
    entry.inputNoticeKey = record?.key || '';
  } else if (value.type === 'codex-direct-prepare') entry.element.contentWindow.postMessage({ type: 'codex-direct-approved', frame: String(entry.epoch), id: value.id, allowed: false }, location.origin);
  // No hidden frame may change the active target, send controls, open tools,
  // approve a route handoff, or turn an old input result into a new action.
}
function swapStandby(mode) {
  const key = `${selectedTerminal}:${selectedTerminalToken}`, previous = views.active;
  if (!standbyEnabled() || document.hidden || !views.canSwap(mode, key)) return false;
  historyToolsPortal.reset();
  clearTimeout(viewportTimer); viewportController?.abort(); viewportController = null; viewportResizing = false; viewportApplied = '';
  clearTimeout(switchTimer); resetDirectControl(); resetPanelRequests({ preserveView: true });
  views.swap(mode, key, terminalMode() ? noticeTarget() : '');
  const next = views.active;
  recordConnection('view-reused', { path: next.transport, state: next.state === 'connected' ? 'connected' : 'connecting' }, mode, false, next.epoch);
  previous.element.id = 'standby-frame'; previous.element.inert = true; previous.element.tabIndex = -1; previous.element.setAttribute('aria-hidden', 'true');
  sendStandbyPreferences();
  next.element.id = 'desktop-frame'; next.element.inert = false; next.element.removeAttribute('aria-hidden'); next.element.removeAttribute('tabindex');
  next.element.title = mode === 'terminal' ? 'Codex 网页终端' : 'Ubuntu 开发桌面';
  historyToolsPortal.setFrame(next.element);
  const notice = inputNotices.snapshot().find(record => record.key === next.inputNoticeKey);
  if (notice) { inputNotices.activate(notice.key); inputMessage('unknown', notice.message); }
  return true;
}
function frameUrl(mode = displayPreferences.mode, epoch = views.active.epoch, terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported)) {
  const query = new URLSearchParams({ viewer, frame: String(epoch) });
  if (displayPreferences.networkDebug) query.set('networkDebug', '1');
  if (nodeIdentity()) query.set('node', nodeIdentity());
  const ui = document.querySelector('meta[name="ui-revision"]')?.content; if (ui) query.set('ui', ui);
  if (fastConnectEnabled) query.set('fast', '1');
  if (streamProtocolEnabled) query.set('stream', '1');
  // Negotiate the bounded two-mode capability once. The browser preference
  // only controls whether the other viewer is retained, not this stream's ID.
  if (standbyCapable()) query.set('standby', '1');
  if (mode === 'terminal') {
    query.set('terminalId', terminal.id); query.set('terminalToken', terminal.token);
    return entryPath(`/terminal/index.html?${query}`);
  }
  return entryPath(`/desktop/index.html?${query}`);
}
function openFrame() {
  if (views.active.loaded || !owned || pageLeaving || cachedResumePending) return;
  if (terminalMode()) {
    if (terminalSelectionState !== 'ready') return;
    const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
    if (!terminal || terminal.token !== selectedTerminalToken) return;
  }
  views.begin(displayPreferences.mode, terminalMode() ? `${selectedTerminal}:${selectedTerminalToken}` : '');
  recordConnection('view-start', {}, displayPreferences.mode);
  $('desktop-frame').src = frameUrl();
  $('desktop-frame').title = terminalMode() ? 'Codex 网页终端' : 'Ubuntu 开发桌面';
  $('desktop-frame').hidden = false;
  renderConnection();
}
async function poll() {
  if (!loggedIn || accessExpired || pageLeaving || pollController || terminalSwitching) return;
  const controller = new AbortController();
  pollController = controller;
  const timeout = setTimeout(() => controller.abort(new Error('网络响应超时，请稍后重试')), 8000);
  clearTimeout(pollTimer);
  try {
    const state = await api('/api/state', { signal: controller.signal });
    if (!loggedIn || pollController !== controller) return;
    // Cached returns use HTTPS until authentication, node scope and ownership
    // have been checked. No viewer or service capability can bypass this gate.
    if (cachedResumePending) {
      if (typeof state.mine !== 'boolean' || typeof state.desktop?.ready !== 'boolean' || typeof state.controls?.available !== 'boolean') throw Error('会话状态响应不完整，输入继续暂停');
      cachedResumePending = false; workspaceInitialized = true;
    }
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
    cacheRTC(state.rtc);
    panelState = 'online';
    desktopReady = state.desktop.ready === true;
    controlsState = state.controls || { available: false, maintenance: false, inputBusy: false };
    scheduleViewport();
    // Restore pre-existing helper feedback once. Later local attempts report
    // their own results; a mode change must not reclassify them as new history.
    // If an inherited operation is running, wait for its final status first.
    if (!inputHistoryChecked && !inputBusy && controlsState.available && controlsState.input?.status !== 'running') {
      inputHistoryChecked = true;
      if (!inputFeedback && controlsState.input?.status === 'unknown') inputMessage('unknown', '上一项输入结果未知，请先查看桌面确认，避免重复执行。',
        { key: `history:${controlsState.input.id}`, source: 'history', action: controlsState.input.action, reason: 'previous' });
    }
    $('version-label').textContent = state.desktop.version;
    transferDirectory = typeof state.desktop.transferDir === 'string' ? state.desktop.transferDir : '';
    $('transfer-path').textContent = transferDirectory || '共享目录暂不可用';
    renderFileControls();
    if (!mine) {
      restrictWorkspace();
    } else if (state.desktop.ready) openFrame();
    if (mine && state.desktop.ready && !terminalLoadAttempted) { terminalLoadAttempted = true; void loadTerminals(); }
    renderConnection();
  } catch (error) {
    if (loggedIn && pollController === controller) {
      if (!(views.active.transport === 'direct' && views.active.panelReady && [409, 429].includes(error.status))) panelState = 'offline';
      renderConnection();
    }
  } finally {
    clearTimeout(timeout);
    if (pollController === controller) {
      pollController = null;
      if (loggedIn && !accessExpired && !pageLeaving) pollTimer = setTimeout(poll, controlsState.maintenance || controlsState.inputBusy || controlsState.clipboardBusy || controlsState.viewportBusy || maintenancePending ? 800 : 4000);
    }
  }
}
async function claim(lockPassword, signal = AbortSignal.timeout(8000)) {
  const generation = uiGeneration;
  if (!permissions.canClaim) return;
  if (permissions.requiresUnlock && !lockPassword) { accessUI?.unlock(); return; }
  const restore = !owned;
  const result = await api('/api/desktop/claim', { method: 'POST', body: { viewer, ...(lockPassword ? { lockPassword } : {}) }, signal });
  if (!loggedIn || generation !== uiGeneration || pageLeaving) return;
  if (result.access) permissions = { ...permissions, ...result.access };
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
  cachedResumePending = cachedViewReset = false;
  clearInputNotices();
  workspaceInitialized = false; serviceProtocol = user.serviceProtocol === 1 ? 1 : 0;
  uiGeneration++; closeConfirmation();
  maxTerminals = DEFAULT_TERMINAL_LIMIT;
  loggedIn = true; csrf = user.csrf; fastConnectEnabled = user.fastConnect === true; streamProtocolEnabled = user.streamProtocol === 1; modeStandbyEnabled = user.modeStandby === 1;
  rtcConfig = undefined; cacheRTC(user);
  if (user.access) permissions = { ...permissions, ...user.access };
  terminalOnly = user.mode === 'terminal';
  if (terminalOnly) displayPreferences.mode = 'terminal';
  renderDisplayControls();
  accessExpired = false; panelState = 'online'; desktopReady = null;
  if (permissions.canClaim && !permissions.requiresUnlock) initializeTerminalSelection();
  else { selectedTerminal = ''; selectedTerminalToken = ''; terminalCatalog = []; terminalSlots = []; $('mobile-input').value = ''; }
  $('user-label').textContent = user.username + (permissions.role === 'temporary' ? ' · 临时访问' : '') + (nodeIdentity() ? ' · 节点 ' + nodeIdentity().slice(0, 8) : '');
  $('user-label').title = $('user-label').textContent;
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
  workspaceInitialized = true; renderConnection();
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
  if (pending.epoch !== views.active.epoch || pending.frameState !== views.active.state || pending.owned !== owned) return false;
  if (pending.kind === 'mode') return !document.hidden && pending.body?.from === displayPreferences.mode && ['desktop', 'terminal'].includes(pending.body.mode) && pending.body.mode !== displayPreferences.mode && !modeChangeBusy();
  const focused = pending.destination?.target === 'focused';
  if (focused && terminalMode()) return false;
  if (pending.destination && !focused && JSON.stringify(pending.destination) !== JSON.stringify(inputDestination(false))) return false;
  if (['terminal-open', 'terminal-close'].includes(pending.kind) && !terminalCatalog.some(item => item.id === pending.body?.terminalId && item.token === pending.body.terminalToken && item.supported)) return false;
  if (['terminal-open', 'terminal-create', 'terminal-close'].includes(pending.kind)) return canManageTerminals() && !inputComposing && !views.active.composing;
  return pending.kind === 'reconnect' ? panelState === 'online' && navigator.onLine && !maintenancePending && !controlsState.maintenance : !inputBusy && canInput(focused);
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
  const pending = { kind, key: shortcut?.key, generation: uiGeneration, epoch: views.active.epoch, frameState: views.active.state, owned,
    destination: ['interrupt', 'shortcut'].includes(kind) ? body?.target === 'focused' && !terminalMode() ? { target: 'focused' } : inputDestination(false) : null, body: body ? { ...body } : null };
  if (!confirmationValid(pending)) return;
  const copy = {
    logout: ['退出当前登录？', '退出后需要重新登录。远程桌面和正在运行的任务会继续保留。', '确认退出'],
    terminal: ['打开远程终端？', '将打开或切换到已有终端，改变当前桌面的窗口焦点。原有任务继续运行。', '确认打开终端'],
    reconnect: [terminalMode() ? '重新连接终端？' : '重新连接桌面画面？', terminalMode() ? '将重新建立当前终端连接，必要时接管到这里。原任务和草稿保留，已发送的输入不会重发。' : '将重新建立当前观看连接；如果桌面在其他页面打开，会接管到这里。远程桌面和任务继续运行。', '确认重新连接'],
    interrupt: ['中断当前任务？', '将发送 Ctrl+C，可能终止当前正在执行的命令。请确认你确实需要中断。', '发送 Ctrl+C'],
    shortcut: shortcut ? [`发送 ${shortcut.key}？`, shortcut.description, `发送 ${shortcut.key}`] : null,
    'terminal-create': [terminalOnly ? '新建终端？' : '新建辅助终端？', `将创建并打开“${body?.name}”，原有任务继续运行。`, '确认新建'],
    'terminal-open': ['切换远程终端？', '将打开或切换到所选终端，并将输入助手的目标设为该终端。原有任务继续运行。', '确认切换'],
    'terminal-close': ['结束这个终端？', `将结束“${terminalCatalog.find(item => item.id === body?.terminalId)?.name || '所选终端'}”会话及其前台任务，无法恢复。其他终端继续运行。原位置可新开 shell，旧草稿会保留。`, '确认结束终端'],
    'drafts-clear': ['清理已结束终端的旧草稿？', '仅清理身份已失效且当前未在编辑的终端草稿。当前草稿和仍可用终端的草稿会保留。', '确认清理草稿'],
    mode: [`切换到${body?.mode === 'terminal' ? '网页终端' : '桌面'}？`, '切换显示视图，连接按需建立或复用。当前任务继续运行，输入草稿会保留，已发送的输入不会重发。', '确认切换'],
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
  if (pending.kind === 'logout') return leaveWorkspace('logout');
  if (pending.kind === 'reconnect') return void action($('reconnect-button'), claim);
  if (pending.kind === 'drafts-clear') { terminalState.clearStale(terminalCatalog, draftIdentity); draftNotice = ''; renderTerminalSelection(); return; }
  if (pending.kind === 'terminal') return void inputAction('/api/terminal', {}, '打开终端', '已打开终端，连接原有 tmux 会话');
  if (pending.kind === 'mode') return changeMode(pending.body.mode);
  if (['terminal-create', 'terminal-open', 'terminal-close'].includes(pending.kind)) return void manageTerminals(pending.kind === 'terminal-close' ? { ...pending.body, confirm: true } : pending.body);
  if (pending.kind === 'interrupt') void inputAction('/api/key', { key: 'Ctrl+C', ...pending.destination }, '发送中断', 'Ctrl C 已发送', pending.destination);
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
function inputMessage(outcome, message, notice) {
  if (outcome === 'unknown' && notice) addInputNotice(notice);
  inputFeedback = true;
  $('input-status').hidden = false;
  $('input-status').dataset.outcome = outcome;
  $('input-status').textContent = message;
  renderConnectionNotice();
}
async function inputAction(path, body, label, success, destination) {
  const focused = !terminalMode() && body?.target === 'focused';
  if (inputBusy || inputComposing || views.active.composing || !canInput(focused)) return { outcome: 'rejected' };
  if (['/api/key', '/api/paste', '/api/edit'].includes(path)) {
    try { body = { ...body, ...(destination || inputDestination()) }; }
    catch (error) { inputMessage('rejected', error.message); return { outcome: 'rejected' }; }
  }
  const controller = new AbortController(); inputController = controller;
  const notice = { key: `assistant:${++inputNoticeSequence}`, source: 'assistant', mode: displayPreferences.mode, target: focused ? '' : noticeTarget(),
    action: ['/api/paste', '/api/edit'].includes(path) ? 'paste' : path === '/api/key' ? 'key' : 'terminal', keyName: body.key,
    path: controlReady && ['/api/paste', '/api/edit', '/api/key'].includes(path) ? views.active.transport === 'direct' ? 'direct' : 'terminal' : 'https' };
  const timeout = setTimeout(() => controller.abort(), 8000);
  inputBusy = true;
  inputMessage('pending', `正在${label}…`);
  renderInputControls();
  renderDesktopSettings();
  try {
    const result = await assistantRequest(path, body, controller.signal);
    if (inputController !== controller) return;
    if (result.outcome !== 'success') throw new Error('missing input result');
    if (desktopTextInput) controlsState.inputBusy = false;
    inputMessage('success', success);
    return result;
  } catch (error) {
    if (inputController === controller) inputMessage(error.outcome === 'rejected' ? 'rejected' : 'unknown', error.outcome === 'rejected' ? `未发送：${error.message}` : `${label}结果未知，请先查看桌面确认，避免重复执行。`,
      { ...notice, reason: controller.signal.aborted ? 'timeout' : error.code === 'invalid_response' ? 'invalid_response' : error.code === 'input_connection_changed' ? 'connection' : 'result' });
    return { outcome: error.outcome === 'rejected' ? 'rejected' : 'unknown' };
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
  for (const terminal of terminalEntries()) {
    const label = terminal.available ? '＋ 新开终端' : `${terminal.name}${terminal.supported ? '' : '（布局不支持）'}`;
    const option = new Option(label, terminal.id); option.disabled = !terminal.supported; select.add(option);
    const viewOption = new Option(label, terminal.id); viewOption.disabled = !terminal.supported; viewSelect.add(viewOption);
  }
  const invalid = ['invalid', 'error'].includes(terminalSelectionState);
  if (selectedTerminal && invalid) {
    select.add(new Option('原目标已失效，请重新选择', 'stale'));
    viewSelect.add(new Option('原目标已失效，请重新选择', 'stale'));
  }
  const selection = selectedTerminal && invalid ? 'stale' : terminalSelectionState === 'closed' ? 'new' : selectedTerminal;
  select.value = viewSelect.value = selection;
  $('terminal-target-note').textContent = terminalSelectionState === 'closed' ? '终端已关闭，草稿保留；点击末尾“新开终端”可创建 shell。' : terminalMode() ? '输入直接发送到当前网页终端；粘贴与 Enter 提交分开。' : selectedTerminal ? '按键和粘贴发送前会切换到所选终端；关闭的窗口需先重新打开。' : '发送到桌面当前获得焦点的位置。';
  if (selectedTerminal) $('paste-target').value = 'terminal';
  const terminalCapacityFull = terminalCatalog.length >= maxTerminals;
  $('terminals-summary').textContent = terminalCapacityFull ? '终端名额已满' : `还可新建 ${maxTerminals - terminalCatalog.length} 个终端`;
  $('create-terminal-form').dataset.full = String(terminalCapacityFull);
  $('terminal-create-help').textContent = terminalCatalog.length >= maxTerminals ? '终端名额已满，结束不用的终端后可再新建。' : '新建后自动切换到该终端。';
  $('terminal-empty').hidden = terminalCatalog.length > 0 || !terminalCatalogVerified;
  const list = $('terminal-list'); list.replaceChildren();
  for (const terminal of terminalCatalog) {
    const row = document.createElement('div'); row.className = 'terminal-row'; row.dataset.terminal = terminal.id; row.dataset.supported = String(terminal.supported);
    const heading = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p'), actions = document.createElement('div');
    heading.className = 'terminal-row-heading'; actions.className = 'terminal-row-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `${terminal.name} 的操作`);
    title.textContent = terminal.name; detail.className = 'muted'; detail.textContent = terminal.supported ? `${terminal.primary ? '主终端' : '辅助终端'} · ${terminal.command || '运行中'}` : '包含多个窗格或布局无法识别';
    heading.append(title);
    const current = terminal.supported && terminalSelectionState === 'ready' && terminal.id === selectedTerminal && terminal.token === selectedTerminalToken;
    row.dataset.current = String(current);
    if (current) { const badge = document.createElement('span'); badge.className = 'terminal-current'; badge.textContent = terminalMode() ? '当前终端' : '输入目标'; heading.append(badge); }
    const editor = document.createElement('form'), input = document.createElement('input'), edit = document.createElement('button'), rename = document.createElement('button'), cancel = document.createElement('button'), open = document.createElement('button'), close = document.createElement('button');
    editor.className = 'terminal-rename-inline'; editor.id = `terminal-edit-${terminal.id}`; editor.hidden = true;
    input.value = terminal.name; input.maxLength = 24; input.required = true; input.autocomplete = 'off'; input.setAttribute('aria-label', `${terminal.id} 终端名称`);
    edit.type = cancel.type = open.type = close.type = 'button'; rename.type = 'submit';
    edit.textContent = '重命名'; rename.textContent = '保存名称'; cancel.textContent = '取消'; open.textContent = '打开 / 切换';
    edit.className = cancel.className = 'secondary'; rename.className = open.className = 'primary';
    edit.setAttribute('aria-expanded', 'false'); edit.setAttribute('aria-controls', editor.id);
    const target = { terminalId: terminal.id, terminalToken: terminal.token };
    edit.addEventListener('click', () => { if (!canManageTerminals() || !terminal.supported) return; editor.hidden = false; edit.setAttribute('aria-expanded', 'true'); input.focus(); input.select(); });
    cancel.addEventListener('click', () => { editor.hidden = true; input.value = terminal.name; edit.setAttribute('aria-expanded', 'false'); edit.focus(); });
    let composing = false;
    editor.addEventListener('submit', async event => {
      event.preventDefault(); if (!terminal.supported || composing) return;
      const result = await manageTerminals({ action: 'rename', ...target, name: input.value });
      if (result?.ok && $('terminals-dialog').open) list.querySelector(`[aria-controls="${editor.id}"]`)?.focus();
    });
    input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; });
    editor.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
      if (event.key === 'Escape' && !composing) { event.preventDefault(); event.stopPropagation(); cancel.click(); }
    });
    open.addEventListener('click', () => { if (terminal.supported) requestConfirmation('terminal-open', null, { action: 'open', ...target }); });
    close.className = 'quiet terminal-close'; close.textContent = '结束终端';
    close.addEventListener('click', () => { if (terminal.supported) requestConfirmation('terminal-close', null, { action: 'close', ...target }); });
    editor.append(input, rename, cancel); actions.append(open, edit, close);
    row.append(heading, detail, actions, editor); list.append(row);
  }
  renderInputControls();
}
function updateTerminalCatalog(result, opened) {
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > TERMINAL_CAPACITY || !Array.isArray(result.terminals) || result.terminals.length > TERMINAL_CAPACITY || result.terminals.some(item =>
    !TERMINAL_IDS.includes(item?.id) || typeof item.supported !== 'boolean' ||
    (item.supported ? !validTerminalIdentity(item) : item.token !== null) || typeof item.name !== 'string' || item.name.length > 96
  ) || new Set(result.terminals.map(item => item.id)).size !== result.terminals.length) throw new Error('终端列表格式无效，请手动刷新');
  if (result.slots !== undefined && (!Array.isArray(result.slots) || result.slots.length !== result.limit || result.slots.some((item, i) => item?.id !== TERMINAL_IDS[i] || typeof item.name !== 'string' || !item.name || item.name.length > 96))) throw new Error('终端位置格式无效，请手动刷新');
  terminalCatalog = result.terminals;
  terminalSlots = result.slots || [];
  maxTerminals = result.limit;
  terminalCatalogVerified = true;
  reconcileTerminalSelection(opened);
}
async function terminalRequest(body, { waitForView = false } = {}) {
  waitForView = waitForView && body?.action === 'open' && !terminalMode();
  if (!loggedIn || terminalBusy || (body && !canManageTerminals(waitForView))) return;
  if (body?.action === 'close' && !rememberDraft()) return;
  const closingCurrent = body?.action === 'close' && body.terminalId === selectedTerminal && body.terminalToken === selectedTerminalToken;
  const retainClosing = closingCurrent && terminalMode() && views.active.loaded && views.active.terminalAttachment;
  if (closingCurrent) {
    if (terminalMode() && !retainClosing) stopFrame();
    terminalSelectionState = 'loading';
  }
  const controller = new AbortController(), generation = uiGeneration, expectedFrame = views.active.epoch;
  if (body && terminalMode()) body = { ...body, view: 'terminal' };
  terminalController = controller; terminalBusy = true; terminalFocusBusy = body?.action === 'open' && !terminalMode(); shortcutMenu.close();
  const timeout = setTimeout(() => controller.abort(), 6500);
  $('terminals-status').textContent = body ? '正在处理终端操作…' : '正在读取终端列表…'; renderInputControls(); sendDisplayPreferences();
  try {
    if (waitForView) {
      // One admitted navigation, no command sent yet. Reuse the existing
      // request's cancellation and deadline; never queue or replay a focus.
      const deadline = performance.now() + 1500;
      const current = () => generation === uiGeneration && terminalController === controller && views.active.epoch === expectedFrame && loggedIn && owned && !accessExpired && !document.hidden && !pageLeaving && navigator.onLine && !terminalMode() && !controller.signal.aborted;
      while (current() && (inputPaused() || views.active.state !== 'connected' || !views.active.panelCapabilitiesKnown) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (!current() || inputPaused() || views.active.state !== 'connected' || !views.active.panelCapabilitiesKnown) throw Object.assign(Error('桌面待命连接尚未就绪，打开未发送；请稍后重新点击目标标签'), { outcome: 'rejected' });
    }
    const result = await api('/api/terminals', { method: body ? 'POST' : 'GET', body, signal: controller.signal });
    if (terminalController !== controller || generation !== uiGeneration || !loggedIn || (body && !owned)) return;
    if (body?.action === 'close' && result.closed !== body.terminalId) throw new Error('结束结果无效，请手动刷新');
    if (body?.action === 'open' && (result.opened !== body.terminalId || !result.terminals?.some(item => item.id === body.terminalId && item.token === body.terminalToken && item.supported))) throw new Error('切换结果未确认，请刷新列表核对；不会重复打开。');
    if (body?.action === 'rename' && !result.terminals?.some(item => item.id === body.terminalId && item.token === body.terminalToken && item.name === body.name.trim())) throw new Error('名称保存未确认，请刷新列表核对。');
    const retainConnection = body?.action === 'create' && terminalMode() && views.active.loaded && views.active.terminalSwitchReady;
    if (body?.action === 'create' && (result.created !== result.opened || body.terminalId !== undefined && result.created !== body.terminalId || !result.terminals?.some(item => item.id === result.created && item.supported))) throw new Error('创建结果未确认，请刷新列表核对，不要重复新建。');
    updateTerminalCatalog(result, retainConnection ? undefined : body ? result.opened : undefined);
    if (body?.action === 'open') desktopFocusFailureKey = '';
    clearTimeout(timeout);
    if (body?.action === 'create') $('new-terminal-name').value = '';
    $('terminals-status').textContent = `${body ? '终端操作已完成。' : ''}共 ${terminalCatalog.length} / ${maxTerminals} 个终端。`;
    renderTerminalList();
    if (retainConnection) {
      const created = terminalCatalog.find(item => item.id === result.created);
      if (views.active.loaded && views.active.terminalSwitchReady) {
        const attached = await switchTerminalStream({ id: created.id, token: created.token });
        if (!attached && terminalController === controller && generation === uiGeneration) $('terminals-status').textContent = '终端已创建，查看切换未完成；请选择已有终端，不要重复新建。';
      } else activateTerminal({ id: created.id, token: created.token });
    }
    return { ok: true };
  } catch (error) {
    if (terminalController === controller && generation === uiGeneration) {
      $('terminals-status').textContent = body && error.outcome !== 'rejected' ? '操作结果未知，请手动刷新列表确认；不会自动重试。' : error.message;
      if (closingCurrent) {
        // The rejected target may have exited or been replaced. Neither an
        // automatic reconnect nor manual selection may trust the old catalog.
        terminalSelectionState = 'error'; terminalCatalogVerified = false;
        terminalCatalog = []; terminalSlots = [];
        if (error.outcome === 'rejected' && owned && !controller.signal.aborted) {
          $('terminals-status').textContent = '关闭未执行，正在核对最新终端列表…';
          renderTerminalList(); renderConnection();
          try {
            // One read, sharing this operation's deadline; never repeat close.
            const latest = await api('/api/terminals', { signal: controller.signal });
            if (terminalController !== controller || generation !== uiGeneration || !loggedIn || !owned || controller.signal.aborted) return;
            updateTerminalCatalog(latest);
            $('terminals-status').textContent = terminalSelectionState === 'closed' ? '原终端已结束，草稿已保留。'
              : terminalSelectionState === 'ready' ? `未结束：${error.message}` : '终端身份或布局已变化，草稿已保留；请手动选择目标。';
          } catch {
            if (terminalController !== controller || generation !== uiGeneration || !loggedIn || !owned) return;
            $('terminals-status').textContent = '关闭未执行，列表核对失败；草稿已保留，请手动刷新终端列表。';
          }
        }
      } else if (!body && terminalSelectionState === 'loading') terminalSelectionState = 'error';
      if (closingCurrent) renderTerminalList();
      if (body && !$('terminals-dialog').open && !$('terminal-rename-dialog').open) toast($('terminals-status').textContent, true);
    }
    return { ok: false, message: $('terminals-status').textContent, outcome: body && error.outcome !== 'rejected' ? 'unknown' : 'rejected' };
  } finally {
    clearTimeout(timeout);
    if (terminalController === controller) { terminalController = null; terminalBusy = terminalFocusBusy = false; renderInputControls(); sendDisplayPreferences(); scheduleViewport(); if (terminalMode()) syncTerminalView(); renderConnection(); if (loggedIn && !accessExpired && !pollController && !pollTimer) void poll(); }
  }
}
async function loadTerminals() { return terminalRequest(); }
async function manageTerminals(body, options) { return terminalRequest(body, options); }
$('terminals-button').addEventListener('click', openTerminalManager);
$('terminal-view-manage').addEventListener('click', openTerminalManager);
$('close-terminals').addEventListener('click', () => $('terminals-dialog').close());
$('terminals-dialog').addEventListener('close', () => { sendDisplayPreferences(); scheduleViewport(); });
$('refresh-terminals').addEventListener('click', () => void loadTerminals());
$('terminal-switch-refresh').addEventListener('click', () => void loadTerminals());
$('terminal-switch-dialog').addEventListener('close', () => { sendDisplayPreferences(); scheduleViewport(); });
$('terminal-switch-dialog').addEventListener('toggle', () => sendDisplayPreferences());
$('choose-terminal-button').addEventListener('click', () => {
  if (terminalSelectionState === 'closed') selectTerminal('new');
  else { $('terminal-switch-dialog').showModal(); sendDisplayPreferences(); }
});
$('clear-stale-drafts').addEventListener('click', () => requestConfirmation('drafts-clear'));
$('create-terminal-form').addEventListener('submit', event => { event.preventDefault(); if (canManageTerminals()) requestConfirmation('terminal-create', null, { action: 'create', name: $('new-terminal-name').value }); });
$('input-terminal').addEventListener('change', () => selectTerminal($('input-terminal').value));
function syncTerminalView(explicit = false) {
  if (!terminalMode() || !loggedIn || !owned || terminalSelectionState !== 'ready') return;
  const terminal = terminalCatalog.find(item => item.id === selectedTerminal && item.supported);
  if (!terminal || terminal.token !== selectedTerminalToken) return;
  if (views.active.loaded && views.active.key === `${terminal.id}:${terminal.token}` && (!explicit || !views.active.terminalAttachment || views.active.attachmentState === 'ready')) return;
  // The catalog can arrive after the other mode's modules have warmed. There
  // is no old terminal to retire on first open, so preserve that standby frame.
  if (!views.active.loaded) { openFrame(); return; }
  stopFrame(); openFrame(); renderConnection();
}
function modeChangeBusy() {
  return pageLeaving || cachedResumePending || !owned || inputBusy || inputComposing || views.active.composing || terminalBusy || settingsBusy || maintenancePending || controlsState.maintenance || views.active.paused || viewportResizing || controlsState.viewportBusy || !!clipboardUI?.busy || !!controlPending || controlsState.inputBusy || controlsState.clipboardBusy || !!accessUI?.blocking;
}
function changeMode(mode) {
  if (terminalOnly && mode !== 'terminal') return;
  if (!['desktop', 'terminal'].includes(mode) || mode === displayPreferences.mode || modeChangeBusy() || confirmation) return;
  shortcutMenu.close(); closeConfirmation();
  if (mode === 'terminal' && !selectedTerminal) {
    const main = terminalCatalog.find(item => item.id === 'main' && item.supported);
    if (main) { if (!activateTerminal({ id: main.id, token: main.token }, { adopt: true })) return; }
    else { selectedTerminal = 'main'; selectedTerminalToken = ''; terminalSelectionState = 'loading'; adoptWindowDraft = true; }
  }
  const reused = swapStandby(mode);
  if (!reused) stopFrame();
  if (mode === 'desktop' && selectedTerminal && terminalSelectionState === 'ready') views.active.activationPending = true;
  updateDisplayPreferences({ mode }); renderTerminalList(); openFrame();
  if (mode === 'terminal' && !views.active.loaded) void loadTerminals();
  if (mode === 'terminal' && reused && views.active.key !== `${selectedTerminal}:${selectedTerminalToken}`) void switchTerminalStream({ id: selectedTerminal, token: selectedTerminalToken });
  if (mode === 'desktop' && selectedTerminal && terminalSelectionState === 'ready') {
    const generation = uiGeneration, entry = views.active, identity = `${selectedTerminal}:${selectedTerminalToken}`;
    void manageTerminals({ action: 'open', terminalId: selectedTerminal, terminalToken: selectedTerminalToken }, { waitForView: reused }).then(result => {
      if (generation !== uiGeneration || entry !== views.active) return;
      entry.activationPending = false; sendDisplayPreferences(); renderConnection();
      if (!owned || terminalMode() || identity !== `${selectedTerminal}:${selectedTerminalToken}` || result?.ok) return;
      desktopFocusFailureKey = identity; renderConnection();
      toast('桌面终端窗口未确认切换；请等待连接就绪后重新点击目标标签。', true);
    });
  }
  renderConnection();
}
$('mode-standby').addEventListener('change', () => {
  if (!modeStandbyEnabled || modeChangeBusy() || confirmation) { renderDisplayControls(); return; }
  const enabled = $('mode-standby').checked;
  updateDisplayPreferences({ modeStandby: enabled }); renderConnection();
});
for (const mode of ['desktop', 'terminal']) $(`${mode}-mode`).addEventListener('click', () => {
  if (mode !== displayPreferences.mode) requestConfirmation('mode', null, { from: displayPreferences.mode, mode });
});
$('terminal-view-select').addEventListener('change', () => selectTerminal($('terminal-view-select').value));
$('terminal-font-down').addEventListener('click', () => updateDisplayPreferences({ terminalFontSize: Math.max(10, displayPreferences.terminalFontSize - 1) }));
$('terminal-font-up').addEventListener('click', () => updateDisplayPreferences({ terminalFontSize: Math.min(28, displayPreferences.terminalFontSize + 1) }));
$('terminal-width-mode').addEventListener('change', () => updateDisplayPreferences({ terminalWidthMode: $('terminal-width-mode').value }));
$('terminal-mouse-reporting').addEventListener('change', () => updateDisplayPreferences({ terminalMouseReporting: $('terminal-mouse-reporting').checked }));
$('desktop-ime').addEventListener('change', () => updateDisplayPreferences({ desktopIme: $('desktop-ime').checked }));
$('terminal-history-rows').addEventListener('change', () => {
  const rows = Number($('terminal-history-rows').value);
  if (HISTORY_ROWS.includes(rows)) updateDisplayPreferences({ terminalHistoryRows: rows });
});
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('login-button'), async () => {
    $('login-error').textContent = '';
    const signal = AbortSignal.timeout(8000);
    try { await showWorkspace(await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value }, signal })); }
    catch (error) { $('login-error').textContent = signal.aborted ? '登录验证超时，结果尚未确认；请检查网络后手动重试，不会自动重发。' : error.message; }
  });
});
$('logout-button').addEventListener('click', () => { rememberDraft(); if (draftsAtRisk()) leaveWorkspace('logout'); else requestConfirmation('logout'); });
$('takeover-button').addEventListener('click', () => void action($('takeover-button'), claim));
$('reconnect-button').addEventListener('click', () => requestConfirmation('reconnect'));
$('terminal-button').addEventListener('click', () => requestConfirmation('terminal'));
$('input-dock').addEventListener('pointerdown', event => {
  // Preserve the system keyboard when pasting or sending a shortcut from the
  // touch assistant. Dialogs such as Ctrl+C still move focus explicitly.
  if (navigator.maxTouchPoints > 0 && document.activeElement === $('mobile-input') && event.target.closest('#paste-button, [data-key]')) event.preventDefault();
});
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
document.addEventListener('codex-desktop-touch-action', event => {
  if (event.target !== $('desktop-frame') || event.detail?.frame !== String(views.active.epoch) || !views.active.loaded || terminalMode() || inputBusy || views.active.composing || !canInput(true)) return;
  if (event.detail.action === 'interrupt') requestConfirmation('interrupt', null, { target: 'focused' });
  else if (event.detail.action === 'assistant' && workspacePanels.active !== 'input') toggleWorkspacePanel('input');
});

function canInsertFilePath() {
  return canManageTerminals() && !inputComposing && !views.active.composing && !confirmation && (!selectedTerminal || terminalSelectionState === 'ready');
}
function canOpenTransferDirectory() {
  return !terminalOnly && !terminalMode() && canManageTerminals() && canInput(true) && !inputComposing && !views.active.composing && !confirmation;
}
function renderFileControls() { fileWorkbench?.update(); }
function renderFileTransport() {
  const active = fileWorkbench?.transferPath;
  $('file-transport').textContent = active === 'https' ? '文件内容：HTTPS（本次传输）'
    : active === 'direct' ? `文件内容：${rtcRouteLabel(serviceLink.state.route)}（本次传输）`
    : serviceLink.files ? `文件内容：${rtcRouteLabel(serviceLink.state.route)}（下次传输可用${serviceLink.files.maxDownload > 50 * 1024 * 1024 ? '，大文件下载最多 1 GiB' : '，最多 50 MiB'}）`
    : serviceProtocol === 1 && rtcConfig?.webrtc ? '文件内容：HTTPS；后台继续探测 WebRTC' : '文件内容：HTTPS';
  $('diag-file-transport').textContent = $('file-transport').textContent.replace(/^文件内容：/, '');
}
function saveDirectFile(blob, name) { fileWorkbench.saveDownload(blob, name); }
fileWorkbench = createWorkbenchFiles({ $, api, action, toast, serviceLink,
  changed: renderFileTransport,
  trace: (type, detail) => recordConnection(type, detail, 'service'),
  state: () => ({ loggedIn, accessExpired, generation: uiGeneration, directory: transferDirectory, temporary: permissions.role === 'temporary', terminalOnly, terminalMode: terminalMode() }),
  startService: () => { if (serviceProtocol === 1) serviceLink.start(); }, canInsert: canInsertFilePath, canOpenDirectory: canOpenTransferDirectory,
  insertDraft(path) {
    const field = $('mobile-input'), draft = field.value + (field.value ? '\n' : '') + path;
    if (draft.length > 32768 || new TextEncoder().encode(draft).length > 32768) throw Error('加入路径后超过 32 KiB，请先精简草稿。');
    field.value = draft; rememberDraft(); $('files-dialog').close();
    if (workspacePanels.active !== 'input') toggleWorkspacePanel('input');
    setInputDirection('send', true); renderTerminalSelection(); toast('路径已加入输入草稿，尚未发送。');
  },
  async openDirectory() {
    const generation = uiGeneration; inputBusy = true; renderInputControls();
    try {
      const result = await api('/api/desktop/transfer-directory', { method: 'POST', body: {}, signal: AbortSignal.timeout(4500) });
      return generation === uiGeneration && owned && loggedIn && !accessExpired ? result : undefined;
    } finally { if (generation === uiGeneration) { inputBusy = false; renderInputControls(); } }
  },
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
  $('direct-server-ip').value = directHints.value.server;
  $('direct-browser-ip').value = directHints.value.browser;
  $('import-direct-hints').hidden = !directHints.legacy;
  $('direct-hints-status').textContent = directHints.persisted ? '' : '浏览器未能保存地址提示；当前页面仍可使用。';
  $('connection-dialog').showModal();
  renderConnection();
  void loadDiagnostics();
});
$('close-connection').addEventListener('click', () => $('connection-dialog').close());
$('connection-dialog').addEventListener('close', stopDiagnostics);
$('refresh-connection').addEventListener('click', () => { void poll(); void loadDiagnostics(); });
const hintProbeLabels = { probing: '正在验证新候选，当前连接继续运行。', waiting: '候选已验证，等待操作空闲及备用通道就绪。', switching: '正在选择并切换可用路径。',
  selected: '新连接已启用，实际路径见下方。', verified: '新候选已验证并待命，按路径质量选择。', kept: '已验证候选，保留当前更快的连接。',
  deferred: '当前切换条件尚未满足，保留可用连接，可稍后重新探测。', failed: '本次探测未成功，请以下方实际连接状态为准。', cancelled: '本次探测已结束，请以下方实际连接状态为准。', busy: '已有协商或操作进行中，可稍后重新探测。', unavailable: '当前未具备探测条件，提示将在后续协商使用。' };
function finishHintProbe() {
  clearTimeout(hintProbe?.timer); hintProbe = undefined;
  for (const id of ['save-direct-hints', 'save-direct-hints-only', 'import-direct-hints', 'clear-direct-hints']) $(id).disabled = false;
}
function hintProbeReport(id, phase, value) {
  if (!hintProbe || hintProbe.id !== id || hintProbe.phase !== phase || !Object.hasOwn(hintProbeLabels, value.state)) return;
  const text = (phase === 'workspace' ? '工作区：' : '文件与服务：') + hintProbeLabels[value.state];
  $('direct-probe-status').textContent = (phase === 'service' && hintProbe.workspaceResult ? hintProbe.workspaceResult + ' ' : '') + text;
  if (['probing', 'waiting', 'switching'].includes(value.state)) return;
  if (phase === 'workspace' && serviceLink.running) {
    hintProbe.workspaceResult = text;
    clearTimeout(hintProbe.timer); hintProbe.phase = 'service';
    hintProbe.timer = setTimeout(() => { hintProbeReport(id, 'service', { state: 'cancelled' }); }, 32000);
    void serviceLink.recheck(state => hintProbeReport(id, 'service', state));
  } else finishHintProbe();
}
function startHintProbe() {
  if (hintProbe || !loggedIn || accessExpired || hintProbeSequence >= 2147483647) return;
  const id = ++hintProbeSequence, phase = views.active.loaded && owned ? 'workspace' : 'service';
  hintProbe = { id, phase, timer: setTimeout(() => hintProbeReport(id, phase, { state: 'cancelled' }), 32000) };
  for (const name of ['save-direct-hints', 'save-direct-hints-only', 'import-direct-hints', 'clear-direct-hints']) $(name).disabled = true;
  hintProbeReport(id, phase, { state: 'probing' });
  if (phase === 'workspace') $('desktop-frame').contentWindow.postMessage({ type: 'codex-direct-recheck', frame: String(views.active.epoch), id }, location.origin);
  else void serviceLink.recheck(state => hintProbeReport(id, phase, state));
}
$('direct-hints-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    directHints.save({ server: $('direct-server-ip').value, browser: $('direct-browser-ip').value });
    $('direct-server-ip').value = directHints.value.server;
    $('direct-browser-ip').value = directHints.value.browser;
    $('direct-hints-status').textContent = `${directHints.persisted ? '已保存到当前浏览器的当前节点。' : '浏览器未能保存；仅当前页面生效。'}后续直连协商将使用这些提示。`;
    $('import-direct-hints').hidden = true;
    sendDisplayPreferences();
    renderConnection();
    if (event.submitter?.id !== 'save-direct-hints-only') startHintProbe();
  } catch (error) { $('direct-hints-status').textContent = error.message; }
});
$('import-direct-hints').addEventListener('click', () => {
  const legacy = directHints.legacy; if (!legacy) return;
  $('direct-server-ip').value = legacy.server; $('direct-browser-ip').value = legacy.browser;
  $('direct-hints-form').requestSubmit($('save-direct-hints-only'));
});
$('clear-direct-hints').addEventListener('click', () => {
  $('direct-server-ip').value = ''; $('direct-browser-ip').value = ''; $('direct-hints-form').requestSubmit($('save-direct-hints-only'));
});
for (const id of ['access-refresh-button', 'login-refresh-button']) $(id).addEventListener('click', () => leaveWorkspace('refresh'));
function clipboardAccess() {
  return loggedIn && owned && !accessExpired && navigator.onLine && panelState === 'online' && !inputPaused();
}
function clipboardOpen() { return workspacePanels.active === 'input' && inputDirection === 'receive' && !terminalOnly; }
function setInputDirection(direction, focus = false) {
  if (direction === 'receive' && !clipboardAccess()) return;
  shortcutMenu.close();
  clearClipboard(); inputDirection = direction;
  renderClipboard(); renderInputControls(); renderDesktopSettings(); sendDisplayPreferences();
  if (focus && direction === 'send') $('mobile-input').focus({ preventScroll: true });
}
function clearClipboard() { clipboardUI?.reset(); }
function renderClipboard() { clipboardUI?.update(); }
clipboardUI = createWorkbenchClipboard({ $, request: assistantRequest, access: clipboardAccess, open: clipboardOpen,
  blocked: () => inputBusy || controlsState.inputBusy || controlsState.clipboardBusy, terminalOnly: () => terminalOnly,
  receive: () => setInputDirection('receive'), changed: () => { renderInputControls(); renderDesktopSettings(); },
});
function settingsValues() {
  return { width: Number($('desktop-width').value), height: Number($('desktop-height').value) };
}
function settingsDirty() {
  const value = settingsValues();
  return !desktopSettings || ['width', 'height'].some(key => value[key] !== desktopSettings.saved[key]);
}
function renderDesktopSettings() {
  const writable = loggedIn && owned && !pageLeaving && !cachedResumePending && !accessExpired && !views.active.paused && panelState === 'online' && controlsState.available && !controlsState.maintenance && !controlsState.inputBusy && !controlsState.clipboardBusy && !controlsState.viewportBusy && !viewportResizing && !clipboardUI?.busy && !inputBusy && desktopSettings && !settingsController && !settingsBusy && !desktopSettings.busy;
  const adaptive = followsViewport() && controlsState.viewport?.supported;
  const live = desktopSettings?.canResize === true;
  for (const id of ['resolution-preset', 'desktop-width', 'desktop-height']) $(id).disabled = !writable || !!adaptive;
  const dirty = settingsDirty();
  $('save-desktop-settings').disabled = !writable || !dirty;
  for (const id of ['maximize-terminal', 'restore-terminal']) $(id).disabled = !writable;
  $('apply-desktop-settings').disabled = !!adaptive || !writable || dirty || !desktopSettings?.applyRequired || (live ? !views.active.resizeReady || !views.active.nativeIdle || views.active.state !== 'connected' : !desktopSettings?.session?.recoverable || !$('confirm-desktop-restart').checked);
  $('desktop-restart-notice').hidden = !desktopSettings?.restartRequired;
  if (!desktopSettings) return;
  const { actual, saved, session, job } = desktopSettings;
  $('settings-current').textContent = actual ? `当前实际分辨率：${actual.width} × ${actual.height}` : '桌面尚未就绪，仍可保存下次启动的配置。';
  $('settings-pending').textContent = adaptive ? '桌面尺寸正在跟随浏览器窗口；关闭此选项后使用固定尺寸。'
    : desktopSettings.applyRequired ? `待应用：${saved.width} × ${saved.height}；${live ? '可立即生效，当前任务继续运行。' : '当前显示无法直接调整，需确认重启。'}` : `已应用：${saved.width} × ${saved.height}；当前分辨率无需重启。`;
  $('settings-recovery').textContent = session?.resumeId ? `将恢复会话 ${session.resumeId}，项目：${session.cwd}` : session?.recoverable ? '当前为 shell，重启后打开新的 shell，不自动启动任务。' : '当前会话无法准确识别或存在多个窗格。结束前台任务后再应用分辨率。';
  $('apply-desktop-settings').textContent = live ? '立即应用分辨率' : session?.resumeId ? '重启桌面并恢复会话' : '重启桌面应用设置';
  if (settingsLoadError) $('desktop-settings-status').textContent = settingsLoadError;
  else if (job) $('desktop-settings-status').textContent = job.message;
}
function stopSettingsPolling() {
  clearTimeout(settingsTimer);
  settingsController?.abort(); settingsController = null;
}
async function loadDesktopSettings(resetForm = false) {
  if (!$('desktop-settings-dialog').open || settingsController || !loggedIn) return;
  const controller = new AbortController(); settingsController = controller;
  settingsLoadError = '';
  renderDesktopSettings();
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
      $('desktop-width').value = next.saved.width; $('desktop-height').value = next.saved.height;
      const size = `${next.saved.width}x${next.saved.height}`;
      $('resolution-preset').value = ['1280x1280', '1600x1600', '1600x3200', '1920x1600'].includes(size) ? size : 'custom';
    }
    renderDesktopSettings();
    if (next.busy) settingsTimer = setTimeout(() => void loadDesktopSettings(), 800);
  } catch (error) {
    if (settingsController === controller && loggedIn) { settingsLoadError = error.message; $('desktop-settings-status').textContent = settingsLoadError; }
  } finally {
    clearTimeout(timeout);
    if (settingsController === controller) { settingsController = null; renderDesktopSettings(); }
  }
}
async function settingsAction(path, body) {
  if (settingsBusy || !desktopSettings || !loggedIn || !owned) return;
  const live = path.endsWith('/resolution');
  if (live && (viewportController || !views.active.resizeReady || !views.active.nativeIdle || inputPaused())) return;
  stopSettingsPolling();
  const controller = live ? new AbortController() : null;
  const timeout = live ? setTimeout(() => controller.abort(), 10000) : null;
  const expected = { width: desktopSettings.saved.width, height: desktopSettings.saved.height };
  if (live) { viewportController = controller; viewportResizing = true; renderInputControls(); }
  const pausesInput = path.endsWith('/apply');
  if (pausesInput) { maintenancePending = true; controlsState = { ...controlsState, maintenance: true }; renderConnection(); }
  settingsLoadError = '';
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
    else $('desktop-settings-status').textContent = '服务器分辨率已保存，需显式应用。';
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
  $('desktop-settings-dialog').showModal();
  $('desktop-settings-status').textContent = '';
  $('confirm-desktop-restart').checked = false;
  await loadDesktopSettings(true);
});
$('close-desktop-settings').addEventListener('click', () => $('desktop-settings-dialog').close());
$('desktop-settings-dialog').addEventListener('close', stopSettingsPolling);
$('refresh-desktop-settings').addEventListener('click', () => { if (settingsBusy) return; $('confirm-desktop-restart').checked = false; stopSettingsPolling(); void loadDesktopSettings(); });
$('resolution-preset').addEventListener('change', () => {
  if ($('resolution-preset').value !== 'custom') {
    const [width, height] = $('resolution-preset').value.split('x');
    $('desktop-width').value = width; $('desktop-height').value = height;
  }
  $('confirm-desktop-restart').checked = false; renderDesktopSettings();
});
for (const id of ['desktop-width', 'desktop-height']) $(id).addEventListener('input', () => {
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
for (const [id, action] of [['maximize-terminal', 'maximize'], ['restore-terminal', 'restore']]) $(id).addEventListener('click', () => {
  if (!$(id).disabled) void settingsAction('/api/desktop/terminal-display', { action, revision: desktopSettings.revision });
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || !owned || pageLeaving) return;
  const entry = views.match(event.source, event.data?.frame);
  if (!entry) return;
  if (offerBridge.message(entry, event.data)) return;
  if (entry === views.standby) { receiveStandby(event.data); return; }
  const wasReady = entry.panelReady;
  updateView(entry, event.data);
  if (['codex-connection-progress', 'codex-view-first-frame'].includes(event.data.type)) { renderConnectionTrace(); return; }
  if (event.data.type === 'codex-terminal-attachment') { renderConnection(); return; }
  if (event.data.type === 'codex-direct-recheck-state') { hintProbeReport(event.data.id, 'workspace', event.data); return; }
  if (event.data.type === 'codex-network-event') { recordConnection(event.data.event?.type, event.data.event, displayPreferences.mode); return; }
  if (event.data?.type === 'codex-panel-state') {
    if (views.active.panelReady && !wasReady && !cachedResumePending) { stopPolling(); void poll(); }
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-panel-result') {
    if (!panelRequests.has(event.data.id)) return;
    const error = event.data.ok === true ? null : Object.assign(new Error(event.data.error?.message || '连接请求失败'), { status: event.data.error?.status, outcome: event.data.error?.outcome || 'unknown', code: event.data.error?.code });
    finishPanelRequest(event.data.id, error, event.data.value); return;
  }
  if (event.data?.type === 'codex-terminal-composition' && terminalMode() && typeof event.data.composing === 'boolean') {
    views.active.composing = event.data.composing || historyToolsPortal.composing; renderInputControls(); return;
  }
  if (event.data?.type === 'codex-desktop-input-state' && !terminalMode() && typeof event.data.composing === 'boolean') {
    views.active.composing = event.data.composing; views.active.touchInput = event.data.touch === true; renderInputControls(); scheduleViewport(); return;
  }
  if (event.data?.type === 'codex-desktop-text' && !terminalMode()) {
    // Use the parent's postMessage function for replies. In WebKit the child
    // method can attribute async calls to the child, which fails source checks.
    const value = event.data, destination = $('desktop-frame').contentWindow, sourceFrame = String(views.active.epoch);
    if (!Number.isSafeInteger(value.id) || value.id < 1 || value.id > 2147483647) return;
    if (desktopTextFrame !== sourceFrame) { desktopTextFrame = sourceFrame; desktopTextSequence = 0; }
    if (value.id <= desktopTextSequence) return;
    desktopTextSequence = value.id;
    const respond = result => window.postMessage.call(destination, { type: 'codex-desktop-text-result', frame: sourceFrame, id: value.id, outcome: result?.outcome || 'unknown', ...(result?.focus ? { focus: result.focus } : {}) }, location.origin);
    const editing = value.focus !== undefined, erase = value.erase ?? 0;
    if (!displayPreferences.desktopIme || desktopTextInput || inputBusy || !canInput(true) || typeof value.text !== 'string' || !value.text && !erase || !Number.isInteger(erase) || erase < 0 || erase > 512 || erase && !editing || /[\x00-\x08\x0b-\x1f\x7f]/.test(value.text) || new TextEncoder().encode(value.text).length > 32768) return respond({ outcome: 'rejected' });
    desktopTextInput = true;
    void inputAction(editing ? '/api/edit' : '/api/paste', { text: value.text, target: 'focused', ...(editing ? { erase, focus: value.focus } : {}) }, '输入文字', '文字已输入，Enter 单独提交', {}).then(respond).finally(() => { desktopTextInput = false; sendDisplayPreferences(); });
    return;
  }
  if (event.data?.type === 'codex-pointer-options') {
    if (!terminalMode() && canInput(true) && ['viewport', 'remote'].includes(event.data.scrollTarget)) updateDisplayPreferences({ scrollTarget: event.data.scrollTarget });
    return;
  }
  if (event.data?.type === 'codex-transport') { renderConnection(); return; }
  if (event.data?.type === 'codex-direct-prepare') {
    if (!Number.isSafeInteger(event.data.id) || event.data.id < 1) return;
    const allowed = loggedIn && owned && !accessExpired && views.active.state === 'connected' && !inputPaused() && !inputBusy && !inputComposing && !views.active.composing && !terminalBusy && !terminalActions.busy && !views.active.reviewing && !$('terminals-dialog').open && !$('terminal-switch-dialog').open && !$('draft-leave-dialog').open && !clipboardUI?.busy && !controlPending && !settingsBusy && !confirmation && !shortcutMenu.open && !controlsState.inputBusy && !controlsState.clipboardBusy;
    if (allowed) {
      views.active.paused = true;
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => { views.active.paused = false; renderConnection(); }, 15000);
      renderConnection();
    }
    $('desktop-frame').contentWindow.postMessage({ type: 'codex-direct-approved', frame: String(views.active.epoch), id: event.data.id, allowed }, location.origin);
    return;
  }
  if (event.data?.type === 'codex-direct-finished') {
    clearTimeout(switchTimer); views.active.paused = false; renderConnection(); return;
  }
  if (event.data?.type === 'codex-stream-state' && typeof event.data.paused === 'boolean') { renderConnection(); return; }
  if (event.data?.type === 'codex-stream-reset' && event.data.reason === 'target-unknown') {
    terminalSelectionState = 'error'; stopFrame(); renderConnection(); toast('终端切换结果未知，草稿已保留；请重新选择目标，不会重发输入。', true); return;
  }
  if (event.data?.type === 'codex-stream-reset' && ['input-unknown', 'input-pressure'].includes(event.data.reason)) {
    const record = streamInputNotice(event.data); views.active.inputNoticeKey = record.key;
    inputMessage('unknown', record.message); return;
  }
  if (event.data?.type === 'codex-control-state') {
    controlReady = event.data.ready === true && views.active.state === 'connected' && ['direct', 'terminal'].includes(views.active.transport);
    if (!controlReady) resetDirectControl();
    renderConnection(); return;
  }
  if (event.data?.type === 'codex-terminal-size' && terminalMode()) { renderConnection(); return; }
  if (event.data?.type === 'codex-terminal-history' && terminalMode() && typeof event.data.reviewing === 'boolean') { renderInputControls(); return; }
  if (event.data?.type === 'codex-control-result') {
    if (!controlPending || event.data.id !== controlPending.id) return;
    const error = event.data.ok === true ? null : Object.assign(new Error(event.data.error?.message || '输入操作失败'), { outcome: event.data.error?.outcome || 'unknown', status: event.data.error?.status });
    finishDirectControl(error, event.data.value); return;
  }
  if (event.data?.type === 'codex-desktop-view') {
    if (event.data.revision !== displayRevision) return;
    if (views.active.nativeIdle) scheduleViewport();
    renderDisplayControls(); viewportWaiter?.(); renderConnection(); return;
  }
  if (event.data?.type !== 'codex-desktop') return;
  if (event.data.state === 'ready') { recordConnection('view-ready', {}, displayPreferences.mode); sendDisplayPreferences(); renderConnectionTrace(); return; }
  if (event.data.state === 'connected') sendDisplayPreferences();
  else if (event.data.state === 'disconnected') { resetDirectControl(); resetPanelRequests(); if (panelRoute === 'direct') panelState = 'offline'; clearClipboard(); renderClipboard(); }
  else if (event.data.state !== 'connecting') return;
  renderConnection();
});
document.addEventListener('fullscreenchange', () => {
  shortcutMenu.close();
  renderFullscreenControls();
  // Fullscreen paints only its own subtree above the page.
  const card = $('desktop-card');
  const host = document.fullscreenElement === card ? card : document.body;
  if ($('toast').parentElement !== host) host.append($('toast'));
});
document.addEventListener('visibilitychange', () => {
  if (loggedIn) recordConnection('network-change', { reason: document.hidden ? 'hidden' : 'visible' }, displayPreferences.mode);
  if (document.hidden) connectionTrace.flush();
  syncScreenLock(); if (!document.hidden) void poll(); else { views.active.latency.clear(); shortcutMenu.close(); closeConfirmation(); } renderConnection();
});
createWorkspaceLifetime(window, { features: [fileWorkbench, clipboardUI], onHide(event) {
  if (loggedIn) recordConnection('network-change', { reason: 'page-hidden' }, displayPreferences.mode);
  connectionTrace.flush();
  pageLeaving = true; workspaceInitialized = false; cachedResumePending = event.persisted === true;
  cachedViewReset = !terminalMode() || terminalSwitching;
  if (loggedIn) rememberDraft();
  // Frozen pages may never receive compositionend; keep the draft, not its
  // transient IME lock. No text is committed or sent during this cleanup.
  inputComposing = false;
  terminalLoadAttempted = false;
  if (terminalFocusBusy) desktopFocusFailureKey = `${selectedTerminal}:${selectedTerminalToken}`;
  if (terminalSwitching) terminalSelectionState = 'error';
  uiGeneration++; stopPolling(); serviceLink.stop(); stopDiagnostics(); stopSettingsPolling();
  inputController?.abort(); terminalController?.abort(); clipboardUI?.suspend(); viewportController?.abort();
  resetDirectControl(); resetPanelRequests();
  terminalController = null; terminalBusy = terminalFocusBusy = terminalSwitching = false;
  clearTimeout(viewportTimer); viewportController = null; viewportResizing = false;
  views.suspend(); syncRelayLatency(); historyToolsPortal.reset(); discardStandby();
  shortcutMenu.close(); closeConfirmation(); syncScreenLock(); renderInputControls();
}, onShow(event) {
  if (loggedIn && event.persisted) recordConnection('network-change', { reason: 'page-restored' }, displayPreferences.mode);
  pageLeaving = false; draftUnloadApproved = false;
  if (event.persisted && loggedIn) {
    cachedResumePending = true; workspaceInitialized = false;
    // A retired viewer can still commit its queued about:blank navigation in
    // WebKit. Every required replacement gets a new context, source and epoch.
    // An uninterrupted xterm retains its own persisted-return recovery.
    if (cachedViewReset || !terminalMode()) stopFrame({ replaceElement: true });
    cachedViewReset = false; stopPolling(); void poll();
  } else if (loggedIn) workspaceInitialized = true;
  syncScreenLock(); renderConnection(); renderDraftSafety();
} });

accessUI = createAccessUI({ api, allowed: () => loggedIn && owned && permissions.role !== 'temporary' && !accessExpired,
  canUnlock: () => loggedIn && permissions.canClaim && !accessExpired, needsUnlock: () => permissions.requiresUnlock,
  lockEnabled: () => permissions.screenLockEnabled, claim, changed: updateAccess, activity: () => { renderInputControls(); scheduleViewport(); }, toast });
forwardingUI = createForwardUI({ api, hints: () => directHints.value, allowed: () => loggedIn && !accessExpired && navigator.onLine && panelState === 'online',
  prepareDownloads: () => { if (serviceProtocol !== 1 || !rtcConfig?.webrtc) return false; serviceLink.start(); return serviceLink.state.issue === 'connecting' || serviceLink.transport?.features?.helperDownloadsProtocol === 1; },
  downloadClient: () => serviceLink.helperFiles, downloadRoute: () => serviceLink.state.route, saveDownload: saveDirectFile,
  capabilities: () => ({ manageDevices: permissions.canManageHelpers, viewHelperKeys: permissions.canViewHelperKeys, temporary: permissions.role === 'temporary' }) });
function canLeaveNode() { return !inputBusy && !inputComposing && !views.active.composing && !terminalBusy && !settingsBusy && !maintenancePending && !controlsState.maintenance && !controlsState.inputBusy && !controlsState.clipboardBusy && !controlPending && !clipboardUI?.busy && !$('upload-input').disabled && !forwardingUI?.busy; }
$('gateway-switch-button').addEventListener('click', () => {
  leaveWorkspace('gateway');
});
$('cancel-draft-leave').addEventListener('click', closeDraftLeave);
$('draft-backup-button').addEventListener('click', () => {
  if ($('draft-backup-button').disabled || $('draft-leave-dialog').open) return;
  draftLeavePending = undefined;
  $('draft-leave-title').textContent = '备份本节点草稿';
  $('draft-leave-description').textContent = '复制当前编辑的文字，或导出本节点保留的全部草稿。不会上传或发送到终端。';
  $('confirm-draft-leave').hidden = true; $('cancel-draft-leave').textContent = '返回输入';
  $('draft-leave-dialog').showModal(); $('cancel-draft-leave').focus(); renderInputControls();
});
$('draft-leave-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDraftLeave(); });
$('draft-leave-dialog').addEventListener('close', () => { if (!$('draft-leave-dialog').open) closeDraftLeave(); });
$('confirm-draft-leave').addEventListener('click', () => {
  const pending = draftLeavePending; closeDraftLeave();
  if (pending?.generation === uiGeneration) leaveWorkspace(pending.kind, true);
});
async function copyCurrentDraft() {
  const text = $('mobile-input').value, generation = uiGeneration;
  if (!text || draftCopyBusy || permissions.role === 'temporary') return;
  const inDialog = $('draft-leave-dialog').open;
  draftCopyBusy = true; renderDraftSafety();
  try {
    if (!navigator.clipboard?.writeText) throw Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    if (generation !== uiGeneration) return;
    if (inDialog && $('draft-leave-dialog').open) $('draft-leave-status').textContent = draftLeavePending ? '当前草稿已复制；确认已备份后再决定是否离开。' : '当前草稿已复制。';
    else toast('当前草稿已复制。');
  } catch {
    if (generation !== uiGeneration || $('mobile-input').value !== text) return;
    const field = inDialog && $('draft-leave-dialog').open ? $('draft-leave-preview') : $('mobile-input');
    if (field !== $('mobile-input')) { field.value = text; field.hidden = false; }
    field.focus({ preventScroll: true }); field.select();
    if (inDialog) $('draft-leave-status').textContent = '浏览器未允许自动复制；请使用系统复制操作保护已选中的文字。';
    else toast('草稿已选中，请使用系统复制操作。');
  } finally { draftCopyBusy = false; renderDraftSafety(); }
}
function exportDrafts() {
  if (permissions.role === 'temporary') return;
  try {
    const data = JSON.stringify(terminalState.snapshot(draftIdentity, $('mobile-input').value), null, 2);
    if (new TextEncoder().encode(data).length > STATE_LIMIT) throw Error('草稿备份过大，请先复制当前草稿');
    saveDirectFile(new Blob([data], { type: 'application/json;charset=utf-8' }), `codex-drafts-${nodeIdentity().slice(0, 8) || 'local'}-${Date.now()}.json`);
    if ($('draft-leave-dialog').open) $('draft-leave-status').textContent = draftLeavePending ? '草稿已交给浏览器下载；请确认已保存，再决定是否离开。' : '草稿已交给浏览器下载，请确认文件已保存。';
    else toast('本节点草稿已交给浏览器下载。');
  } catch (error) { toast(error.message, true); }
}
for (const id of ['copy-draft', 'copy-leave-draft']) $(id).addEventListener('click', () => void copyCurrentDraft());
for (const id of ['export-drafts', 'export-leave-drafts']) $(id).addEventListener('click', exportDrafts);
{
  const signal = AbortSignal.timeout(8000);
  try { await showWorkspace(await api('/api/me', { signal })); }
  catch (error) { showLogin(signal.aborted ? '读取登录状态超时，请检查网络后手动连接。' : accessExpired ? error.message : ''); }
}
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register(entryPath('/sw.js')).catch(() => {});

// Only announce updates; active input and streams stay on their loaded version.
let uiCheckTimer;
async function checkUIVersion() {
  clearTimeout(uiCheckTimer);
  if (document.hidden) return;
  try {
    const response = await fetch(entryPath('/ui-version'), { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (response.ok) {
      const { revision } = await response.json(), loaded = document.querySelector('meta[name="ui-revision"]')?.content;
      const note = $('ui-update-note'); if (note) note.hidden = !loaded || revision === loaded;
    }
  } catch {}
  if (!document.hidden) uiCheckTimer = setTimeout(checkUIVersion, 60000);
}
document.addEventListener('visibilitychange', () => { clearTimeout(uiCheckTimer); if (!document.hidden) void checkUIVersion(); });
window.addEventListener('pagehide', () => clearTimeout(uiCheckTimer));
void checkUIVersion();
