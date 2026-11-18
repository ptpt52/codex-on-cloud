import { CONTROL_TRACE_ACTIONS } from './control.js';

export const TRACE_LIMITS = Object.freeze({ events: 200, bytes: 65536, scopes: 4, storageBytes: 262144, ageMs: 86400000 });
export const TRACE_STORAGE_KEY = 'codex-cloud.network-log.v2';
export const TRACE_LABELS = Object.freeze({
  'relay-start': '开始连接中转', 'relay-open': '中转握手完成', 'relay-ready': '中转认证完成',
  'direct-start': '开始探测 WebRTC', 'rtc-stage': 'WebRTC 协商', 'direct-ready': 'WebRTC 加密通道已就绪',
  'first-frame': '首屏准备完成', 'path-active': '数据通道已启用', 'path-lost': '通道已断开', 'retry': '等待重试',
  'heartbeat-timeout': '心跳未及时回复', 'heartbeat-delayed': '数据仍有进展，等待拥塞中的心跳', 'network-change': '网络或前后台状态变化',
  'session-ended': '观看连接已结束', 'input-pressure': '输入队列达到上限',
  'path-quality': '通道排队或确认变慢',
  'probe-waiting': '候选通道等待切换', 'probe-stopped': '自动直连探测已停止',
  'rtc-state': 'WebRTC 状态', 'rtc-candidates': '地址收集结果', 'heartbeat-ok': '心跳复核通过',
  'rtc-stats-timeout': '路径统计暂未返回，继续按心跳检测连接',
  'rtc-route': '选中的 WebRTC 路径',
  'view-start': '准备查看连接', 'view-ready': '查看器模块已加载', 'view-reused': '复用待命视图', 'view-discarded': '释放待命视图',
  'request-failed': '节点请求失败', 'request-recovered': '节点请求已恢复',
  'rpc-failed': '直连控制请求失败', 'rpc-recovered': '迟到回复已排空，控制通道恢复', 'control-closed': '直连控制通道已关闭',
  'recheck-start': '开始手动直连重测', 'recheck-switch': '候选验证完成，准备切换', 'recheck-ended': '手动直连重测结束',
  'file-start': '开始上传文件', 'file-progress': '上传接收进度', 'file-ended': '本次上传结束',
  'capture-start': '开始记录网络调试日志',
});
export const TRACE_STAGES = Object.freeze({ gathering: '收集地址', queued: '等待协商名额', signaling: '交换连接信息', connecting: '建立加密通道', ready: '通道已建立' });
export const TRACE_RECHECK_STEPS = Object.freeze({ candidate: '创建候选', connect: '建立候选连接', health: '验证候选心跳', stats: '比较路径质量', idle: '等待操作空闲', switch: '切换与接管', commit: '开始提交切换' });
export const TRACE_RECHECK_RESULTS = Object.freeze({ selected: '新连接已启用', verified: '候选已验证并待命', kept: '保留当前路径', deferred: '暂未切换', failed: '本次重测失败', cancelled: '本次重测已取消' });
export const TRACE_REASONS = Object.freeze({
  unsupported: '浏览器不支持 WebRTC', disabled: '直连功能未启用', signaling: '协商请求未完成', negotiation: '协商未成功', timeout: '连接超时',
  'signaling-timeout': '交换连接信息超时', 'gathering-timeout': '地址收集超时', 'ice-timeout': '网络路径探测超时', 'channel-timeout': '加密数据通道建立超时',
  connection: '原连接已断开', heartbeat: '心跳没有回复', 'heartbeat-suspect': '心跳延迟，正在复核', offline: '设备离线', hidden: '页面进入后台或设备熄屏',
  online: '设备恢复联网', visible: '页面返回前台', changed: '设备报告网络变化', busy: '服务端协商繁忙', auth: '访问权限需要重新确认', target: '终端或查看会话身份发生变化',
  protocol: '协商参数未被接受', closed: '连接已关闭', 'input-unknown': '输入结果无法确认', 'input-pressure': '输入队列达到上限', 'target-unknown': '切换结果无法确认',
  'resume-timeout': '恢复查看连接超时', 'session-expired': '查看会话已失效', 'signal-failed': '协商服务暂不可达',
  'rpc-timeout': '控制请求超时，操作结果待确认',
  'local-http-timeout': '节点本机服务请求超时', 'local-http-error': '节点本机服务连接中断', 'peer-closed': '远端控制通道已关闭',
  'channel-error': '控制通道报告传输错误', 'control-protocol': '控制回复格式或序号无效', 'control-send': '控制请求发送失败', 'late-reply': '迟到回复仅恢复通道，不改变原操作结果',
  standby: '后台待命视图禁止切换路径', 'keyboard-open': '远程键盘仍处于开启状态', 'frame-loading': '等待桌面首帧或尺寸恢复',
  'input-active': '等待输入空闲', composition: '输入法正在选字', 'keys-held': '等待按键或指针释放', 'ui-busy': '等待界面操作完成',
  history: '正在查找、复制或查看历史', 'target-switch': '正在切换终端', cooldown: '连接路径切换冷却期', 'quality-warming': '等待延迟采样',
  quality: '当前路径质量更好', 'handoff-refused': '当前界面暂未允许切换', aborted: '请求已取消', network: '请求未收到响应',
  'page-hidden': '页面已挂起', 'page-restored': '从浏览器缓存恢复页面',
  'native-busy': '浏览器原生协商仍有挂起调用，等待释放',
  'http-status': '请求返回错误状态',
  file_busy: '文件服务正在处理另一项上传或删除', file_exists: '已有同名文件，未覆盖',
  file_read_failed: '本机文件读取失败，请重新选择文件',
  file_ack_timeout: '文件分块确认超时，请检查文件状态后手动重试',
  file_buffer_timeout: '文件发送缓冲超时，请检查文件状态后手动重试',
  'file-progress': '文件数据或确认仍在推进，连接保持活跃',
  'handoff-busy': '另一项连接切换仍在处理', 'input-unconfirmed': '等待已发送数据确认，不重发输入', 'output-draining': '等待终端完成当前画面',
});
const reasons = ['unsupported', 'disabled', 'signaling', 'negotiation', 'timeout', 'signaling-timeout', 'gathering-timeout', 'ice-timeout', 'channel-timeout',
  ...Object.keys(TRACE_REASONS)];
const number = value => Number.isInteger(value) && value >= 0 && value <= 2 ** 40;
const routes = { lan: '局域网直连', ipv6: 'IPv6 直连', nat: 'NAT 打洞', vpn: 'VPN', 'public-ipv4': '公网 IPv4', turn: 'TURN 中继', wss: 'WebSocket 中转', https: 'HTTPS', direct: 'WebRTC', unknown: '类型待确认' };
const probeStates = ['probing', 'gathering', 'queued', 'signaling', 'connecting', 'ready', 'retrying', 'stopped'];
// Operational status, independent of optional process logging. Only the latest
// fixed state is retained by each live view, with no history or payloads.
export function connectionProgress(type, detail = {}) {
  if (detail.path !== 'direct') return null;
  if (type === 'recheck-ended' && probeStates.includes(detail.probe)) return { probe: detail.probe,
    ...(Object.hasOwn(TRACE_REASONS, detail.probeReason) ? { probeReason: detail.probeReason } : {}) };
  const probe = type === 'direct-start' ? 'probing' : type === 'rtc-stage' && probeStates.includes(detail.stage) ? detail.stage :
    ['direct-ready', 'path-active'].includes(type) ? 'ready' : type === 'probe-stopped' ? 'stopped' : ['retry', 'path-lost'].includes(type) ? 'retrying' : null;
  return probe ? { probe, ...(Object.hasOwn(TRACE_REASONS, detail.reason) ? { probeReason: detail.reason } : {}) } : null;
}
function clean(value) {
  if (!value || !Object.hasOwn(TRACE_LABELS, value.type)) return null;
  const result = { type: value.type };
  if (['relay', 'direct'].includes(value.path)) result.path = value.path;
  if (Object.hasOwn(routes, value.route)) result.route = value.route;
  if (['confirmed', 'rejected', 'unknown', 'canceled'].includes(value.outcome)) result.outcome = value.outcome;
  if (Object.hasOwn(TRACE_STAGES, value.stage)) result.stage = value.stage;
  if (value.type.startsWith('recheck-') && Object.hasOwn(TRACE_RECHECK_STEPS, value.step)) result.step = value.step;
  if (value.type === 'recheck-ended' && Object.hasOwn(TRACE_RECHECK_RESULTS, value.result)) result.result = value.result;
  if (value.type === 'recheck-ended' && probeStates.includes(value.probe)) {
    result.probe = value.probe;
    if (Object.hasOwn(TRACE_REASONS, value.probeReason)) result.probeReason = value.probeReason;
  }
  if (reasons.includes(value.reason)) result.reason = value.reason;
  if (['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed', 'gathering', 'complete'].includes(value.state)) result.state = value.state;
  if (['ice', 'peer', 'gathering'].includes(value.phase)) result.phase = value.phase;
  if (['state', 'terminals', 'files', 'forward', 'access', 'desktop', 'input', 'other'].includes(value.operation)) result.operation = value.operation;
  if (CONTROL_TRACE_ACTIONS.includes(value.action)) result.action = value.action;
  if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) result.status = value.status;
  for (const key of ['durationMs', 'waitMs', 'budgetMs', 'queuedBytes', 'rttMs', 'jitterMs', 'ackMs', 'penaltyMs', 'attempt', 'host', 'reflexive', 'relay', 'candidateMs', 'currentMs', 'pendingInputs', 'inputAgeMs', 'loadedBytes', 'totalBytes', 'windowChunks', 'chunkAckMs', 'chunkMaxAckMs', 'bufferWaitMs', 'fileReadMs']) if (number(value[key])) result[key] = value[key];
  return result;
}
// No text, addresses, IDs, SDP or credentials cross this diagnostic interface.
export function createTraceReporter(frame, { enabled = () => false } = {}) {
  return (type, detail = {}) => {
    if (!enabled()) return;
    const event = clean({ ...detail, type });
    if (event) { try { parent.postMessage({ type: 'codex-network-event', frame, event }, location.origin); } catch {} }
  };
}
export function createConnectionTrace(now = () => Date.now(), { storage, scope = '', wallNow = Date.now, enabled = false } = {}) {
  let events = [], start = now(), offset = 0, persisted = !!storage, recording = enabled === true, persistTimer;
  let page = 1, startedAt = wallNow(), droppedEvents = 0, suppressedEvents = 0;
  const live = new Map(), progressTypes = ['direct-start', 'direct-ready', 'rtc-stage', 'probe-waiting', 'probe-stopped', 'path-active', 'path-lost', 'retry', 'session-ended'];
  const networkEvents = new Map(); // At most twenty-four recent lifecycle keys.
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-z0-9/_:-]+$/i.test(value);
  const modes = ['desktop', 'terminal', 'service'];
  const storedEvent = value => {
    const event = clean(value);
    if (!event || !modes.includes(value.mode) || !number(value.atMs) || !Number.isSafeInteger(value.time) || value.time < wallNow() - TRACE_LIMITS.ageMs || value.time > wallNow() + 60000) return null;
    return { atMs: value.atMs, time: value.time, page: number(value.page) ? value.page : 0, mode: value.mode, standby: value.standby === true, ...(number(value.view) ? { view: value.view } : {}), ...event };
  };
  function read() {
    try {
      const text = storage?.getItem(TRACE_STORAGE_KEY);
      if (!text || text.length > TRACE_LIMITS.storageBytes) return [];
      const cache = JSON.parse(text);
      if (cache.version !== 2 || !Array.isArray(cache.entries) || cache.entries.length > TRACE_LIMITS.scopes || bytes(cache) > TRACE_LIMITS.storageBytes) return [];
      return cache.entries.filter(entry => validScope(entry?.scope) && Number.isSafeInteger(entry.at) && entry.at >= wallNow() - TRACE_LIMITS.ageMs && entry.at <= wallNow() + 60000 && Array.isArray(entry.events) && entry.events.length <= TRACE_LIMITS.events && bytes(entry.events) <= TRACE_LIMITS.bytes)
        .map(entry => ({ scope: entry.scope, at: entry.at, events: entry.events.map(storedEvent).filter(Boolean) }));
    } catch { persisted = false; return []; }
  }
  if (recording && validScope(scope)) {
    events = read().find(entry => entry.scope === scope)?.events || [];
    page = Math.min(2 ** 40, Math.max(0, ...events.map(event => event.page)) + 1);
    const last = events.at(-1); if (last) offset = last.atMs + Math.max(0, wallNow() - last.time);
  }
  function persist() {
    clearTimeout(persistTimer); persistTimer = undefined;
    if (!recording) return;
    if (!storage || !validScope(scope)) { persisted = false; return; }
    try {
      const entries = read().filter(entry => entry.scope !== scope);
      entries.push({ scope, at: wallNow(), events }); entries.sort((a, b) => a.at - b.at);
      while (entries.length > TRACE_LIMITS.scopes || bytes({ version: 2, entries }) > TRACE_LIMITS.storageBytes) entries.shift();
      storage.setItem(TRACE_STORAGE_KEY, JSON.stringify({ version: 2, entries })); persisted = true;
    } catch { persisted = false; }
  }
  function discardStored() {
    if (!storage || !validScope(scope)) return;
    try {
      const entries = read(); if (!entries.some(entry => entry.scope === scope)) return;
      const next = entries.filter(entry => entry.scope !== scope);
      if (!next.length && storage.removeItem) storage.removeItem(TRACE_STORAGE_KEY);
      else storage.setItem(TRACE_STORAGE_KEY, JSON.stringify({ version: 2, entries: next }));
    } catch { persisted = false; }
  }
  if (!recording) discardStored();
  function reset() {
    clearTimeout(persistTimer); persistTimer = undefined;
    events = []; live.clear(); networkEvents.clear(); offset = 0; start = now(); startedAt = wallNow(); droppedEvents = suppressedEvents = 0;
  }
  function trim() {
    const time = wallNow();
    while (events.length && time - events[0].time > TRACE_LIMITS.ageMs) { events.shift(); droppedEvents++; }
    // Preserve failures and milestones ahead of routine samples, while always
    // retaining the last 32 events as chronological context. Bounds stay fixed.
    while (events.length > TRACE_LIMITS.events || bytes({ version: 2, events }) > TRACE_LIMITS.bytes - 1024) { evict(events); droppedEvents++; }
  }
  const important = new Set(['capture-start', 'network-change', 'path-active', 'path-lost', 'heartbeat-timeout', 'input-pressure', 'probe-stopped', 'session-ended', 'view-start', 'view-ready', 'view-reused', 'view-discarded', 'first-frame', 'request-failed', 'request-recovered', 'rpc-failed', 'rpc-recovered', 'control-closed', 'recheck-ended', 'file-start', 'file-ended']);
  function evict(list) {
    const index = list.findIndex((event, index) => index < list.length - 32 && !important.has(event.type));
    list.splice(index < 0 ? 0 : index, 1);
  }
  function text(current) {
    trim();
    const exported = { version: 2, exportedAt: wallNow(), capture: { enabled: recording, page, startedAt, droppedEvents, suppressedEvents, limits: TRACE_LIMITS }, ...(current ? { current: cleanCurrent(current) } : {}), events: events.map(event => ({ ...event })) };
    while (bytes(exported) > TRACE_LIMITS.bytes && exported.events.length) { evict(exported.events); exported.capture.droppedEvents++; }
    return JSON.stringify(exported);
  }
  return {
    add(value, { mode, standby = false, view } = {}) {
      if (!recording) return false;
      const event = clean(value);
      if (!event || !modes.includes(mode)) return false;
      const time = wallNow(), key = `${mode}:${number(view) ? view : 'global'}`;
      if (['network-change', 'path-lost'].includes(event.type)) {
        const repeatKey = `${key}:${event.type}:${event.path || ''}`, signature = JSON.stringify(event), previous = networkEvents.get(repeatKey);
        if (previous?.signature === signature && time >= previous.time && time - previous.time < 500) { suppressedEvents++; return false; }
        networkEvents.delete(repeatKey); networkEvents.set(repeatKey, { time, signature });
        if (networkEvents.size > 24) networkEvents.delete(networkEvents.keys().next().value);
      }
      const record = { atMs: Math.max(events.at(-1)?.atMs || 0, 0, Math.round(offset + now() - start)), time, page, mode, standby: standby === true, ...(number(view) ? { view } : {}), ...event };
      events.push(record);
      if (record.path === 'direct' && progressTypes.includes(record.type)) {
        live.delete(key); live.set(key, record);
        if (live.size > 12) live.delete(live.keys().next().value);
      }
      trim();
      if (storage && validScope(scope)) persistTimer ??= setTimeout(persist, 250);
      return true;
    },
    snapshot() { trim(); return events.map(event => ({ ...event })); }, text, flush: persist,
    get stats() { trim(); return { retained: events.length, droppedEvents, suppressedEvents }; },
    get enabled() { return recording; },
    setEnabled(value) {
      const next = value === true; if (next === recording) return false;
      reset(); recording = next; if (!next) discardStored(); return true;
    },
    get persisted() { return persisted; },
    latest(mode, view) { const value = view === undefined ? [...live.values()].findLast(event => event.mode === mode) : live.get(`${mode}:${view}`); return value && wallNow() - value.time <= TRACE_LIMITS.ageMs ? { ...value } : undefined; },
    clear() { reset(); discardStored(); },
  };
}

function cleanCurrent(value) {
  const result = { online: value.online === true, visible: value.visible === true };
  if (['ios', 'android', 'other'].includes(value.platform)) result.platform = value.platform;
  if (typeof value.revision === 'string' && /^[a-f0-9]{8,64}$/.test(value.revision)) result.revision = value.revision;
  result.views = (Array.isArray(value.views) ? value.views : []).slice(0, 3).filter(view => ['desktop', 'terminal', 'service'].includes(view?.mode)).map(view => ({
    mode: view.mode, standby: view.standby === true,
    state: ['idle', 'connecting', 'connected', 'reconnecting', 'offline'].includes(view.state) ? view.state : 'idle',
    path: ['direct', 'relay'].includes(view.path) ? view.path : 'unknown',
    ...(Object.hasOwn(routes, view.route) ? { route: view.route } : {}),
    ...(Object.hasOwn(TRACE_REASONS, view.reason) ? { reason: view.reason } : {}),
    ...(typeof view.moduleReady === 'boolean' ? { moduleReady: view.moduleReady } : {}),
    ...(typeof view.firstFrame === 'boolean' ? { firstFrame: view.firstFrame } : {}),
    ...(probeStates.includes(view.probe) ? { probe: view.probe } : {}),
    ...(Object.hasOwn(TRACE_REASONS, view.probeReason) ? { probeReason: view.probeReason } : {}),
  }));
  return result;
}

export function traceDescription(event, now = Date.now()) {
  const states = { new: '新建', checking: '正在探测', connecting: '正在连接', connected: '已连接', completed: '已完成', disconnected: '暂时断开', failed: '失败', closed: '已关闭', gathering: '正在收集', complete: '收集完成' };
  const parts = [TRACE_LABELS[event.type], event.stage && TRACE_STAGES[event.stage], event.phase && ({ ice: 'ICE 路径', peer: '加密连接', gathering: '候选收集' })[event.phase], event.state && states[event.state], event.reason && TRACE_REASONS[event.reason]];
  if (event.step) parts.push(TRACE_RECHECK_STEPS[event.step]);
  if (event.result) parts.push(TRACE_RECHECK_RESULTS[event.result]);
  if (event.operation) parts.push(({ state: '状态查询', terminals: '终端管理', files: '文件传输', forward: '端口映射', access: '访问验证', desktop: '桌面控制', input: '输入通道', other: '节点接口' })[event.operation]);
  if (event.action) parts.push(({ ping: '服务探针', promote: '服务连接切换', activate: '启用通道', state: '状态查询', diagnostics: '连接诊断', files: '文件列表', 'file-delete': '删除文件', 'forward-list': '映射列表', clipboard: '剪贴板', paste: '粘贴', key: '按键', edit: '编辑', terminal: '终端输入', terminals: '终端列表', 'create-terminal': '新建终端', 'open-terminal': '打开终端' })[event.action]);
  if (event.status) parts.push(`HTTP ${event.status}`);
  if (event.route) parts.push(routes[event.route]);
  if (event.totalBytes !== undefined) parts.push(`已报告接收 ${event.loadedBytes || 0} / ${event.totalBytes} 字节`);
  if (event.windowChunks !== undefined) parts.push(`窗口 ${event.windowChunks} 块，分块确认 ${event.chunkAckMs || 0} ms（最长 ${event.chunkMaxAckMs || 0} ms），发送缓冲等待 ${event.bufferWaitMs || 0} ms，文件读取 ${event.fileReadMs || 0} ms`);
  if (event.outcome) parts.push(({ confirmed: '已确认完成', rejected: '请求被拒绝', unknown: '结果未知，不自动重试', canceled: '已取消' })[event.outcome]);
  if (event.attempt) parts.push(`第 ${event.attempt} 次尝试`);
  if (event.durationMs !== undefined) parts.push(`${event.durationMs} ms`);
  if (event.budgetMs !== undefined) parts.push(`最多等待 ${event.budgetMs} ms`);
  if (event.waitMs !== undefined) parts.push(`${event.waitMs} ms 后${event.waitMs > 1000 && event.time ? `（剩余 ${Math.max(0, Math.ceil((event.time + event.waitMs - now) / 1000))} 秒）` : ''}`);
  if (event.rttMs !== undefined) parts.push(`往返 ${event.rttMs} ms`);
  if (event.candidateMs !== undefined) parts.push(`候选评分 ${event.candidateMs} ms`);
  if (event.currentMs !== undefined) parts.push(`当前评分 ${event.currentMs} ms`);
  if (event.host !== undefined) parts.push(`本地候选 ${event.host} / NAT 候选 ${event.reflexive || 0} / TURN 候选 ${event.relay || 0}`);
  if (event.queuedBytes) parts.push(`排队 ${event.queuedBytes} 字节`);
  if (event.pendingInputs) parts.push(`待确认 ${event.pendingInputs} 项 / ${event.inputAgeMs || 0} ms`);
  return parts.filter(Boolean).join(' · ');
}
