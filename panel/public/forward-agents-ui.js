import { rtcHints } from './rtc-hints.js';
const states = { active: '已生效', pending: '等待规则通道', connecting: '正在建立映射', recovering: '规则通道恢复中', disabled: '已停用', failed: '未生效', offline: '等待助手上线', starting: '正在下发' };
const mask = prefix => Array.from({ length: 4 }, (_, i) => Math.max(0, Math.min(255, 256 - 2 ** Math.max(0, 8 - Math.max(0, prefix - i * 8))))).join('.');
const endpoint = c => c.serial ? `${c.serial.path} @ ${c.serial.baud}` : `${c.targetHost.includes(':') ? '[' + c.targetHost + ']' : c.targetHost}:${c.targetPort}`;
const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };

export function createForwardAgentsUI({ api, allowed, visible, hints }) {
  const $ = id => document.getElementById(id), editor = $('forward-rule-dialog'), confirmation = $('forward-agent-confirm');
  let agents = [], selectedId = '', selectedSlot = 1, generation = 0, reading, pending, keyRequest, keyRevision = 0, policy = null, edit = null, confirming = null;
  let inventorySignature = '', layoutFrame = 0, rowsAgent = '', permitted = false;
  const rows = new Map(), tabs = [];
  const live = () => allowed() && visible(), selected = () => agents.find(a => a.id === selectedId);
  const message = text => { $('forward-agent-status').textContent = text; };
  const currentRule = id => selected()?.rules.find(r => r.id === id);
  const busy = () => !!pending;
  function clearKey() { keyRevision = 0; keyRequest?.abort(); keyRequest = null; $('forward-agent-key').value = ''; }
  function update() {
    if (!allowed() && permitted) reset();
    permitted = allowed(); $('forward-agent-section').hidden = !permitted; $('forward-permission').hidden = permitted;
    const agent = selected();
    for (const id of ['forward-rule-add', 'forward-agent-rekey', 'forward-agent-inventory-refresh', 'forward-agent-key-copy']) $(id).disabled = !permitted || busy() || !agent || id === 'forward-agent-inventory-refresh' && !agent.online || id === 'forward-agent-key-copy' && !$('forward-agent-key').value;
    for (const tab of tabs) tab.disabled = !permitted || busy();
    $('forward-agent-overflow').disabled = !permitted || busy();
    for (const row of rows.values()) for (const button of row.root.querySelectorAll('button')) button.disabled = !permitted || busy();
    if (editor.open) {
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
      layoutFrame = 0; if (!live()) return;
      const bar = $('forward-agent-bar'), more = $('forward-agent-overflow'), gap = 6;
      const focused = document.activeElement;
      tabs.forEach(tab => { tab.hidden = false; }); more.hidden = true;
      const widths = tabs.map(tab => tab.getBoundingClientRect().width), available = bar.clientWidth;
      let hidden = [];
      if (widths.reduce((a, b) => a + b, 0) + gap * 7 > available + 1) {
        more.hidden = false; let used = 0, fits = true;
        const room = Math.max(0, available - more.getBoundingClientRect().width - gap);
        for (const [i, tab] of tabs.entries()) { used += widths[i] + (i ? gap : 0); fits &&= used <= room + 1; tab.hidden = !fits; if (tab.hidden) hidden.push(i + 1); }
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
    });
  }
  new ResizeObserver(layout).observe($('forward-agent-bar'));
  for (let slot = 1; slot <= 8; slot++) {
    const tab = node('button', '助手' + slot, 'forward-agent-tab'); tab.type = 'button'; tab.id = 'forward-agent-tab-' + slot;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'forward-agent-panel'); tab.dataset.slot = String(slot);
    tab.addEventListener('click', () => choose(slot));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 1 : event.key === 'End' ? 8 : (slot + (event.key === 'ArrowRight' ? 0 : 6)) % 8 + 1;
      choose(next); requestAnimationFrame(() => (tabs[next - 1].hidden ? $('forward-agent-overflow') : tabs[next - 1]).focus());
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
      if (value.protocol !== 2 || !Array.isArray(value.agents) || value.agents.length !== 8 || value.agents.some((a, i) => a.slot !== i + 1 || a.name !== '助手' + (i + 1))) throw Error('固定助手配置无效，请检查节点版本');
      agents = value.agents;
      const agent = agents.find(a => a.slot === selectedSlot); if (selectedId !== agent.id) { selectedId = agent.id; clearKey(); }
      render(); update(); void loadKey();
    } catch (error) { if (epoch === generation && live() && !request.signal.aborted) message(error.message); }
    finally { clearTimeout(timeout); if (reading === request) reading = null; }
  }
  async function mutate(path, body) {
    if (!live() || pending) return null;
    reading?.abort(); reading = null;
    const epoch = generation, id = selectedId, request = pending = new AbortController(), timeout = setTimeout(() => request.abort(), 8000); update();
    try {
      const value = await api('/api/forward/agents/' + path, { method: 'POST', body, signal: request.signal });
      return epoch === generation && selectedId === id && live() ? value : null;
    } catch (error) {
      if (epoch === generation && live()) {
        const text = error.outcome === 'rejected' ? error.message : '结果未确认，请刷新列表核对；不会自动重试。'; message(text); if (editor.open) $('forward-rule-error').textContent = text;
      }
      return null;
    } finally { clearTimeout(timeout); if (pending === request) pending = null; update(); }
  }
  function confirm(title, description, action) {
    if (!live() || busy()) return;
    confirming = action; $('forward-agent-confirm-title').textContent = title; $('forward-agent-confirm-description').textContent = description;
    confirmation.showModal(); $('forward-agent-confirm-cancel').focus({ preventScroll: true });
  }
  function closeConfirm() { confirming = null; if (confirmation.open) confirmation.close(); }
  $('forward-agent-confirm-cancel').addEventListener('click', closeConfirm);
  confirmation.addEventListener('close', () => { confirming = null; });
  confirmation.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); closeConfirm(); } });
  $('forward-agent-confirm-accept').addEventListener('click', async () => { const action = confirming; closeConfirm(); if (action && live()) { await action(); await refresh(); } });
  $('forward-agent-rekey').addEventListener('click', () => {
    const agent = selected(); if (!agent) return;
    confirm('刷新' + agent.name + '的 key', '旧 key 立即失效，该助手及其映射连接将断开；规则保留。其他助手不受影响。', async () => {
      clearKey(); await mutate('rekey', { id: agent.id, revision: agent.keyRevision });
    });
  });
  $('forward-agent-key-copy').addEventListener('click', async () => {
    const key = $('forward-agent-key').value, epoch = generation; if (!key || !live()) return;
    try { await navigator.clipboard.writeText(key); if (epoch === generation && live() && key === $('forward-agent-key').value) message('key 已复制。请在对应电脑的助手窗口粘贴。'); }
    catch { if (epoch === generation && live()) { $('forward-agent-key').focus(); $('forward-agent-key').select(); message('请手动复制已选中的 key。'); } }
  });
  $('forward-agent-inventory-refresh').addEventListener('click', async () => { const agent = selected(); if (agent && await mutate('inventory', { id: agent.id })) message('已请求刷新设备信息。'); });
  function renderDirection() {
    const reverse = $('forward-direction').value === 'reverse', serial = reverse && $('forward-protocol').value === 'serial';
    $('forward-device-fields').hidden = !reverse; $('forward-serial-fields').hidden = !serial; $('forward-serial-fields').disabled = !serial || busy(); $('forward-serial-choice-label').hidden = !serial;
    for (const id of ['forward-host', 'forward-target']) { $(id).closest('label').hidden = serial; $(id).disabled = serial || busy(); }
    $('forward-local-label').textContent = reverse ? '服务器回环端口' : '助手本机端口';
    $('forward-target-note').textContent = serial ? '串口位于该助手电脑上；实际客户端接入后才打开设备。' : reverse ? '目标从该助手电脑访问。服务器只监听 127.0.0.1，目标使用原服务的认证。' : '目标从节点服务器访问，127.0.0.1 指服务器自身。';
    $('forward-port-policy').textContent = policy?.allPorts ? 'TCP 目标端口：允许所有非管理端口。' : 'TCP 目标端口：' + (policy?.ports?.join('、') || '已禁用；串口不受此限制。');
  }
  function openEditor(rule = null) {
    const agent = selected(); if (!agent || !live() || busy()) return;
    const c = rule?.config || {};
    edit = { agentId: agent.id, rule, serverHint: rule ? c.hints?.server || '' : hints().server || '' };
    $('forward-form').reset(); $('forward-rule-name').value = rule?.name || ''; $('forward-rule-enabled').checked = rule ? rule.enabled : true;
    $('forward-direction').value = c.direction === 'reverse' ? 'reverse' : 'forward'; $('forward-protocol').value = c.protocol || 'ssh';
    $('forward-local').value = c.localPort || 2222; $('forward-host').value = c.targetHost || '127.0.0.1'; $('forward-target').value = c.targetPort || 22;
    $('forward-server-ip').value = edit.serverHint;
    $('forward-helper-ip').value = rule ? c.hints?.browser || '' : hints().browser || '';
    const serial = c.serial || { path: '', baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false };
    for (const [field, value] of Object.entries({ path: serial.path, baud: serial.baud, bits: serial.dataBits, parity: serial.parity, stop: serial.stopBits })) $('forward-serial-' + field).value = value;
    $('forward-serial-dtr').checked = serial.dtr; $('forward-serial-rts').checked = serial.rts;
    serialOptions(); $('forward-rule-error').textContent = ''; $('forward-rule-title').textContent = agent.name + (rule ? ' · 编辑规则' : ' · 新增规则');
    editor.showModal(); update(); $('forward-rule-name').focus();
  }
  function closeEditor() { if (busy()) return; if (editor.open) editor.close(); }
  $('forward-rule-add').addEventListener('click', () => openEditor());
  $('forward-rule-close').addEventListener('click', closeEditor); $('forward-rule-cancel').addEventListener('click', closeEditor);
  editor.addEventListener('cancel', event => { if (busy()) event.preventDefault(); });
  editor.addEventListener('close', () => { edit = null; $('forward-form').reset(); $('forward-rule-error').textContent = ''; });
  $('forward-direction').addEventListener('change', () => { if ($('forward-local').value === '2222' && $('forward-direction').value === 'reverse') $('forward-local').value = '22001'; else if ($('forward-local').value === '22001' && $('forward-direction').value !== 'reverse') $('forward-local').value = '2222'; renderDirection(); });
  $('forward-protocol').addEventListener('change', renderDirection);
  $('forward-serial-choice').addEventListener('change', () => { if ($('forward-serial-choice').value) $('forward-serial-path').value = $('forward-serial-choice').value; });
  $('forward-serial-path').addEventListener('input', () => { $('forward-serial-choice').value = selected()?.inventory?.serialPorts.includes($('forward-serial-path').value) ? $('forward-serial-path').value : ''; });
  function serialOptions() {
    const ports = selected()?.inventory?.serialPorts || [], select = $('forward-serial-choice'), path = $('forward-serial-path').value;
    if (select.dataset.ports !== JSON.stringify(ports)) { select.dataset.ports = JSON.stringify(ports); select.replaceChildren(new Option('从列表选择，或手动填写', ''), ...ports.map(p => new Option(p, p))); }
    select.value = ports.includes(path) ? path : '';
  }
  $('forward-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!edit || !live() || busy()) return;
    if (edit.rule && currentRule(edit.rule.id)?.revision !== edit.rule.revision) { update(); return; }
    const reverse = $('forward-direction').value === 'reverse', serial = reverse && $('forward-protocol').value === 'serial';
    let config = { localPort: Number($('forward-local').value) };
    try {
      config.hints = rtcHints({ server: $('forward-server-ip').value.trim(), browser: $('forward-helper-ip').value.trim() });
      if (reverse) Object.assign(config, { direction: 'reverse', protocol: $('forward-protocol').value, deviceName: $('forward-rule-name').value.trim() });
      if (serial) config.serial = { path: $('forward-serial-path').value.trim(), baud: Number($('forward-serial-baud').value), dataBits: Number($('forward-serial-bits').value), parity: $('forward-serial-parity').value, stopBits: Number($('forward-serial-stop').value), dtr: $('forward-serial-dtr').checked, rts: $('forward-serial-rts').checked };
      else Object.assign(config, { targetHost: $('forward-host').value.trim(), targetPort: Number($('forward-target').value) });
    } catch (error) { $('forward-rule-error').textContent = error.message; return; }
    const draft = edit, result = await mutate('rule', { agentId: edit.agentId, ...(edit.rule ? { id: edit.rule.id, revision: edit.rule.revision } : {}), name: $('forward-rule-name').value.trim(), enabled: $('forward-rule-enabled').checked, config });
    if (result && edit === draft) { closeEditor(); message('规则已保存；助手在线时自动应用。'); }
    await refresh();
  });
  function button(text, action) { const b = node('button', text, 'secondary'); b.type = 'button'; b.addEventListener('click', action); return b; }
  function render() {
    const agent = selected(); if (!agent) return;
    $('forward-agent-panel').setAttribute('aria-labelledby', 'forward-agent-tab-' + agent.slot);
    $('forward-agent-panel').dataset.agentId = agent.id; $('forward-agent-heading').textContent = agent.name; $('forward-agent-key-label').textContent = agent.name + '授权 key';
    for (const [i, tab] of tabs.entries()) { tab.setAttribute('aria-selected', String(i + 1 === agent.slot)); tab.dataset.online = String(agents[i].online); tab.title = '助手' + (i + 1) + (agents[i].online ? ' · 在线' : ' · 离线'); }
    $('forward-agent-connection').textContent = agent.online ? '助手在线 · 控制连接已建立' : '助手离线 · 使用本页 key 启动助手后自动接入';
    const active = agent.rules.filter(r => r.mapping?.state === 'active'), directReady = active.filter(r => r.mapping.direct.available).length;
    const direct = agent.rules.reduce((n, r) => n + (r.mapping?.directConnections || 0), 0), total = agent.rules.reduce((n, r) => n + (r.mapping?.connections || 0), 0);
    $('forward-agent-network').textContent = `已有数据连接：直连 ${direct} / 中转 ${total - direct}。` + (active.length ? `新连接：${directReady} 条规则优先直连，${active.length - directReady} 条规则走中转。` : '尚无可建立新连接的规则。');
    const signature = JSON.stringify([agent.id, agent.online, agent.inventory]);
    if (signature !== inventorySignature) {
      inventorySignature = signature; const target = $('forward-agent-inventory-body'), info = agent.inventory; target.replaceChildren();
      $('forward-agent-inventory-title').textContent = info ? `网卡 ${info.interfaces.length} 张 · 串口 ${info.serialPorts.length} 个` : '网卡和串口信息';
      if (!info) target.append(node('p', '等待助手上报设备信息。', 'muted'));
      else {
        target.append(node('p', '更新时间：' + new Date(info.updatedAt).toLocaleString() + (!agent.online ? '；离线，仅为最后一次信息。' : '') + (info.truncated ? '；信息超出上限，已截断。' : '') + (info.error ? '；部分设备信息读取失败，可手动填写串口。' : ''), 'muted'));
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
        const title = node('strong'), detail = node('p', '', 'muted'), state = node('p', '', 'muted'), transport = node('p', '', 'muted'), actions = node('div', '', 'forward-agent-actions');
        const toggle = button('停用规则', async () => {
          const value = currentRule(rule.id); if (!value) return;
          const operation = async () => { await mutate('rule', { agentId: selectedId, id: value.id, revision: value.revision, name: value.name, config: value.config, enabled: !value.enabled }); await refresh(); };
          if (value.enabled) confirm('停用映射规则', '关闭这一条规则及其现有连接，其他规则继续运行。', operation); else await operation();
        });
        actions.append(button('编辑规则', () => { const value = currentRule(rule.id); if (value) openEditor(value); }), toggle, button('删除规则', () => {
          const value = currentRule(rule.id); if (value) confirm('删除映射规则', '删除这一条规则并关闭其现有连接，其他规则不受影响。', async () => { await mutate('rule/remove', { agentId: selectedId, id: value.id, revision: value.revision }); });
        }), button('复制连接信息', async () => {
          const value = currentRule(rule.id); if (!value || !live()) return;
          const c = value.config, address = '127.0.0.1:' + c.localPort;
          const command = c.serial ? 'nc 127.0.0.1 ' + c.localPort : c.protocol === 'ssh' ? 'ssh -o HostKeyAlias=codex-cloud-' + value.id + ' -p ' + c.localPort + ' USER@127.0.0.1' : c.protocol === 'telnet' ? 'telnet 127.0.0.1 ' + c.localPort : address;
          const text = `${value.name}\n${c.direction === 'reverse' ? '服务器' : '助手本机'}入口：${address}\n${command}`;
          try { await navigator.clipboard.writeText(text); if (live()) message('连接信息已复制，不含 key 或密码。'); } catch { if (live()) message('无法使用剪贴板，请按规则中显示的回环端口连接。'); }
        }));
        root.append(title, detail, state, transport, actions); $('forward-agent-rules').append(root); row = { root, title, detail, state, transport, toggle }; rows.set(rule.id, row);
      }
      row.title.textContent = rule.name; row.detail.textContent = (rule.config.direction === 'reverse' ? '服务器' : '助手') + ` 127.0.0.1:${rule.config.localPort} → ${endpoint(rule.config)}`;
      const m = rule.mapping, p = m?.direct;
      row.state.textContent = (states[rule.state] || '等待状态') + (rule.error ? '：' + rule.error : m?.error ? '；最近连接错误：' + m.error : m?.state === 'active' ? m.targetStatus?.state === 'reachable' ? '；目标最近连接成功' : '；目标尚未连接验证' : ''); row.toggle.textContent = rule.enabled ? '停用规则' : '启用规则';
      row.transport.textContent = !m ? '数据通道尚未建立' : (m.state === 'active' ? p.available ? `新连接：${p.family || 'IP'} / UDP 加密直连${Number.isFinite(p.rttMs) ? ' · ' + p.rttMs + ' ms' : ''}` : '新连接：WSS 加密中转' : '新连接暂停') + `；已有：直连 ${m.directConnections} / 中转 ${m.connections - m.directConnections}`;
    }
    $('forward-agent-rules').querySelector('.forward-rule-empty')?.remove();
    if (!agent.rules.length) $('forward-agent-rules').append(node('p', '尚无规则，点击“新增规则”配置；助手离线时也可保存。', 'muted forward-rule-empty'));
    layout();
  }
  function report() {
    if (!live()) return '';
    const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const lines = ['Codex Cloud 助手诊断 v2', '地址、端口、网卡名、串口路径、规则名称、标识和 key 均已省略。'];
    for (const agent of agents) {
      lines.push(`${agent.name}：${agent.online ? '控制在线' : '控制离线'}；规则 ${agent.rules.length}`);
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
  function reset() {
    generation++; reading?.abort(); pending?.abort(); reading = pending = null; clearKey();
    closeConfirm(); if (editor.open) editor.close(); edit = null;
    agents = []; selectedId = ''; rowsAgent = ''; rows.clear(); $('forward-agent-rules').replaceChildren(); $('forward-agent-inventory-body').replaceChildren(); inventorySignature = '';
    $('forward-agent-connection').textContent = ''; $('forward-agent-network').textContent = ''; message(''); $('forward-diagnostics').hidden = true; $('forward-diagnostics-text').value = '';
    if (layoutFrame) cancelAnimationFrame(layoutFrame); layoutFrame = 0;
  }
  return { refresh, update, reset, policy(value) { policy = value; }, get busy() { return busy(); } };
}
