const states = { active: '已生效', pending: '等待助手接入映射', connecting: '正在建立映射', recovering: '规则通道恢复中', disabled: '已停用', failed: '未生效', offline: '等待助手上线', starting: '正在下发' };
const address = config => config.serial ? `${config.serial.path} @ ${config.serial.baud}` : `${config.targetHost.includes(':') ? '[' + config.targetHost + ']' : config.targetHost}:${config.targetPort}`;
const mask = prefix => Array.from({ length: 4 }, (_, i) => Math.max(0, Math.min(255, 256 - 2 ** Math.max(0, 8 - Math.max(0, prefix - i * 8))))).join('.');

export function createForwardAgentsUI({ api, allowed, visible, blocked, setBusy, changed, selectionChanged, edit }) {
  const $ = id => document.getElementById(id), select = $('forward-agent-select'), confirmation = $('forward-agent-confirm');
  if (!select || !confirmation || !$('forward-agent-create-form')) return { update() {}, refresh: async () => {}, reset() {}, support() {}, save: async () => {}, selected: null, editing: null, stale: false, busy: false, report: '' };
  let supported = false, agents = [], editing = null, pending = null, reading = null, generation = 0, optionSignature = '', serialSignature = '', confirmAction = null, selectionLost = false, lastRule = null, wasPermitted = false, keyOwner = '';
  const nodes = new Map();
  const live = () => supported && allowed() && visible();
  const selected = () => agents.find(a => a.id === select.value) || null;
  const currentRule = (agentId, id) => agents.find(a => a.id === agentId)?.rules.find(r => r.id === id);
  const status = text => { if ($('forward-agent-status').textContent !== text) $('forward-agent-status').textContent = text; };
  function clearKey() { keyOwner = ''; $('forward-agent-key').value = ''; $('forward-agent-key-box').hidden = true; }
  function update() {
    const permitted = supported && allowed();
    if (!permitted && wasPermitted) { const wasBusy = !!pending; wasPermitted = false; reset(); if (wasBusy) setBusy(false); }
    wasPermitted = permitted;
    const agent = permitted ? selected() : null, busy = !!pending || blocked();
    $('forward-agent-section').hidden = !permitted; $('forward-agent-select-label').hidden = !permitted;
    $('forward-agent-list').hidden = !permitted;
    select.disabled = !permitted || busy;
    for (const id of ['forward-rule-name-label', 'forward-rule-enabled-label', 'forward-rule-new']) $(id).hidden = !agent;
    $('forward-rule-name').disabled = !agent || busy; $('forward-rule-name').required = !!agent;
    $('forward-rule-enabled').disabled = !agent || busy;
    $('forward-rule-editing').hidden = !agent || !editing;
    const staleEdit = editing && currentRule(agent?.id, editing.id)?.revision !== editing.revision;
    $('forward-rule-editing').textContent = editing ? staleEdit ? '规则已更新或删除，请重新选择编辑，或作为新规则。' : '正在编辑规则：' + editing.name + '；保存后仅重建这一条映射。' : '';
    $('forward-agent-create').disabled = !permitted || busy || agents.length >= 8;
    $('forward-agent-heading').textContent = `常驻远程助手（${agents.length}/8）`;
    $('forward-agent-name').disabled = busy; $('forward-agent-key-copy').disabled = busy;
    $('forward-rule-new').disabled = busy;
    for (const node of nodes.values()) for (const button of node.root.querySelectorAll('button')) button.disabled = busy || !permitted;
    $('forward-serial-choice-label').hidden = !agent;
    $('forward-serial-choice').disabled = !agent || busy;
    const serialPorts = agent?.inventory?.serialPorts || [], signature = JSON.stringify([agent?.id, serialPorts]);
    if (signature !== serialSignature) {
      serialSignature = signature; $('forward-serial-choice').replaceChildren(new Option('从列表选择，或在下方手动填写', ''), ...serialPorts.map(path => new Option(path, path)));
      $('forward-serial-choice').value = serialPorts.includes($('forward-serial-path').value) ? $('forward-serial-path').value : '';
    }
  }
  async function refresh() {
    if (!live() || pending || reading) return;
    const epoch = generation, request = reading = new AbortController(), timeout = setTimeout(() => request.abort(), 8000);
    try {
      const data = await api('/api/forward/agents', { signal: request.signal });
      if (epoch !== generation || !live()) return;
      if (data.protocol !== 1 || !Array.isArray(data.agents) || data.agents.length > 8) throw Error('助手列表无效，请更新节点后重试');
      agents = data.agents; render(); update(); changed();
    } catch (error) { if (epoch === generation && live() && !request.signal.aborted) status(error.message); }
    finally { clearTimeout(timeout); if (reading === request) reading = null; }
  }
  async function mutate(path, body) {
    if (!live() || pending || blocked()) return null;
    lastRule = null;
    if (['create', 'rekey', 'remove'].includes(path)) clearKey();
    reading?.abort(); reading = null;
    const epoch = generation, request = pending = new AbortController(), timeout = setTimeout(() => request.abort(), 8000);
    setBusy(true); update();
    try {
      const value = await api('/api/forward/agents/' + path, { method: 'POST', body, signal: request.signal });
      if (epoch !== generation || !live()) return null;
      if (value.key) { keyOwner = value.id; $('forward-agent-key-label').textContent = '助手“' + (path === 'create' ? body.name : agents.find(a => a.id === value.id)?.name || value.id) + '”的授权 key（仅本次显示，请私密保存）'; $('forward-agent-key').value = value.key; $('forward-agent-key-box').hidden = false; status('key 仅显示这一次，请复制后私密保存；启动助手时粘贴即可。'); }
      return value;
    } catch (error) {
      if (epoch === generation && live()) status(error.outcome !== 'rejected' ? '结果未确认，请刷新助手列表核对，不要连续重复操作。' : error.message);
      return null;
    } finally {
      clearTimeout(timeout);
      if (pending === request) { pending = null; setBusy(false); update(); }
    }
  }
  function confirm(title, description, operation) {
    if (!live() || pending || blocked()) return;
    confirmAction = operation; $('forward-agent-confirm-title').textContent = title; $('forward-agent-confirm-description').textContent = description;
    confirmation.showModal(); $('forward-agent-confirm-cancel').focus({ preventScroll: true });
  }
  function closeConfirm() { confirmAction = null; confirmation.close(); }
  $('forward-agent-confirm-cancel').addEventListener('click', closeConfirm);
  confirmation.addEventListener('close', () => { confirmAction = null; });
  confirmation.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); closeConfirm(); } });
  $('forward-agent-confirm-accept').addEventListener('click', async () => { const operation = confirmAction; closeConfirm(); if (operation && live()) { await operation(); await refresh(); } });
  function choose(id, rule = null, focus = true) {
    if (!live() || pending || blocked()) return;
    select.value = id; editing = rule; selectionLost = false; lastRule = null;
    if (keyOwner && keyOwner !== id) clearKey();
    if (rule) { $('forward-rule-name').value = rule.name; $('forward-rule-enabled').checked = rule.enabled; edit(rule.config); }
    selectionChanged(); update(); if (focus) (rule ? $('forward-rule-name') : select).focus();
  }
  select.addEventListener('change', () => { editing = null; selectionLost = false; lastRule = null; if (keyOwner && keyOwner !== select.value) clearKey(); selectionChanged(); update(); });
  $('forward-rule-new').addEventListener('click', () => { editing = null; changed(); update(); });
  $('forward-serial-choice').addEventListener('change', () => { if ($('forward-serial-choice').value) { $('forward-serial-path').value = $('forward-serial-choice').value; $('forward-serial-path').focus({ preventScroll: true }); } });
  $('forward-serial-path').addEventListener('input', () => { $('forward-serial-choice').value = selected()?.inventory?.serialPorts.includes($('forward-serial-path').value) ? $('forward-serial-path').value : ''; });
  $('forward-agent-create-form').addEventListener('submit', async event => {
    event.preventDefault(); const result = await mutate('create', { name: $('forward-agent-name').value.trim() });
    if (result) { $('forward-agent-name').value = ''; await refresh(); choose(result.id, null, false); }
  });
  $('forward-agent-key-close').addEventListener('click', clearKey);
  $('forward-agent-key-copy').addEventListener('click', async () => {
    const value = $('forward-agent-key').value; if (!value || !live()) return;
    try { await navigator.clipboard.writeText(value); if (live() && $('forward-agent-key').value === value) status('助手 key 已复制，请私密保存后粘贴到助手。'); }
    catch { if (live()) { $('forward-agent-key').focus(); $('forward-agent-key').select(); status('请手动复制已选中的助手 key。'); } }
  });
  const element = (tag, className = '', text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
  function button(label, action) { const node = element('button', 'secondary', label); node.type = 'button'; node.addEventListener('click', action); return node; }
  function createCard(agent) {
    const root = element('article', 'forward-row forward-agent-card'); root.dataset.agentId = agent.id;
    const title = element('strong'), connection = element('p', 'muted'), network = element('p', 'muted'), actions = element('div', 'forward-agent-actions');
    const inventory = element('details'), inventoryTitle = element('summary', '', '网卡和串口信息'), inventoryBody = element('div', 'forward-agent-inventory'); inventory.append(inventoryTitle, inventoryBody);
    const rules = element('div', 'forward-agent-rules');
    actions.append(button('配置此助手', () => choose(agent.id)), button('刷新设备信息', async () => { const result = await mutate('inventory', { id: agent.id }); if (result) status('已请求刷新网卡和串口信息。'); }),
      button('重新生成 key', () => confirm('重新生成助手 key', '旧 key 将立即失效，此助手的现有映射会停止；保存的规则保留。', async () => { await mutate('rekey', { id: agent.id }); })),
      button('撤销并移除助手', () => confirm('撤销并移除助手', '移除此助手及其所有规则，立即关闭它的映射和连接。其他助手不受影响。', async () => { await mutate('remove', { id: agent.id }); })));
    root.append(title, connection, network, actions, inventory, rules); $('forward-agent-list').append(root);
    return { root, title, connection, network, inventory, inventoryTitle, inventoryBody, inventorySignature: '', rules, ruleNodes: new Map() };
  }
  function render() {
    const previous = select.value, signature = JSON.stringify(agents.map(a => [a.id, a.name]));
    if (signature !== optionSignature) {
      optionSignature = signature; select.replaceChildren(new Option('一次性配对（兼容旧助手）', ''), ...agents.map(a => new Option(a.name + (a.online ? '（在线）' : '（离线）'), a.id)));
      if (agents.some(a => a.id === previous)) select.value = previous;
      else if (previous) { selectionLost = true; status('所选助手已移除，请重新选择目标后再提交规则。'); }
    }
    for (const option of select.options) { const agent = agents.find(a => a.id === option.value); if (agent) option.textContent = agent.name + (agent.online ? '（在线）' : '（离线）'); }
    for (const [id, node] of nodes) if (!agents.some(a => a.id === id)) { node.root.remove(); nodes.delete(id); }
    for (const agent of agents) {
      let node = nodes.get(agent.id); if (!node) { node = createCard(agent); nodes.set(agent.id, node); }
      node.title.textContent = agent.name; node.connection.textContent = (agent.online ? '助手在线 · 控制连接已建立' : '控制连接离线 · 助手可使用原 key 重连') + ' · ' + agent.id;
      const active = agent.rules.filter(r => r.mapping?.state === 'active'), directReady = active.filter(r => r.mapping.direct.available).length;
      const direct = agent.rules.reduce((n, r) => n + (r.mapping?.directConnections || 0), 0), total = agent.rules.reduce((n, r) => n + (r.mapping?.connections || 0), 0);
      node.network.textContent = `已有数据连接：直连 ${direct} / 中转 ${total - direct}。` + (active.length ? `新连接：${directReady} 条规则优先直连，${active.length - directReady} 条规则走中转。` : '尚无可建立新连接的规则。');
      const inventorySignature = JSON.stringify(agent.inventory);
      if (inventorySignature !== node.inventorySignature) {
        node.inventorySignature = inventorySignature; node.inventoryBody.replaceChildren();
        const info = agent.inventory;
        if (!info) node.inventoryBody.append(element('p', 'muted', '等待助手上报网卡 IPv4 和串口列表。'));
        else {
          node.inventoryBody.append(element('p', 'muted', '更新时间：' + new Date(info.updatedAt).toLocaleString() + (info.truncated ? '；信息超过上限，已标记截断。' : '') + (info.error ? '；部分设备信息读取失败，可手动填写串口。' : '')));
          for (const iface of info.interfaces) node.inventoryBody.append(element('p', 'muted', `${iface.name}（${iface.up ? '启用' : '停用'}）：` + (iface.addresses.map(ip => `${ip.address}/${ip.prefix}（${mask(ip.prefix)}）`).join('、') || (iface.error ? '地址读取失败' : '无 IPv4 地址'))));
          node.inventoryBody.append(element('p', 'muted', '串口：' + (info.serialPorts.join('、') || '未发现；也可在表单手动填写。')));
          node.inventoryTitle.textContent = `网卡 ${info.interfaces.length} 张 · 串口 ${info.serialPorts.length} 个`;
        }
      }
      for (const [id, row] of node.ruleNodes) if (!agent.rules.some(r => r.id === id)) { row.root.remove(); node.ruleNodes.delete(id); }
      for (const rule of agent.rules) {
        let row = node.ruleNodes.get(rule.id);
        if (!row) {
          const root = element('div', 'forward-agent-rule'); root.dataset.ruleId = rule.id;
          const title = element('strong'), detail = element('p', 'muted'), state = element('p', 'muted'), transport = element('p', 'muted'), controls = element('div', 'forward-agent-actions');
          controls.append(button('编辑规则', () => { const value = currentRule(agent.id, rule.id); if (value) choose(agent.id, value); }),
            button('启用 / 停用', async () => { const value = currentRule(agent.id, rule.id); if (!value) return; if (value.enabled) confirm('停用映射规则', '关闭这一条规则及其现有连接，其他规则继续运行。', async () => { await mutate('rule', { agentId: agent.id, id: value.id, revision: value.revision, name: value.name, config: value.config, enabled: false }); }); else { await mutate('rule', { agentId: agent.id, id: value.id, revision: value.revision, name: value.name, config: value.config, enabled: true }); await refresh(); } }),
            button('删除规则', () => { const value = currentRule(agent.id, rule.id); if (value) confirm('删除映射规则', '删除这一条规则并关闭其现有连接，其他规则不受影响。', async () => { await mutate('rule/remove', { agentId: agent.id, id: value.id, revision: value.revision }); }); }));
          root.append(title, detail, state, transport, controls); node.rules.append(root); row = { root, title, detail, state, transport, toggle: controls.children[1] }; node.ruleNodes.set(rule.id, row);
        }
        row.title.textContent = rule.name; row.detail.textContent = (rule.config.direction === 'reverse' ? '服务器' : '助手') + ` 127.0.0.1:${rule.config.localPort} → ` + address(rule.config);
        row.toggle.textContent = rule.enabled ? '停用规则' : '启用规则';
        row.state.textContent = (states[rule.state] || '等待状态') + (rule.error ? '：' + rule.error : '');
        const mapping = rule.mapping, path = mapping?.direct;
        row.transport.textContent = !mapping ? '数据通道尚未建立' : mapping.state !== 'active' ? '新连接暂停；已有连接按原通道处理。' : (path.available ? `新连接：${path.family || 'IP'} / ${path.protocol || 'UDP'} 加密直连${Number.isFinite(path.rttMs) ? ' · ' + path.rttMs + ' ms' : ''}` : '新连接：WSS 加密中转') + `；已有：直连 ${mapping.directConnections} / 中转 ${mapping.connections - mapping.directConnections}`;
      }
    }
    if (lastRule) {
      const rule = currentRule(lastRule.agentId, lastRule.id);
      if (rule) status('规则“' + rule.name + '”：' + (states[rule.state] || '等待状态') + (rule.error ? '；' + rule.error : ''));
    }
  }
  function reset() {
    generation++; pending?.abort(); reading?.abort(); pending = reading = null; editing = lastRule = null; selectionLost = false; clearKey(); closeConfirm();
    agents = []; nodes.clear(); $('forward-agent-list').replaceChildren(); select.replaceChildren(new Option('一次性配对（兼容旧助手）', '')); optionSignature = serialSignature = ''; status('');
  }
  return {
    update, refresh, reset,
    get selected() { return selected(); }, get editing() { return editing; }, get stale() { return selectionLost || !!editing && currentRule(selected()?.id, editing.id)?.revision !== editing.revision; }, get busy() { return !!pending; },
    get report() {
      if (!supported || !allowed()) return '';
      const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const lines = ['常驻助手诊断 v1', '长期 key 独立于网页登录；节点重启后恢复规则，不重放业务字节。', '助手名、网卡名、地址、串口路径、规则标识和 key 均已省略。'];
      for (const [i, agent] of agents.entries()) {
        lines.push(`助手 ${i + 1}：${agent.online ? '控制在线' : '控制离线'}；规则 ${agent.rules.length}；网卡 ${agent.inventory?.interfaces.length || 0}；串口 ${agent.inventory?.serialPorts.length || 0}`);
        for (const [j, rule] of agent.rules.entries()) {
          const mapping = rule.mapping;
          lines.push(`规则 ${i + 1}.${j + 1}：${states[rule.state] || '未知'}；${rule.config.serial ? '串口' : rule.config.direction === 'reverse' ? '反向 TCP' : '正向 TCP'}；已有直连 ${number(mapping?.directConnections)} / 总连接 ${number(mapping?.connections)}；新连接 ${mapping?.state !== 'active' ? '暂停' : mapping.direct.available ? '直连' : '中转'}；RTT ms ${number(mapping?.direct.rttMs)}`);
        }
      }
      return lines.join('\n').slice(0, 24000);
    },
    support(value) { supported = value === true; update(); },
    async save(config) {
      const agent = selected(); if (!agent || selectionLost) return;
      const result = await mutate('rule', { agentId: agent.id, ...(editing ? { id: editing.id, revision: editing.revision } : {}), name: $('forward-rule-name').value.trim(), enabled: $('forward-rule-enabled').checked, config });
      if (result) { if (editing) editing = result; lastRule = { agentId: agent.id, id: result.id }; await refresh(); }
    },
  };
}
