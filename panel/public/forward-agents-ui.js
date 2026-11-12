import { rtcDirectLabel } from './rtc-stats.js';
import { rtcHints } from './rtc-hints.js';
import { reverseForwardPrompt, FORWARD_PROMPT_LIMIT } from './forward-prompt.js';
import { entryURL } from './entry-path.js';
import { nodeIdentity } from './node-scope.js';
import { FORWARD_TYPES, forwardRuleType, forwardRuleDefaults, forwardRuleName } from './forward-rule-form.js';
const states = { active: '已生效', pending: '等待规则通道', connecting: '正在建立映射', recovering: '规则通道恢复中', disabled: '已停用', failed: '未生效', offline: '等待助手上线', starting: '正在下发' };
const mask = prefix => Array.from({ length: 4 }, (_, i) => Math.max(0, Math.min(255, 256 - 2 ** Math.max(0, 8 - Math.max(0, prefix - i * 8))))).join('.');
const endpoint = c => c.serial ? `${c.serial.path} @ ${c.serial.baud}` : `${c.targetHost.includes(':') ? '[' + c.targetHost + ']' : c.targetHost}:${c.targetPort}`;
const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };

export function createForwardAgentsUI({ api, allowed, canManage = () => true, visible, hints }) {
  const $ = id => document.getElementById(id), editor = $('forward-rule-dialog'), confirmation = $('forward-agent-confirm');
  let agents = [], selectedId = '', selectedSlot = 1, generation = 0, reading, pending, keyRequest, keyRevision = 0, policy = null, edit = null, confirming = null;
  let inventorySignature = '', layoutFrame = 0, rowsAgent = '', permitted = false, managing = false, statusKnown = false, keyCopyAttempt = null;
  const rows = new Map(), tabs = [];
  const live = () => allowed() && visible(), selected = () => agents.find(a => a.id === selectedId);
  const message = text => { $('forward-agent-status').textContent = text; };
  const currentRule = id => selected()?.rules.find(r => r.id === id);
  const busy = () => !!pending;
  function clearKey() { keyCopyAttempt = null; keyRevision = 0; keyRequest?.abort(); keyRequest = null; $('forward-agent-key').value = ''; }
  function update() {
    if (!allowed() && permitted || permitted && managing !== !!canManage()) reset();
    permitted = !!allowed(); managing = !!canManage();
    $('forward-agent-section').hidden = !permitted || !managing && !agents.length; $('forward-permission').hidden = permitted;
    $('forward-agent-section').setAttribute('aria-label', managing ? '助手管理' : '可查看的助手 key');
    for (const id of ['forward-agent-rekey', 'forward-agent-key-visibility', 'forward-rules-heading', 'forward-agent-rules', 'forward-agent-inventory', 'forward-diagnostics-copy']) $(id).hidden = !managing;
    $('forward-agent-key-refresh').hidden = managing; $('forward-agent-key-readonly').hidden = managing;
    const agent = selected();
    for (const id of ['forward-rule-add', 'forward-agent-rekey', 'forward-agent-inventory-refresh', 'forward-agent-temporary-key-visible']) $(id).disabled = !permitted || !managing || busy() || !agent || id === 'forward-agent-inventory-refresh' && (!statusKnown || !agent.online);
    $('forward-agent-key-copy').disabled = !permitted || busy() || !agent || !$('forward-agent-key').value;
    $('forward-agent-key-refresh').disabled = !permitted || busy() || !agent || !!keyRequest;
    for (const tab of tabs) tab.disabled = !permitted || busy();
    $('forward-agent-overflow').disabled = !permitted || busy();
    for (const row of rows.values()) for (const button of row.root.querySelectorAll('button')) button.disabled = !permitted || busy();
    if (editor.open) {
      refreshDraftDefaults();
      const stale = edit?.rule && currentRule(edit.rule.id)?.revision !== edit.rule.revision;
      $('forward-create').disabled = !permitted || busy() || !!stale || !policy;
      for (const control of editor.querySelectorAll('input,select')) control.disabled = busy();
      if (stale) $('forward-rule-error').textContent = '规则已被其他页面修改或删除，请关闭后重新编辑。当前填写内容未提交。';
      renderDirection();
    }
  }
  function layout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0; measureLayout();
    });
  }
  function measureLayout() {
  if (!live()) return;
  const bar = $('forward-agent-bar'), more = $('forward-agent-overflow'), gap = 6;
  const focused = document.activeElement;
  const availableTabs = tabs.filter(tab => agents.some(a => a.slot === Number(tab.dataset.slot)));
  tabs.forEach(tab => { tab.hidden = !availableTabs.includes(tab); }); more.hidden = true;
  const widths = availableTabs.map(tab => tab.getBoundingClientRect().width), available = bar.clientWidth;
  let hidden = [];
  if (widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, availableTabs.length - 1) > available + 1) {
    more.hidden = false; let used = 0, fits = true;
    const room = Math.max(0, available - more.getBoundingClientRect().width - gap);
    for (const [i, tab] of availableTabs.entries()) { used += widths[i] + (i ? gap : 0); fits &&= used <= room + 1; tab.hidden = !fits; if (tab.hidden) hidden.push(Number(tab.dataset.slot)); }
  }
  const signature = hidden.join(',') + ':' + selectedSlot;
  if (more.dataset.signature !== signature) {
    more.dataset.signature = signature;
    more.replaceChildren(new Option('更多助手', ''), ...hidden.map(slot => new Option('助手' + slot, String(slot))));
    more.value = hidden.includes(selectedSlot) ? String(selectedSlot) : '';
  }
  more.dataset.active = String(hidden.includes(selectedSlot));
  more.setAttribute('aria-label', '更多助手' + (hidden.includes(selectedSlot) ? '，当前助手' + selectedSlot : ''));
  let first = tabs.find(tab => !tab.hidden);
  for (const [i, tab] of tabs.entries()) tab.tabIndex = !tab.hidden && i + 1 === selectedSlot ? 0 : -1;
  if (!tabs.some(tab => tab.tabIndex === 0) && first) first.tabIndex = 0;
  if (focused && tabs.includes(focused) && focused.hidden) more.focus({ preventScroll: true });
  }
  new ResizeObserver(layout).observe($('forward-agent-bar'));
  for (let slot = 1; slot <= 8; slot++) {
    const tab = node('button', '助手' + slot, 'forward-agent-tab'); tab.type = 'button'; tab.id = 'forward-agent-tab-' + slot;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'forward-agent-panel'); tab.dataset.slot = String(slot);
    tab.addEventListener('click', () => choose(slot));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const slots = agents.map(agent => agent.slot), index = slots.indexOf(slot); if (index < 0 || !slots.length) return;
      event.preventDefault(); const next = event.key === 'Home' ? slots[0] : event.key === 'End' ? slots.at(-1) : slots[(index + (event.key === 'ArrowRight' ? 1 : slots.length - 1)) % slots.length];
      choose(next); (tabs[next - 1].hidden ? $('forward-agent-overflow') : tabs[next - 1]).focus({ preventScroll: true });
    });
    tabs.push(tab); $('forward-agent-tabs').append(tab);
  }
  $('forward-agent-overflow').addEventListener('change', () => { const value = Number($('forward-agent-overflow').value); if (value) choose(value); });
  function choose(slot) {
    if (!live() || busy()) return;
    const agent = agents.find(a => a.slot === slot); if (!agent) return;
    selectedSlot = slot; if (selectedId !== agent.id) { selectedId = agent.id; clearKey(); inventorySignature = ''; $('forward-agent-inventory').open = false; message(''); }
    render(); update(); void loadKey();
  }
  async function loadKey() {
    const agent = selected(); if (!agent || !live() || keyRequest || agent.keyRevision === keyRevision) return;
    const epoch = generation, id = agent.id, request = keyRequest = new AbortController(), timeout = setTimeout(() => request.abort(), 8000);
    $('forward-agent-key').value = '';
    try {
      const value = await api('/api/forward/agents/key?id=' + id, { signal: request.signal });
      if (epoch !== generation || id !== selectedId || !live()) return;
      if (value.id !== id || !Number.isSafeInteger(value.revision) || typeof value.key !== 'string' || !value.key.startsWith('COCA2.') || value.key.length > 2048) throw Error('助手 key 响应无效');
      keyRevision = value.revision; $('forward-agent-key').value = value.key;
    } catch (error) { if (epoch === generation && id === selectedId && live() && !request.signal.aborted) message(error.message); }
    finally { clearTimeout(timeout); if (keyRequest === request) keyRequest = null; update(); }
  }
  async function refresh() {
    if (!live() || pending || reading) return;
    const epoch = generation, request = reading = new AbortController(), timeout = setTimeout(() => request.abort(), 8000);
    try {
      const value = await api('/api/forward/agents', { signal: request.signal });
      if (epoch !== generation || !live()) return;
      if (value.protocol !== 2 || !Array.isArray(value.agents) || value.agents.length > 8 || value.agents.some(a => !Number.isInteger(a.slot) || a.slot < 1 || a.slot > 8 || a.name !== '助手' + a.slot) || new Set(value.agents.map(a => a.slot)).size !== value.agents.length || (canManage() ? value.agents.length !== 8 || value.agents.some((a, i) => a.slot !== i + 1) : value.readOnly !== true)) throw Error('固定助手配置无效，请检查节点版本');
      agents = value.agents; statusKnown = true;
      const agent = agents.find(a => a.slot === selectedSlot) || agents[0];
      if (selectedId !== (agent?.id || '')) { selectedId = agent?.id || ''; selectedSlot = agent?.slot || 1; clearKey(); }
      update(); render(); void loadKey();
    } catch (error) {
      if (epoch === generation && reading === request && live()) {
        statusKnown = false; render(); update();
        message(request.signal.aborted ? '助手状态更新超时，请刷新列表确认。' : error.message);
      }
    }
    finally { clearTimeout(timeout); if (reading === request) reading = null; }
  }
  async function mutate(path, body) {
    if (!live() || !canManage() || pending) return null;
    reading?.abort(); reading = null;
    const epoch = generation, id = selectedId, request = pending = new AbortController(), timeout = setTimeout(() => request.abort(), 8000); update();
    try {
      const value = await api('/api/forward/agents/' + path, { method: 'POST', body, signal: request.signal });
      return epoch === generation && selectedId === id && live() ? value : null;
    } catch (error) {
      if (epoch === generation && live()) {
        const text = error.outcome === 'rejected' ? error.message : '结果未确认，请刷新列表核对；不会自动重试。'; message(text); if (editor.open) { $('forward-rule-error').textContent = text; $('forward-rule-error').focus(); }
      }
      return null;
    } finally { clearTimeout(timeout); if (pending === request) pending = null; update(); }
  }
  function confirm(title, description, action, accept = '确认') {
    if (!live() || busy()) return;
    confirming = action; $('forward-agent-confirm-title').textContent = title; $('forward-agent-confirm-description').textContent = description;
    $('forward-agent-confirm-accept').textContent = accept;
    confirmation.showModal(); $('forward-agent-confirm-cancel').focus({ preventScroll: true });
  }
  function closeConfirm() { confirming = null; if (confirmation.open) confirmation.close(); }
  $('forward-agent-confirm-cancel').addEventListener('click', closeConfirm);
  confirmation.addEventListener('close', () => { confirming = null; });
  confirmation.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target !== $('forward-agent-confirm-accept')) { event.preventDefault(); closeConfirm(); } });
  $('forward-agent-confirm-accept').addEventListener('click', async () => { const action = confirming; closeConfirm(); if (action && live()) { await action(); await refresh(); } });
  $('forward-agent-rekey').addEventListener('click', () => {
    const agent = selected(); if (!agent || !canManage()) return;
    confirm('重新生成' + agent.name + '的 key', '旧 key 立即失效，该助手及其映射连接将断开；规则保留。其他助手不受影响。', async () => {
      clearKey(); await mutate('rekey', { id: agent.id, revision: agent.keyRevision });
    }, '重新生成并断开');
  });
  $('forward-agent-key-refresh').addEventListener('click', () => { if (live() && !canManage() && !keyRequest) { clearKey(); void loadKey(); } });
  $('forward-agent-temporary-key-visible').addEventListener('change', async () => {
    const agent = selected(); if (!agent || !live() || !canManage()) return;
    const visible = $('forward-agent-temporary-key-visible').checked;
    const result = await mutate('visibility', { id: agent.id, revision: agent.visibilityRevision, visible });
    if (result && typeof result.visible === 'boolean' && Number.isSafeInteger(result.revision) && result.visible === visible) {
      agent.temporaryKeyVisible = result.visible; agent.visibilityRevision = result.revision;
      message(visible ? '临时账号现在可查看和复制此助手的 key。' : '已关闭临时账号对此助手 key 的查看权限。');
    } else if (result) message('设置响应不完整，请刷新列表核对；不会自动重试。');
    render(); update();
    await refresh();
  });
  $('forward-agent-key-copy').addEventListener('click', async () => {
    const key = $('forward-agent-key').value, epoch = generation, agentId = selectedId; if (!key || !live()) return;
    const attempt = keyCopyAttempt = {};
    const current = () => epoch === generation && agentId === selectedId && keyCopyAttempt === attempt && live() && key === $('forward-agent-key').value;
    try { await navigator.clipboard.writeText(key); if (current()) message('key 已复制。请在对应电脑的助手窗口粘贴。'); }
    catch { if (current()) { $('forward-agent-key').focus(); $('forward-agent-key').select(); message('请手动复制已选中的 key。'); } }
  });
  $('forward-agent-inventory-refresh').addEventListener('click', async () => { const agent = selected(); if (agent && await mutate('inventory', { id: agent.id })) message('已请求刷新设备信息。'); });
  function renderDirection() {
    const reverse = $('forward-direction').value === 'reverse', serial = reverse && $('forward-protocol').value === 'serial';
    $('forward-protocol').querySelector('option[value="serial"]').disabled = !reverse;
    $('forward-serial-fields').hidden = !serial; $('forward-serial-fields').disabled = !serial || busy(); $('forward-serial-choice-label').hidden = !serial;
    for (const id of ['forward-host', 'forward-target']) { $(id).closest('label').hidden = serial; $(id).disabled = serial || busy(); }
    $('forward-local-label').textContent = reverse ? '节点主机监听端口' : '助手电脑监听端口';
    $('forward-target-label').textContent = reverse ? '目标 IP（助手侧）' : '目标 IP（节点侧）';
    $('forward-target-note').textContent = serial ? '在节点主机连接监听端口，访问该助手电脑上的串口；客户端接入后才打开串口。' : reverse ? '在节点主机连接监听端口，访问助手电脑可达的目标 IP。目标填写 127.0.0.1 时指助手电脑自身。' : '在助手电脑连接监听端口，访问节点主机可达的目标 IP。目标填写 127.0.0.1 时指节点主机自身。';
    $('forward-port-policy').textContent = policy?.allPorts ? 'TCP 目标端口：允许所有非管理端口。' : 'TCP 目标端口：' + (policy?.ports?.join('、') || '已禁用；串口不受此限制。');
    $('forward-port-policy').hidden = serial || !!policy?.allPorts;
    const saveLabel = busy() ? '正在保存…' : !statusKnown || !selected()?.online || !$('forward-rule-enabled').checked ? '保存规则' : '保存并应用';
    // WebKit cancels a pressed button's click if input blur replaces its text.
    if ($('forward-create').textContent !== saveLabel) $('forward-create').textContent = saveLabel;
    $('forward-rule-effect').textContent = !$('forward-rule-enabled').checked ? '保存为停用规则，暂不建立映射。' : !statusKnown ? '助手状态未确认。规则会保存，助手接入后自动应用。' : !selected()?.online ? '助手当前离线。规则会保存，接入后自动应用。' : edit?.rule ? '保存将重建这一条规则，关闭它的现有连接；其他规则继续运行。' : '保存后自动下发给' + (selected()?.name || '助手') + '。';
    const local = $('forward-local').value || '监听端口', host = $('forward-host').value.trim() || '目标 IP', target = $('forward-target').value || '目标端口';
    const destination = serial ? ($('forward-serial-path').value.trim() || '选择或填写串口') + ' @ ' + $('forward-serial-baud').value : (host.includes(':') ? '[' + host + ']' : host) + ':' + target;
    $('forward-rule-preview').textContent = (reverse ? '节点主机' : '助手电脑（' + (selected()?.name || '助手') + '）') + ' 127.0.0.1:' + local + ' → ' + (reverse ? '助手侧' + (serial ? '串口' : '网络') + '（' + (selected()?.name || '助手') + '） ' : '节点侧网络 ') + destination;
    const hintsLabel = $('forward-server-ip').value.trim() || $('forward-helper-ip').value.trim() ? '已设置' : '自动探测';
    if ($('forward-hints-summary').textContent !== hintsLabel) $('forward-hints-summary').textContent = hintsLabel;
  }
  function openEditor(rule = null) {
    const agent = selected(); if (!agent || !live() || busy()) return;
    const c = rule?.config || {}, reverse = rule ? c.direction === 'reverse' : true;
    edit = { agentId: agent.id, rule, autoPort: !rule, autoName: !rule, serverHint: rule ? c.hints?.server || '' : hints().server || '' };
    $('forward-form').reset(); $('forward-rule-name').value = rule?.name || ''; $('forward-rule-enabled').checked = rule ? rule.enabled : true;
    $('forward-direction').value = reverse ? 'reverse' : 'forward'; $('forward-protocol').value = rule ? forwardRuleType(c) : 'ssh';
    $('forward-local').value = c.localPort || (reverse ? 22001 : 2222); $('forward-host').value = c.targetHost || '127.0.0.1'; $('forward-target').value = c.targetPort || 22;
    $('forward-server-ip').value = edit.serverHint;
    $('forward-helper-ip').value = rule ? c.hints?.browser || '' : hints().browser || '';
    const serial = c.serial || { path: '', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false };
    for (const [field, value] of Object.entries({ path: serial.path, baud: serial.baud, bits: serial.dataBits, parity: serial.parity, stop: serial.stopBits })) $('forward-serial-' + field).value = value;
    $('forward-serial-dtr').checked = serial.dtr; $('forward-serial-rts').checked = serial.rts;
    serialOptions(); $('forward-rule-error').textContent = ''; $('forward-rule-title').textContent = agent.name + (rule ? ' · 编辑规则' : ' · 新增规则');
    $('forward-rule-advanced').open = false;
    editor.showModal(); update(); edit.initial = draftValues(); $('forward-rule-name').focus(); $('forward-rule-name').select();
  }
  function refreshDraftDefaults() {
    if (!edit || edit.rule) return;
    const pristine = edit.initial === draftValues(), next = forwardRuleDefaults(agents, edit.agentId, $('forward-direction').value, $('forward-protocol').value, policy || {});
    if (edit.autoPort && $('forward-local').value !== String(next.localPort ?? '')) $('forward-local').value = next.localPort ?? '';
    if (edit.autoName) {
      const named = edit.autoPort ? next.name : forwardRuleName(agents, edit.agentId, $('forward-protocol').value, $('forward-local').value);
      if ($('forward-rule-name').value !== named) $('forward-rule-name').value = named;
    }
    if (pristine) edit.initial = draftValues();
  }
  function draftValues() {
    const reverse = $('forward-direction').value === 'reverse', serial = reverse && $('forward-protocol').value === 'serial';
    const fields = ['rule-name', 'rule-enabled', 'direction', 'local', 'server-ip', 'helper-ip'];
    fields.push('protocol');
    fields.push(...(serial ? ['serial-path', 'serial-baud', 'serial-bits', 'serial-parity', 'serial-stop', 'serial-dtr', 'serial-rts'] : ['host', 'target']));
    return JSON.stringify(fields.map(id => { const n = $('forward-' + id); return [id, n.type === 'checkbox' ? n.checked : n.value]; }));
  }
  function closeEditor(force = false) {
    if (busy()) return;
    if (!force && edit && draftValues() !== edit.initial) {
      confirm('放弃当前填写内容？', '仅关闭当前表单，不会再次提交。已保存的规则不受影响。', () => closeEditor(true), '放弃填写'); return;
    }
    if (editor.open) editor.close();
  }
  $('forward-rule-add').addEventListener('click', () => openEditor());
  $('forward-rule-close').addEventListener('click', () => closeEditor()); $('forward-rule-cancel').addEventListener('click', () => closeEditor());
  editor.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
  editor.addEventListener('close', () => { edit = null; $('forward-form').reset(); $('forward-rule-error').textContent = ''; });
  $('forward-rule-name').addEventListener('input', () => { if (edit) edit.autoName = false; });
  $('forward-local').addEventListener('input', () => { if (edit) edit.autoPort = false; refreshDraftDefaults(); });
  $('forward-direction').addEventListener('change', () => {
    if ($('forward-direction').value === 'forward' && $('forward-protocol').value === 'serial') $('forward-protocol').value = 'tcp';
    refreshDraftDefaults(); renderDirection();
  });
  $('forward-protocol').addEventListener('change', () => {
    const port = FORWARD_TYPES[$('forward-protocol').value].port;
    if (port) $('forward-target').value = port;
    refreshDraftDefaults(); renderDirection();
  });
  $('forward-serial-choice').addEventListener('change', () => { if ($('forward-serial-choice').value) $('forward-serial-path').value = $('forward-serial-choice').value; });
  $('forward-serial-path').addEventListener('input', () => { $('forward-serial-choice').value = selected()?.inventory?.serialPorts.includes($('forward-serial-path').value) ? $('forward-serial-path').value : ''; });
  function serialOptions() {
    const ports = selected()?.inventory?.serialPorts || [], select = $('forward-serial-choice'), path = $('forward-serial-path').value;
    if (select.dataset.ports !== JSON.stringify(ports)) { select.dataset.ports = JSON.stringify(ports); select.replaceChildren(new Option('从列表选择，或手动填写', ''), ...ports.map(p => new Option(p, p))); }
    select.value = ports.includes(path) ? path : '';
  }
  $('forward-form').addEventListener('input', renderDirection);
  $('forward-form').addEventListener('change', renderDirection);
  $('forward-form').addEventListener('invalid', event => { if ($('forward-rule-advanced').contains(event.target)) $('forward-rule-advanced').open = true; }, true);
  $('forward-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!edit || !live() || busy()) return;
    if (edit.rule && currentRule(edit.rule.id)?.revision !== edit.rule.revision) { update(); return; }
    const reverse = $('forward-direction').value === 'reverse', serial = reverse && $('forward-protocol').value === 'serial';
    let config = { localPort: Number($('forward-local').value), protocol: $('forward-protocol').value };
    try {
      config.hints = rtcHints({ server: $('forward-server-ip').value.trim(), browser: $('forward-helper-ip').value.trim() });
      if (reverse) Object.assign(config, { direction: 'reverse', deviceName: $('forward-rule-name').value.trim() });
      if (serial) config.serial = { path: $('forward-serial-path').value.trim(), baud: Number($('forward-serial-baud').value), dataBits: Number($('forward-serial-bits').value), parity: $('forward-serial-parity').value, stopBits: Number($('forward-serial-stop').value), dtr: $('forward-serial-dtr').checked, rts: $('forward-serial-rts').checked };
      else Object.assign(config, { targetHost: $('forward-host').value.trim(), targetPort: Number($('forward-target').value) });
    } catch (error) { $('forward-rule-advanced').open = true; $('forward-rule-error').textContent = error.message; $('forward-rule-error').focus(); return; }
    // A submitted draft is now explicit intent. Keep it intact if the reply is
    // lost; a later list refresh must not turn it into a different new rule.
    edit.autoPort = false; edit.autoName = false;
    const draft = edit, result = await mutate('rule', { agentId: edit.agentId, ...(edit.rule ? { id: edit.rule.id, revision: edit.rule.revision } : {}), name: $('forward-rule-name').value.trim(), enabled: $('forward-rule-enabled').checked, config });
    if (result && edit === draft) { closeEditor(true); message(!result.enabled ? '规则已保存，当前停用。' : selected()?.online ? '规则已保存，应用结果见规则状态。' : '规则已保存，等待助手接入后自动应用。'); }
    await refresh();
  });
  function button(text, action) { const b = node('button', text, 'secondary'); b.type = 'button'; b.addEventListener('click', action); return b; }
  function render() {
    const agent = selected(); if (!agent) return;
    $('forward-agent-panel').setAttribute('aria-labelledby', 'forward-agent-tab-' + agent.slot);
    $('forward-agent-panel').dataset.agentId = agent.id; $('forward-agent-heading').textContent = agent.name; $('forward-agent-key-label').textContent = agent.name + '授权 key';
    for (const [i, tab] of tabs.entries()) { const item = agents.find(a => a.slot === i + 1); tab.setAttribute('aria-selected', String(i + 1 === agent.slot)); tab.dataset.online = statusKnown ? String(!!item?.online) : 'unknown'; tab.dataset.readonly = String(!canManage()); tab.title = '助手' + (i + 1) + (canManage() ? !statusKnown ? ' · 状态未确认' : item?.online ? ' · 在线' : ' · 离线' : ''); }
    $('forward-agent-connection').hidden = !canManage();
    if (!canManage()) { $('forward-agent-network').hidden = true; measureLayout(); return; }
    $('forward-agent-temporary-key-visible').checked = agent.temporaryKeyVisible === true;
    $('forward-agent-connection').textContent = !statusKnown ? '助手状态未确认' : agent.online ? '助手在线' : '助手离线';
    $('forward-agent-connection').dataset.online = statusKnown ? String(agent.online) : 'unknown';
    $('forward-rule-count').textContent = agent.rules.length + ' / 16';
    const active = agent.rules.filter(r => r.mapping?.state === 'active'), directReady = active.filter(r => r.mapping.direct.available).length;
    const direct = agent.rules.reduce((n, r) => n + (r.mapping?.directConnections || 0), 0), total = agent.rules.reduce((n, r) => n + (r.mapping?.connections || 0), 0);
    $('forward-agent-network').textContent = !statusKnown ? '连接状态未更新，以下为上次读取的规则信息。' : `已有数据连接：直连 ${direct} / 中转 ${total - direct}。` + (active.length ? `新连接：${directReady} 条规则优先直连，${active.length - directReady} 条规则走中转。` : '尚无可建立新连接的规则。');
    $('forward-agent-network').hidden = !agent.rules.length;
    const signature = JSON.stringify([agent.id, statusKnown, agent.online, agent.inventory]);
    if (signature !== inventorySignature) {
      inventorySignature = signature; const target = $('forward-agent-inventory-body'), info = agent.inventory; target.replaceChildren();
      $('forward-agent-inventory-title').textContent = info ? `网卡 ${info.interfaces.length} 张 · 串口 ${info.serialPorts.length} 个` : '网卡和串口信息';
      if (!info) target.append(node('p', '等待助手上报设备信息。', 'muted'));
      else {
        target.append(node('p', '更新时间：' + new Date(info.updatedAt).toLocaleString() + (!statusKnown ? '；状态未确认，仅为最后一次信息。' : !agent.online ? '；离线，仅为最后一次信息。' : '') + (info.truncated ? '；信息超出上限，已截断。' : '') + (info.error ? '；部分设备信息读取失败，可手动填写串口。' : ''), 'muted'));
        for (const iface of info.interfaces) target.append(node('p', `${iface.name}（${iface.up ? '启用' : '停用'}）：` + (iface.addresses.map(ip => `${ip.address}/${ip.prefix}（${mask(ip.prefix)}）`).join('、') || (iface.error ? '地址读取失败' : '无 IPv4 地址')), 'muted'));
        target.append(node('p', '串口：' + (info.serialPorts.join('、') || '未发现，可手动填写。'), 'muted'));
      }
    }
    if (editor.open) serialOptions();
    if (rowsAgent !== agent.id) { rowsAgent = agent.id; rows.clear(); $('forward-agent-rules').replaceChildren(); }
    for (const [id, row] of rows) if (!agent.rules.some(r => r.id === id)) { row.root.remove(); rows.delete(id); }
    for (const rule of agent.rules) {
      let row = rows.get(rule.id);
      if (!row) {
        const root = node('article', '', 'forward-agent-rule'); root.dataset.ruleId = rule.id;
        const heading = node('div', '', 'forward-rule-heading'), title = node('strong'), badge = node('span', '', 'forward-rule-state'), detail = node('p', '', 'forward-rule-path'), state = node('p', '', 'forward-rule-note'), transport = node('p', '', 'muted'), actions = node('div', '', 'forward-agent-actions');
        heading.append(title, badge);
        const toggle = button('停用规则', async () => {
          const value = currentRule(rule.id); if (!value) return;
          const operation = async () => { await mutate('rule', { agentId: selectedId, id: value.id, revision: value.revision, name: value.name, config: value.config, enabled: !value.enabled }); await refresh(); };
          if (value.enabled) confirm('停用“' + value.name + '”', '关闭这一条规则及其现有连接，其他规则继续运行。', operation, '停用规则'); else await operation();
        });
        const remove = button('删除规则', () => {
          const value = currentRule(rule.id); if (value) confirm('删除“' + value.name + '”', '删除这一条规则并关闭其现有连接，其他规则不受影响。', async () => { await mutate('rule/remove', { agentId: selectedId, id: value.id, revision: value.revision }); }, '删除规则');
        });
        toggle.className = 'quiet'; remove.className = 'quiet forward-danger forward-rule-remove';
        const copyText = node('textarea', '', 'forward-copy-text'); copyText.hidden = true; copyText.readOnly = true; copyText.rows = 10; copyText.maxLength = FORWARD_PROMPT_LIMIT;
        const copy = button('复制连接信息', async () => {
          const value = currentRule(rule.id); if (!value || !live() || !canManage()) return;
          const attempt = {}; row.copyAttempt = attempt;
          const epoch = generation, agentId = selectedId, reverse = value.config.direction === 'reverse';
          const c = value.config, address = '127.0.0.1:' + c.localPort;
          const command = c.serial ? 'nc 127.0.0.1 ' + c.localPort : c.protocol === 'ssh' ? 'ssh -o HostKeyAlias=codex-cloud-' + value.id + ' -p ' + c.localPort + ' USER@127.0.0.1' : c.protocol === 'telnet' ? 'telnet 127.0.0.1 ' + c.localPort : address;
          const text = reverse ? reverseForwardPrompt(value, selected(), { statusKnown, nodeURL: entryURL('/').href, nodeId: nodeIdentity() }) : `${value.name}\n连接位置：助手电脑（${selected()?.name || '助手'}）\n连接地址：${address}\n目标：节点侧网络 ${endpoint(c)}\n${command}`;
          const current = () => epoch === generation && agentId === selectedId && rows.get(value.id) === row && row.copyAttempt === attempt && live() && canManage() && currentRule(value.id)?.revision === value.revision;
          copyText.value = ''; copyText.hidden = true;
          try { await navigator.clipboard.writeText(text); if (current()) message(reverse ? 'AI 提示词已复制，可直接粘贴给 AI；不含 key 或密码。' : '连接信息已复制，不含 key 或密码。'); }
          catch { if (current()) { row.copyRevision = value.revision; copyText.value = text; copyText.hidden = false; copyText.focus(); copyText.select(); message('剪贴板不可用，请手动复制已选中的' + (reverse ? ' AI 提示词。' : '连接信息。')); } }
        });
        actions.append(copy, button('编辑规则', () => { const value = currentRule(rule.id); if (value) openEditor(value); }), toggle, remove);
        root.append(heading, detail, state, transport, actions, copyText); $('forward-agent-rules').append(root); row = { root, title, badge, detail, state, transport, toggle, copy, copyText }; rows.set(rule.id, row);
      }
      const copyLabel = rule.config.direction === 'reverse' ? '复制 AI 提示词' : '复制连接信息'; if (row.copy.textContent !== copyLabel) row.copy.textContent = copyLabel;
      row.copyText.setAttribute('aria-label', rule.name + (rule.config.direction === 'reverse' ? '的 AI 提示词' : '的连接信息'));
      if (row.copyRevision !== rule.revision) { row.copyText.value = ''; row.copyText.hidden = true; }
      row.title.textContent = rule.name; row.root.setAttribute('aria-label', rule.name);
      row.detail.textContent = (rule.config.direction === 'reverse' ? '节点主机' : '助手电脑（' + agent.name + '）') + ` 127.0.0.1:${rule.config.localPort} → ` + (rule.config.direction === 'reverse' ? '助手侧' + (rule.config.serial ? '串口' : '网络') + '（' + agent.name + '） ' : '节点侧网络 ') + endpoint(rule.config);
      const m = rule.mapping, p = m?.direct;
      row.badge.textContent = rule.error || m?.error ? '需要检查' : states[rule.state] || '等待状态'; row.badge.dataset.state = rule.error || m?.error ? 'warning' : rule.state;
      row.state.textContent = rule.error || (m?.error ? '最近连接错误：' + m.error : m?.state === 'active' ? m.targetStatus?.state === 'reachable' ? '目标最近连接成功' : '监听已就绪，目标尚未连接验证。' : ''); row.state.hidden = !row.state.textContent; row.state.dataset.error = String(!!(rule.error || m?.error));
      const toggleLabel = rule.enabled ? '停用规则' : '启用规则'; if (row.toggle.textContent !== toggleLabel) row.toggle.textContent = toggleLabel;
      row.transport.textContent = !m ? '数据通道尚未建立' : (m.state === 'active' ? p.available ? `新连接：${p.family || 'IP'} / UDP 加密直连${rtcDirectLabel(p.route) ? '（' + rtcDirectLabel(p.route) + '）' : ''}${Number.isFinite(p.rttMs) ? ' · ' + p.rttMs + ' ms' : ''}` : '新连接：WSS 加密中转' : '新连接暂停') + `；已有：直连 ${m.directConnections} / 中转 ${m.connections - m.directConnections}`;
    }
    $('forward-agent-rules').querySelector('.forward-rule-empty')?.remove();
    if (!agent.rules.length) { const empty = node('div', '', 'forward-rule-empty'); empty.append(node('strong', '尚无规则，为' + agent.name + '添加第一条映射。'), node('p', '点击“新增规则”，选择访问方向并填写目标。助手离线时也可保存，上线后自动应用。', 'muted')); $('forward-agent-rules').append(empty); }
    measureLayout();
  }
  function report() {
    if (!live() || !canManage()) return '';
    const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const lines = ['Codex Cloud 助手诊断 v2', '地址、端口、网卡名、串口路径、规则名称、标识和 key 均已省略。'];
    for (const agent of agents) {
      lines.push(`${agent.name}：${!statusKnown ? '控制状态未确认' : agent.online ? '控制在线' : '控制离线'}；规则 ${agent.rules.length}`);
      for (const [i, r] of agent.rules.entries()) lines.push(`规则 ${i + 1}：${states[r.state] || '未知'}；${r.mapping?.state === 'active' ? r.mapping.direct.available ? '新连接 直连' : '新连接 中转' : '新连接 暂停'}；已有直连 ${number(r.mapping?.directConnections)} / 总连接 ${number(r.mapping?.connections)}；RTT ms ${number(r.mapping?.direct.rttMs)}`);
    }
    return lines.join('\n').slice(0, 24000);
  }
  $('forward-diagnostics-copy').addEventListener('click', async () => {
    const text = report(), epoch = generation; if (!text) return;
    $('forward-diagnostics').hidden = false; $('forward-diagnostics-text').value = text;
    try { await navigator.clipboard.writeText(text); if (epoch === generation && live()) message('脱敏诊断报告已复制。'); }
    catch { if (epoch === generation && live()) { $('forward-diagnostics-text').focus(); $('forward-diagnostics-text').select(); } }
  });
  function suspend() {
    generation++; reading?.abort(); reading = null;
    for (const row of rows.values()) { row.copyText.value = ''; row.copyText.hidden = true; }
    statusKnown = false; render();
    const writing = pending; pending?.abort(); pending = null; clearKey(); closeConfirm();
    if (writing) {
      const text = '保存结果未确认，返回后请刷新列表核对；不会自动重试。'; message(text);
      if (editor.open) $('forward-rule-error').textContent = text;
    }
    $('forward-diagnostics').hidden = true; $('forward-diagnostics-text').value = ''; update();
  }
  function reset() {
    generation++; statusKnown = false; reading?.abort(); pending?.abort(); reading = pending = null; clearKey();
    closeConfirm(); if (editor.open) editor.close(); edit = null;
    agents = []; selectedId = ''; rowsAgent = ''; rows.clear(); $('forward-agent-rules').replaceChildren(); $('forward-agent-inventory-body').replaceChildren(); inventorySignature = '';
    $('forward-agent-connection').textContent = ''; $('forward-agent-network').textContent = ''; message(''); $('forward-diagnostics').hidden = true; $('forward-diagnostics-text').value = '';
    if (layoutFrame) cancelAnimationFrame(layoutFrame); layoutFrame = 0;
  }
  return { refresh, update, reset, suspend, policy(value) { policy = value; update(); }, get busy() { return busy(); } };
}
