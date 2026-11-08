import { SHORTCUT_BY_KEY } from './shortcuts.js';

export const INPUT_NOTICE_LIMIT = 32;
const sources = ['assistant', 'stream', 'history'];
const paths = { direct: 'WebRTC 加密直连', terminal: '网页终端通道', https: 'HTTPS', relay: 'HTTPS / WebSocket 中转' };
const reasons = {
  timeout: '等待操作结果超时。', connection: '操作连接发生变化，未收到可确认的执行结果。',
  invalid_response: '服务响应不完整，无法确认执行结果。', result: '未收到可确认的执行结果。',
  previous: '状态轮询读取到执行服务保存的上一项未知结果。',
  'input-unknown': '连接变化时无法确认通道记录的序号或完整性。',
  'input-pressure': '发送缓冲达到数量或容量上限，已结束本次查看连接。',
};
const targetName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24) : '';
function describe(value, now) {
  if (!sources.includes(value.source) || typeof value.key !== 'string' || !/^[a-zA-Z0-9:._%-]{1,160}$/.test(value.key)) return null;
  const source = value.source, mode = value.mode === 'terminal' ? 'terminal' : 'desktop', standby = value.standby === true;
  const action = ['paste', 'key', 'terminal'].includes(value.action) ? value.action : 'input';
  const keyName = SHORTCUT_BY_KEY.has(value.keyName) ? value.keyName : '';
  const actionLabel = { paste: '粘贴', key: keyName ? `${keyName} 按键` : '按键', terminal: '打开终端', input: '输入' }[action];
  const reason = Object.hasOwn(reasons, value.reason) ? value.reason : 'result';
  const target = targetName(value.target), path = Object.hasOwn(paths, value.path) ? value.path : '';
  const origin = source === 'stream' ? `${standby ? '后台' : ''}${mode === 'terminal' ? '网页终端' : '桌面'}` : source === 'history' ? '桌面执行服务' : '输入助手';
  const summary = source === 'stream' ? reason === 'input-pressure' ? '发送缓冲达到上限，部分通道数据结果未知' : '连接变化后部分通道数据结果未知'
    : `${source === 'history' ? '上一项' : ''}${actionLabel}结果未知`;
  const protocol = source !== 'stream' ? '' : mode === 'terminal' ? ' 通道记录可能包含按键、尺寸调整、心跳或终端协议消息，无法据此判断提示词或 Enter 是否执行。' : ' 通道记录可能包含画面协议、指针或按键消息，无法据此判断某次操作是否执行。';
  return { key: value.key, source, mode, standby, action, reason, path, target, at: now,
    message: `${origin}${target ? ` · ${target}` : ''}：${summary}；请核对画面，不会自动重发。`,
    detail: `${reasons[reason]}${protocol}${path ? ` 当时路径：${paths[path]}。` : ''}`, dismissed: false };
}

// Only fixed metadata and a short terminal name are retained, never input text,
// exception messages or credentials. At most 32 records, only for this page.
export function createInputNotices(now = () => Date.now()) {
  let records = [], activeKey = '';
  return {
    add(value, { activate = true } = {}) {
      const existing = records.find(record => record.key === value.key);
      if (existing) return { ...existing };
      const record = describe(value, now()); if (!record) return null;
      records.push(record); if (records.length > INPUT_NOTICE_LIMIT) records.shift();
      if (activate) activeKey = record.key;
      return { ...record };
    },
    activate(key) { const record = records.find(record => record.key === key); if (record && !record.dismissed) activeKey = key; },
    dismiss(key) { const record = records.find(record => record.key === key); if (record) record.dismissed = true; },
    get current() { const record = records.find(record => record.key === activeKey); return record && !record.dismissed ? { ...record } : null; },
    snapshot: () => records.map(record => ({ ...record })),
    clear() { records = []; activeKey = ''; },
  };
}
