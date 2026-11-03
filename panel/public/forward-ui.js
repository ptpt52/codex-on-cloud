// The browser grants one short-lived capability; raw TCP bytes never enter it.
export function createForwardUI({ api, allowed }) {
  const $ = id => document.getElementById(id), dialog = $('forward-dialog'), confirmation = $('forward-confirm');
  let generation = 0, controller, timer, busy = false, codeId = '', codeExpires = 0, pendingStop = '', room = true;
  function clearCode() { codeId = ''; codeExpires = 0; $('forward-code').value = ''; $('forward-pair').hidden = true; }
  function cancel() { generation++; controller?.abort(); controller = null; clearTimeout(timer); timer = null; busy = false; }
  function reset() { cancel(); clearCode(); pendingStop = ''; if (confirmation.open) confirmation.close(); if (dialog.open) dialog.close(); $('forward-list').replaceChildren(); $('forward-recent').replaceChildren(); }
  function update() {
    $('forward-button').disabled = !allowed();
    if (!allowed()) reset();
    $('forward-create').disabled = !allowed() || busy || !room || !$('forward-target').options.length;
    $('forward-refresh').disabled = !allowed() || busy;
    $('forward-local').disabled = $('forward-target').disabled = busy;
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
        '结果未知，请刷新列表确认，不要重复创建或停止。' : error.message;
      return null;
    } finally { clearTimeout(deadline); if (controller === abort) controller = null; }
  }
  function render(data) {
    const recent = data.recent || [];
    room = data.mappings.length < data.limit;
    const target = $('forward-target'), selected = target.value;
    target.replaceChildren(...data.ports.map(port => { const option = document.createElement('option'); option.value = port; option.textContent = '服务器 127.0.0.1:' + port; return option; }));
    if ([...target.options].some(option => option.value === selected)) target.value = selected;
    $('forward-list').replaceChildren();
    for (const item of data.mappings) {
      const row = document.createElement('div'); row.className = 'forward-row'; row.dataset.forward = item.id;
      const title = document.createElement('strong'); title.textContent = '本机 127.0.0.1:' + item.localPort + ' → 服务器 127.0.0.1:' + item.targetPort;
      const direct = item.direct, relay = location.protocol === 'https:' ? 'WSS 加密中转' : '本机 WebSocket 测试';
      const route = direct?.available ? direct.family + ' / UDP 加密直连' : relay;
      const state = document.createElement('p'); state.className = 'muted'; state.textContent = (item.state === 'active' ? '已连接 · 新连接：' + route : item.state === 'connecting' ? '助手连接中' : '等待配对') +
        ' · ' + item.connections + '/' + data.maxConnections + ' 条连接 · 已发送 ' + item.sent + ' B / 接收 ' + item.received + ' B' + (item.error ? ' · ' + item.error : '');
      const network = document.createElement('p'); network.className = 'muted forward-network';
      network.textContent = '现有连接：直连 ' + (item.directConnections || 0) + ' / 中转 ' + (item.connections - (item.directConnections || 0)) +
        (direct?.available && Number.isInteger(direct.rttMs) ? ' · 直连往返 ' + direct.rttMs + ' ms' : '') +
        (direct?.reason && direct.note ? ' · ' + direct.note : '');
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'secondary'; stop.textContent = '停止'; stop.disabled = busy;
      stop.addEventListener('click', () => {
        if (busy || !allowed()) return;
        pendingStop = item.id;
        $('forward-confirm-description').textContent = '停止本机端口 ' + item.localPort + ' 的映射？通过此映射建立的 TCP 连接会断开。';
        confirmation.showModal(); $('forward-cancel-stop').focus({ preventScroll: true });
      });
      row.append(title, state); if (item.state === 'active') row.append(network); row.append(stop); $('forward-list').append(row);
    }
    if (!data.mappings.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '尚未创建映射。'; $('forward-list').append(empty); }
    $('forward-recent').replaceChildren();
    if (recent.length) {
      const title = document.createElement('strong'); title.textContent = '最近结束的映射（最多八条，保留十分钟）'; $('forward-recent').append(title);
      for (const item of recent) {
        const row = document.createElement('p'); row.className = 'muted'; row.textContent = '本机 ' + item.localPort + ' → 服务器 ' + item.targetPort + '：' + item.error;
        $('forward-recent').append(row);
      }
    }
    const codeMapping = data.mappings.find(item => item.id === codeId);
    if (codeMapping?.state === 'active') $('forward-status').textContent = '助手已连接，可以使用对应的本机端口。';
    const ended = recent.find(item => item.id === codeId);
    if (ended) $('forward-status').textContent = ended.error;
    else if (codeId && Date.now() >= codeExpires && codeMapping?.state === 'pending') $('forward-status').textContent = '配对码已过期，请重新生成。';
    if (codeId && (!codeMapping || codeMapping.state !== 'pending' || Date.now() >= codeExpires)) clearCode();
    $('forward-downloads').replaceChildren();
    for (const file of data.downloads) {
      const row = document.createElement('div'), link = document.createElement('a'), hash = document.createElement('small');
      row.className = 'forward-download'; link.href = file.href; link.download = file.name; link.textContent = file.arch === 'windows-amd64' ? '下载 Windows x64 助手' : '下载 Windows ARM64 助手';
      hash.textContent = '版本：' + file.build + ' · SHA256：' + file.sha256; row.append(link, hash); $('forward-downloads').append(row);
    }
    if (!data.downloads.length) $('forward-downloads').textContent = '助手暂时无法下载，请在服务器完成助手构建后刷新列表。';
    $('forward-create').disabled = busy || !data.ports.length || data.mappings.length >= data.limit;
    if (!data.ports.length) $('forward-status').textContent = '尚未允许目标端口，请在服务器配置 TCP_FORWARD_PORTS。';
  }
  async function load() {
    const current = generation;
    clearTimeout(timer); timer = null;
    if (!allowed() || !dialog.open || document.hidden || busy || controller) return;
    const data = await request('/api/forward');
    if (data) render(data);
    if (generation === current && allowed() && dialog.open && !document.hidden && !busy) timer = setTimeout(load, 3000);
  }
  $('forward-button').addEventListener('click', () => { cancel(); clearCode(); $('forward-status').textContent = ''; dialog.showModal(); void load(); });
  $('forward-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { cancel(); clearCode(); if (confirmation.open) confirmation.close(); });
  $('forward-refresh').addEventListener('click', () => { $('forward-status').textContent = ''; void load(); });
  $('forward-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !allowed()) return;
    cancel();
    const current = generation, body = { localPort: Number($('forward-local').value), targetPort: Number($('forward-target').value) };
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
  const cancelStop = () => { pendingStop = ''; confirmation.close(); };
  $('forward-cancel-stop').addEventListener('click', cancelStop);
  confirmation.addEventListener('close', () => { pendingStop = ''; });
  confirmation.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); cancelStop(); } });
  $('forward-accept-stop').addEventListener('click', async () => {
    if (busy || !pendingStop || !allowed()) return;
    cancel();
    const id = pendingStop, current = generation; cancelStop(); busy = true; clearTimeout(timer); update();
    const data = await request('/api/forward/stop', { method: 'POST', body: { id } });
    if (generation !== current || !allowed() || !dialog.open) return;
    busy = false; update(); if (data) $('forward-status').textContent = '映射已停止。'; void load();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancel(); clearCode(); if (confirmation.open) confirmation.close(); }
    else if (dialog.open) { update(); void load(); }
  });
  window.addEventListener('pagehide', reset);
  update();
  return { update, reset };
}
