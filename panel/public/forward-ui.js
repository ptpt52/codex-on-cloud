import { FORWARD_CLIENTS, forwardOS, detectForwardClient } from './forward-platform.js';

import { forwardReport, forwardFaultArea } from './forward-report.js';

// The browser grants one short-lived capability; raw TCP bytes never enter it.
export function createForwardUI({ api, allowed, capabilities = () => ({ directions: ['forward', 'reverse'], manageDevices: true }) }) {
  const $ = id => document.getElementById(id), dialog = $('forward-dialog'), confirmation = $('forward-confirm');
  let generation = 0, controller, timer, busy = false, codeId = '', codeExpires = 0, pendingStop = '', room = true;
  let platform = { os: forwardOS(navigator), arch: null }, detection, downloads = [];
  let policyReady = false, portsEnabled = false;
  let devices = [], mappings = [], selectedDevice = '', pendingDelete = '', deviceSignature = '', connectionId = '';
  let policySignature = '', reportText = '';
  const clearReport = () => { reportText = ''; if ($('forward-diagnostics')) { $('forward-diagnostics').hidden = true; $('forward-diagnostics-text').value = ''; } };
  const reversed = () => $('forward-direction').value === 'reverse';
  const targetAddress = item => { const host = item.targetHost || '127.0.0.1'; return (host.includes(':') ? '[' + host + ']' : host) + ':' + item.targetPort; };
  const deviceBody = () => ({ name: $('forward-device-name').value.trim(), protocol: $('forward-protocol').value, localPort: Number($('forward-local').value), targetHost: $('forward-host').value.trim(), targetPort: Number($('forward-target').value) });
  function renderDirection(refresh = true) {
    const reverse = reversed();
    $('forward-device-fields').hidden = !reverse;
    $('forward-device-actions').hidden = !reverse || !capabilities().manageDevices;
    $('forward-device-name').required = reverse;
    $('forward-local-label').textContent = reverse ? '服务器回环端口' : '本机端口';
    $('forward-target-note').textContent = reverse ? '目标从运行助手的电脑访问。填写本机或局域网设备 IP；服务器仅在本地助手确认后监听回环端口。SSH / Telnet 账号仍由原客户端登录。' : '目标从服务器所在网络访问。127.0.0.1 表示服务器自身，也可填写服务器可达的局域网或公网 IPv4 / IPv6。';
    $('forward-device-editing').textContent = selectedDevice ? '正在编辑已保存设备；保存修改不会改变既有授权。' : '新设备';
    if (refresh) update();
  }
  function selectDevice(device) {
    clearCode(); selectedDevice = device.id;
    $('forward-direction').value = 'reverse'; $('forward-device-name').value = device.name; $('forward-protocol').value = device.protocol;
    $('forward-local').value = device.localPort; $('forward-host').value = device.targetHost; $('forward-target').value = device.targetPort;
    renderDirection(); $('forward-create').focus({ preventScroll: true });
  }
  function renderDevices() {
    const signature = JSON.stringify([devices, mappings.filter(item => item.direction === 'reverse').map(({ id, deviceId, state, targetStatus, targetHost, targetPort }) => ({ id, deviceId, state, targetStatus, targetHost, targetPort })), busy]);
    if (signature === deviceSignature) return; deviceSignature = signature;
    const list = $('forward-device-list'); list.replaceChildren();
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'forward-device-row'; row.dataset.device = device.id;
      const title = document.createElement('strong'); title.textContent = device.name;
      const detail = document.createElement('p'); detail.className = 'muted'; detail.textContent = device.protocol.toUpperCase() + ' · ' + targetAddress(device);
      const active = mappings.find(item => item.deviceId === device.id && item.targetHost === device.targetHost && item.targetPort === device.targetPort);
      const status = document.createElement('p'); status.className = 'muted'; status.textContent = !active ? '未接入' : active.state !== 'active' ? active.state === 'pending' ? '等待配对' : active.state === 'connecting' ? '等待本地助手确认' : '助手恢复中' : active.targetStatus?.state === 'reachable' ? '助手已连接 · 最近一次目标连接成功' : active.targetStatus?.state === 'failed' ? '助手已连接 · 最近一次目标连接失败' : '助手已连接 · 目标尚未验证';
      const select = document.createElement('button'); select.type = 'button'; select.className = 'secondary'; select.textContent = '选择设备'; select.disabled = busy; select.addEventListener('click', () => { if (!busy && allowed()) selectDevice(device); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = '删除目录条目'; remove.disabled = busy;
      remove.addEventListener('click', () => { if (busy || !allowed()) return; pendingDelete = device.id; pendingStop = ''; $('forward-confirm-title').textContent = '删除设备条目'; $('forward-confirm-description').textContent = '删除“' + device.name + '”的目录资料？现有授权保持不变，结束访问请另外停止映射。'; $('forward-accept-stop').textContent = '确认删除'; confirmation.showModal(); $('forward-cancel-stop').focus({ preventScroll: true }); });
      row.append(title, detail, status, select, remove); list.append(row);
    }
    if (!devices.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '选择反向模式填写资料，可保存到设备目录。'; list.append(empty); }
  }
  function clearConnection() { connectionId = ''; $('forward-connection-text').value = ''; $('forward-connection').hidden = true; }
  async function copyConnection() {
    const text = $('forward-connection-text').value, id = connectionId, current = generation;
    if (!text || !allowed() || !dialog.open) return;
    const valid = () => current === generation && connectionId === id && $('forward-connection-text').value === text && allowed() && dialog.open;
    try { await navigator.clipboard.writeText(text); if (valid()) $('forward-status').textContent = '连接信息已复制，可粘贴给 Codex；未发送任何设备命令。'; }
    catch { if (valid()) { $('forward-connection-text').focus(); $('forward-connection-text').select(); $('forward-status').textContent = '请手动复制已选中的连接信息。'; } }
  }
  function showConnection(item) {
    connectionId = item.id;
    const command = item.protocol === 'ssh' ? 'ssh -o HostKeyAlias=codex-cloud-' + (item.deviceId || item.id) + ' -p ' + item.localPort + ' USER@127.0.0.1' : item.protocol === 'telnet' ? 'telnet 127.0.0.1 ' + item.localPort : 'TCP 入口：127.0.0.1:' + item.localPort;
    $('forward-connection-text').value = '设备：' + item.deviceName + '\n协议：' + item.protocol.toUpperCase() + '\n设备目标（由本地助手访问）：' + targetAddress(item) + '\n服务器入口：127.0.0.1:' + item.localPort + '\n' + command + '\nSSH 请将 USER 换成设备用户名，并核对首次主机指纹。连接使用设备原有认证；此信息不含密码。';
    $('forward-connection').hidden = false; void copyConnection();
  }
  function renderDownloads() {
    const target = $('forward-downloads'); target.replaceChildren();
    const recommended = platform.arch && downloads.some(file => file.arch === platform.arch);
    $('forward-platform-note').textContent = recommended ? '推荐：' + FORWARD_CLIENTS[platform.arch].label + '。也可手动下载其他版本。' : platform.os === 'darwin' ?
      '检测到 Mac，请按“关于本机”的芯片选择 M 系列或 Intel；浏览器未确认芯片架构。' : platform.os === 'windows' ?
      '检测到 Windows，请按电脑系统类型选择 x64 或 ARM64。' : '请选择运行助手的电脑版本；手机和平板可代为下载。';
    const ordered = downloads.slice().sort((a, b) => {
      const rank = file => file.arch === platform.arch ? 0 : FORWARD_CLIENTS[file.arch].os === platform.os ? 1 : 2;
      return rank(a) - rank(b);
    });
    for (const file of ordered) {
      const row = document.createElement('div'), link = document.createElement('a'), hash = document.createElement('small');
      row.className = 'forward-download'; row.dataset.arch = file.arch;
      link.href = file.href; link.download = file.name; link.textContent = '下载 ' + FORWARD_CLIENTS[file.arch].label + ' 助手';
      if (file.arch === platform.arch) { row.classList.add('recommended'); link.setAttribute('aria-description', '推荐版本'); }
      hash.textContent = '版本：' + file.build + ' · SHA256：' + file.sha256; row.append(link, hash); target.append(row);
    }
    if (!downloads.length) target.textContent = '助手暂时无法下载，请在服务器完成助手构建后刷新列表。';
    const hasMac = downloads.some(file => FORWARD_CLIENTS[file.arch].os === 'darwin');
    $('forward-mac-help').hidden = !hasMac;
    const notice = $('forward-mac-notice'); if (notice) notice.hidden = !hasMac;
  }
  function detectPlatform() {
    detection ||= detectForwardClient(navigator).then(value => { platform = value; if (dialog.open && allowed()) renderDownloads(); });
  }
  function clearCode() { codeId = ''; codeExpires = 0; $('forward-code').value = ''; $('forward-pair').hidden = true; }
  function cancel() { generation++; controller?.abort(); controller = null; clearTimeout(timer); timer = null; busy = false; }
  function reset() { clearReport(); cancel(); clearCode(); clearConnection(); devices = []; mappings = []; selectedDevice = ''; pendingStop = pendingDelete = ''; deviceSignature = ''; $('forward-device-list').replaceChildren(); if (confirmation.open) confirmation.close(); if (dialog.open) dialog.close(); $('forward-list').replaceChildren(); $('forward-recent').replaceChildren(); }
  function update() {
    const permission = capabilities(), signature = JSON.stringify(permission);
    if (policySignature && policySignature !== signature) {
      clearReport(); cancel(); clearCode(); clearConnection(); selectedDevice = ''; devices = []; mappings = []; deviceSignature = ''; policyReady = false;
      $('forward-list').replaceChildren(); $('forward-recent').replaceChildren(); $('forward-device-list').replaceChildren();
      if (confirmation.open) confirmation.close();
      if (dialog.open) queueMicrotask(load);
    }
    policySignature = signature;
    for (const option of $('forward-direction').options) option.disabled = !permission.directions.includes(option.value);
    if (!permission.directions.includes($('forward-direction').value)) { $('forward-direction').value = permission.directions[0]; if (reversed() && $('forward-local').value === '2222') $('forward-local').value = '22001'; }
    $('forward-devices').hidden = !permission.manageDevices;
    renderDirection(false);
    $('forward-button').disabled = !allowed();
    if (!allowed()) reset();
    $('forward-create').disabled = !allowed() || busy || !room || !policyReady || !portsEnabled;
    $('forward-refresh').disabled = !allowed() || busy;
    $('forward-local').disabled = $('forward-host').disabled = $('forward-target').disabled = busy;
    $('forward-direction').disabled = busy;
    $('forward-device-name').disabled = $('forward-protocol').disabled = busy || !reversed();
    $('forward-device-save').disabled = $('forward-device-new').disabled = busy || !allowed() || !permission.manageDevices;
  }
  async function request(path, options = {}) {
    const current = generation, abort = new AbortController(); controller = abort;
    const deadline = setTimeout(() => abort.abort(), 8000);
    try {
      const result = await api(path, { ...options, signal: abort.signal });
      if (generation !== current || !allowed() || !dialog.open) return null;
      return result;
    } catch (error) {
      if (generation === current && allowed() && dialog.open) $('forward-status').textContent = options.method === 'POST' && error.outcome !== 'rejected' ?
        '结果未知，请刷新列表确认，不要重复操作。' : error.message;
      return null;
    } finally { clearTimeout(deadline); if (controller === abort) controller = null; }
  }
  function render(data) {
    const directions = capabilities().directions;
    data = { ...data, mappings: data.mappings.filter(item => directions.includes(item.direction === 'reverse' ? 'reverse' : 'forward')),
      recent: (data.recent || []).filter(item => directions.includes(item.direction === 'reverse' ? 'reverse' : 'forward')) };
    const recent = data.recent || [];
    reportText = forwardReport(data);
    if ($('forward-diagnostics') && !$('forward-diagnostics').hidden) $('forward-diagnostics-text').value = reportText;
    devices = (data.devices || []).slice(0, 16); mappings = data.mappings;
    if (selectedDevice && !devices.some(item => item.id === selectedDevice)) { selectedDevice = ''; renderDirection(); }
    room = data.mappings.length < data.limit;
    portsEnabled = !!data.allPorts || data.ports.length > 0;
    if (!policyReady && !data.allPorts && data.ports.length && !data.ports.includes(Number($('forward-target').value))) $('forward-target').value = data.ports[0];
    policyReady = true;
    $('forward-port-policy').textContent = data.allPorts ? reversed() ? '可自定义设备目标端口（1–65535）；服务器监听不能占用工作台管理端口。' : '可自定义目标端口（1–65535），工作台管理端口除外。' : portsEnabled ? '服务器允许的目标端口：' + data.ports.join('、') : '端口映射已在服务器禁用。';
    $('forward-list').replaceChildren();
    for (const item of data.mappings) {
      const row = document.createElement('div'); row.className = 'forward-row'; row.dataset.forward = item.id;
      const reverse = item.direction === 'reverse';
      const title = document.createElement('strong'); title.textContent = (reverse ? item.deviceName + ' · 服务器 ' : '本机 ') + '127.0.0.1:' + item.localPort + ' → ' + (reverse ? '本地设备 ' : '目标 ') + targetAddress(item);
      const direct = item.direct, relay = location.protocol === 'https:' ? 'WSS 加密中转' : '本机 WebSocket 测试';
      const route = direct?.available ? direct.family + ' / UDP 加密直连' : relay;
      const remaining = Number.isFinite(item.recoverUntil) ? Math.max(0, Math.ceil((item.recoverUntil - Date.now()) / 1000)) : 0;
      const state = document.createElement('p'); state.className = 'muted'; state.textContent = (item.state === 'active' ? '已连接 · 新连接：' + route : item.state === 'recovering' ? '正在自动恢复 · 剩余 ' + remaining + ' 秒' : item.state === 'connecting' ? item.recoverUntil ? '助手恢复握手中 · 剩余 ' + remaining + ' 秒' : reverse ? '等待本地助手确认' : '助手连接中' : '等待配对') +
        ' · ' + item.connections + '/' + data.maxConnections + ' 条连接 · 已发送 ' + item.sent + ' B / 接收 ' + item.received + ' B' + (item.error ? ' · ' + item.error : '') + (reverse && item.state === 'active' ? item.targetStatus?.state === 'reachable' ? ' · 最近一次目标连接成功' : item.targetStatus?.state === 'failed' ? ' · 最近一次目标连接失败' : ' · 目标尚未验证' : '');
      const network = document.createElement('p'); network.className = 'muted forward-network';
      network.textContent = '现有连接：直连 ' + (item.directConnections || 0) + ' / 中转 ' + (item.connections - (item.directConnections || 0)) +
        (direct?.available && Number.isInteger(direct.rttMs) ? ' · 直连往返 ' + direct.rttMs + ' ms' : '') +
        (direct?.reason && direct.note ? ' · ' + direct.note : '');
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'secondary'; stop.textContent = '停止'; stop.disabled = busy;
      stop.addEventListener('click', () => {
        if (busy || !allowed()) return;
        pendingStop = item.id;
        pendingDelete = ''; $('forward-confirm-title').textContent = '停止端口映射'; $('forward-accept-stop').textContent = '确认停止';
        $('forward-confirm-description').textContent = '停止' + (reverse ? '服务器回环端口 ' : '本机端口 ') + item.localPort + ' → ' + targetAddress(item) + ' 的映射？通过此映射建立的 TCP 连接会断开。';
        confirmation.showModal(); $('forward-cancel-stop').focus({ preventScroll: true });
      });
      const authorization = document.createElement('p'); authorization.className = 'muted forward-authorization';
      const expires = item.authorization?.expiresAt;
      authorization.textContent = (item.authorization?.createdHere ? '本次登录创建' : '其他登录创建') + ' · ' + (item.authorization?.role === 'temporary' ? '临时账号授权' : '管理员授权') + ' · ' + (Number.isSafeInteger(expires) && expires > 0 && expires < 8640000000000000 ? '登录授权到期：' + new Date(expires).toLocaleString() : '授权到期时间暂不可用') + ' · 锁屏后保留';
      if (item.errorCode) authorization.textContent += ' · 故障环节：' + forwardFaultArea(item.errorCode);
      row.append(title, state, authorization); if (item.state === 'active') row.append(network); row.append(stop); $('forward-list').append(row);
      if (reverse && item.state === 'active') { const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = '复制给 Codex'; copy.disabled = busy; copy.addEventListener('click', () => { if (!busy && allowed()) showConnection(item); }); row.append(copy); }
    }
    if (!data.mappings.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '尚未创建映射。'; $('forward-list').append(empty); }
    $('forward-recent').replaceChildren();
    if (recent.length) {
      const title = document.createElement('strong'); title.textContent = '最近结束的映射（最多八条，保留十分钟）'; $('forward-recent').append(title);
      for (const item of recent) {
        const row = document.createElement('p'); row.className = 'muted'; row.textContent = (item.direction === 'reverse' ? item.deviceName + ' · 服务器 ' : '本机 ') + item.localPort + ' → 目标 ' + targetAddress(item) + '：' + item.error;
        $('forward-recent').append(row);
      }
    }
    const codeMapping = data.mappings.find(item => item.id === codeId);
    if (codeMapping?.state === 'active') $('forward-status').textContent = codeMapping.direction === 'reverse' ? '本地助手已确认，Codex 可使用服务器回环端口访问此设备。' : '助手已连接，可以使用对应的本机端口。';
    const ended = recent.find(item => item.id === codeId);
    if (ended) $('forward-status').textContent = ended.error;
    else if (codeId && Date.now() >= codeExpires && codeMapping?.state === 'pending') $('forward-status').textContent = '配对码已过期，请重新生成。';
    if (codeId && (!codeMapping || codeMapping.state !== 'pending' || Date.now() >= codeExpires)) clearCode();
    downloads = (data.downloads || []).slice(0, 4).filter(file => Object.hasOwn(FORWARD_CLIENTS, file.arch)); renderDownloads();
    if (connectionId && !data.mappings.some(item => item.id === connectionId && item.state === 'active')) clearConnection();
    renderDevices();
    update();
    if (!portsEnabled) $('forward-status').textContent = '尚未允许目标端口，请在服务器配置 TCP_FORWARD_PORTS。';
  }
  async function load() {
    const current = generation;
    clearTimeout(timer); timer = null;
    if (!allowed() || !dialog.open || document.hidden || busy || controller) return;
    const data = await request('/api/forward');
    if (data) render(data);
    if (generation === current && allowed() && dialog.open && !document.hidden && !busy) timer = setTimeout(load, 3000);
  }
  $('forward-button').addEventListener('click', () => { cancel(); clearCode(); policyReady = false; portsEnabled = false; update(); $('forward-status').textContent = ''; $('forward-mac-help').open = platform.os === 'darwin'; dialog.showModal(); detectPlatform(); void load(); });
  $('forward-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearReport(); cancel(); clearCode(); clearConnection(); if (confirmation.open) confirmation.close(); });
  $('forward-direction').addEventListener('change', () => { clearCode(); clearConnection(); if (reversed() && $('forward-local').value === '2222') $('forward-local').value = '22001'; else if (!reversed() && $('forward-local').value === '22001') $('forward-local').value = '2222'; renderDirection(); });
  $('forward-protocol').addEventListener('change', () => { if (['22', '23'].includes($('forward-target').value)) { if ($('forward-protocol').value === 'ssh') $('forward-target').value = '22'; if ($('forward-protocol').value === 'telnet') $('forward-target').value = '23'; } });
  $('forward-device-new').addEventListener('click', () => { selectedDevice = ''; renderDirection(); });
  $('forward-connection-copy').addEventListener('click', copyConnection);
  $('forward-connection-close').addEventListener('click', clearConnection);
  $('forward-device-save').addEventListener('click', async () => {
    if (busy || !allowed() || !capabilities().manageDevices || !reversed() || !$('forward-form').reportValidity()) return;
    cancel(); const current = generation, body = { ...deviceBody(), ...(selectedDevice ? { id: selectedDevice } : {}) };
    busy = true; update(); const data = await request('/api/forward/devices', { method: 'POST', body });
    if (generation !== current || !allowed() || !dialog.open) return;
    busy = false; if (data) { selectedDevice = data.id; $('forward-device-name').value = data.name; $('forward-host').value = data.targetHost; $('forward-devices').open = true; $('forward-status').textContent = '设备资料已保存；尚未创建或改变访问授权。'; }
    renderDirection(); void load();
  });
  $('forward-refresh').addEventListener('click', () => { $('forward-status').textContent = ''; void load(); });
  $('forward-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !allowed()) return;
    if (!capabilities().directions.includes($('forward-direction').value)) return;
    cancel();
    const current = generation, body = { localPort: Number($('forward-local').value), targetHost: $('forward-host').value.trim(), targetPort: Number($('forward-target').value) };
    if (reversed()) {
      const value = deviceBody(); Object.assign(body, { direction: 'reverse', deviceName: value.name, protocol: value.protocol });
      if (selectedDevice) {
        const saved = devices.find(item => item.id === selectedDevice);
        if (!saved || ['name', 'protocol', 'localPort', 'targetHost', 'targetPort'].some(key => saved[key] !== value[key])) { $('forward-status').textContent = '设备资料有修改，请先保存，或点击“作为新设备”后配对。'; void load(); return; }
        body.deviceId = selectedDevice;
      }
    }
    busy = true; clearTimeout(timer); update(); $('forward-status').textContent = '正在生成配对码…'; clearCode();
    const data = await request('/api/forward', { method: 'POST', body });
    if (generation !== current || !allowed() || !dialog.open) return;
    busy = false; update();
    if (data) {
      codeId = data.id; codeExpires = data.expires; $('forward-code').value = data.code; $('forward-pair').hidden = false;
      $('forward-status').textContent = '配对码两分钟内有效，仅可使用一次。请运行助手并粘贴配对码。';
    }
    void load();
  });
  $('forward-copy').addEventListener('click', async () => {
    if (!$('forward-code').value || !allowed()) return;
    const current = generation, id = codeId, code = $('forward-code').value;
    const currentCode = () => generation === current && codeId === id && $('forward-code').value === code && dialog.open && allowed();
    try {
      await navigator.clipboard.writeText(code);
      if (currentCode()) $('forward-status').textContent = '配对码已复制，请粘贴到助手窗口。';
    } catch {
      if (currentCode()) { $('forward-code').focus(); $('forward-code').select(); $('forward-status').textContent = '请手动复制已选中的配对码。'; }
    }
  });
  const cancelStop = () => { pendingStop = pendingDelete = ''; confirmation.close(); };
  $('forward-cancel-stop').addEventListener('click', cancelStop);
  confirmation.addEventListener('close', () => { pendingStop = pendingDelete = ''; });
  confirmation.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); cancelStop(); } });
  $('forward-accept-stop').addEventListener('click', async () => {
    if (busy || !pendingStop && !pendingDelete || !allowed()) return;
    cancel();
    const deleting = !!pendingDelete, id = pendingDelete || pendingStop, current = generation; cancelStop(); busy = true; clearTimeout(timer); update();
    const data = await request(deleting ? '/api/forward/devices/remove' : '/api/forward/stop', { method: 'POST', body: { id } });
    if (generation !== current || !allowed() || !dialog.open) return;
    busy = false; update(); if (data) $('forward-status').textContent = deleting ? '设备条目已删除，现有授权保持不变。' : '映射已停止。'; void load();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearReport(); cancel(); clearCode(); clearConnection(); if (confirmation.open) confirmation.close(); }
    else if (dialog.open) { update(); void load(); }
  });
  window.addEventListener('pagehide', reset);
  async function copyReport() {
    if (!reportText || !allowed() || !dialog.open) return;
    const text = reportText, current = generation;
    const valid = () => generation === current && allowed() && dialog.open && reportText === text;
    $('forward-diagnostics-text').value = text; $('forward-diagnostics').hidden = false;
    try { await navigator.clipboard.writeText(text); if (valid()) $('forward-status').textContent = '脱敏报告已复制；未包含目标地址、设备名或任何凭据。'; }
    catch { if (valid()) { $('forward-diagnostics-text').focus(); $('forward-diagnostics-text').select(); $('forward-status').textContent = '请复制已选中的报告文字。'; } }
  }
  $('forward-diagnostics-copy')?.addEventListener('click', copyReport);
  $('forward-diagnostics-select')?.addEventListener('click', copyReport);
  $('forward-diagnostics-close')?.addEventListener('click', () => { $('forward-diagnostics').hidden = true; $('forward-diagnostics-text').value = ''; });
  renderDirection();
  return { update, reset };
}
