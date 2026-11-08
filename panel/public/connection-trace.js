export const TRACE_LIMITS = Object.freeze({ events: 50, bytes: 16384 });
export const TRACE_LABELS = Object.freeze({
  'relay-start': '开始连接中转', 'relay-open': '中转握手完成', 'relay-ready': '中转认证完成',
  'direct-start': '开始探测直连', 'rtc-stage': '直连协商', 'direct-ready': '加密直连已就绪',
  'first-frame': '首屏准备完成', 'path-active': '数据通道已启用', 'path-lost': '通道已断开', 'retry': '等待重试',
  'heartbeat-timeout': '心跳未及时回复', 'network-change': '网络或前后台状态变化',
  'session-ended': '观看连接已结束', 'input-pressure': '输入队列达到上限',
});
export const TRACE_STAGES = Object.freeze({ gathering: '收集地址', signaling: '交换连接信息', connecting: '建立加密通道' });
const reasons = ['unsupported', 'disabled', 'signaling', 'negotiation', 'timeout', 'signaling-timeout', 'gathering-timeout', 'ice-timeout', 'channel-timeout',
  'connection', 'heartbeat', 'offline', 'hidden', 'online', 'visible', 'changed', 'busy', 'auth', 'target', 'protocol', 'closed', 'input-unknown', 'input-pressure', 'target-unknown', 'resume-timeout', 'session-expired', 'signal-failed'];
const number = value => Number.isInteger(value) && value >= 0 && value <= 2 ** 40;
function clean(value) {
  if (!value || !Object.hasOwn(TRACE_LABELS, value.type)) return null;
  const result = { type: value.type };
  if (['relay', 'direct'].includes(value.path)) result.path = value.path;
  if (Object.hasOwn(TRACE_STAGES, value.stage)) result.stage = value.stage;
  if (reasons.includes(value.reason)) result.reason = value.reason;
  for (const key of ['durationMs', 'waitMs', 'queuedBytes']) if (number(value[key])) result[key] = value[key];
  return result;
}
// No text, addresses, IDs, SDP or credentials cross this diagnostic interface.
export function createTraceReporter(frame) {
  return (type, detail = {}) => {
    const event = clean({ ...detail, type });
    if (event) parent.postMessage({ type: 'codex-network-event', frame, event }, location.origin);
  };
}
export function createConnectionTrace(now = () => performance.now()) {
  let events = [], start = now();
  const text = () => JSON.stringify({ version: 1, events });
  return {
    add(value, { mode, standby = false } = {}) {
      const event = clean(value);
      if (!event || !['desktop', 'terminal', 'service'].includes(mode)) return false;
      events.push({ atMs: Math.max(0, Math.round(now() - start)), mode, standby: standby === true, ...event });
      if (events.length > TRACE_LIMITS.events) events.shift();
      while (new TextEncoder().encode(text()).length > TRACE_LIMITS.bytes) events.shift();
      return true;
    },
    snapshot: () => events.map(event => ({ ...event })), text,
    clear() { events = []; start = now(); },
  };
}
