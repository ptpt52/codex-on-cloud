const $ = id => document.getElementById(id), prefix = '/__nodes/';
let state = null, csrf = '', offset = 0, generation = 0, busy = false, pending = null, loading = false, lifecycle = 0, suspended = false;
let probeController, codesController, enrollmentGeneration = 0;
const controllers = new Set();
const current = epoch => epoch === lifecycle && !suspended;
function stopProbes() { probeController?.abort(); probeController = undefined; }
function update() { for (const id of ['refresh', 'previous', 'next', 'create-code']) $(id).disabled = busy || loading; for (const button of document.querySelectorAll('[data-action]')) button.disabled = busy || loading || button.dataset.current === 'true'; }
function message(value, error = false) { $('status').textContent = value; $('status').classList.toggle('error', error); }
function resetEnrollment() {
  enrollmentGeneration++;
  $('enrollment').open = false;
  $('codes').replaceChildren();
  $('code-name').value = $('code-value').value = '';
  $('new-code').hidden = true;
}
function loggedOut(note = '') {
  lifecycle++; generation++; stopProbes();
  for (const controller of controllers) controller.abort();
  controllers.clear(); state = null; csrf = ''; busy = loading = false;
  closeConfirmation(); resetEnrollment();
  $('boot-status').hidden = true; $('workspace').hidden = $('logout').hidden = true;
  $('login').hidden = false; $('login-submit').disabled = false; $('login-error').textContent = note;
}
async function api(path, { method = 'GET', body, signal } = {}) {
  const epoch = lifecycle;
  if (!current(epoch)) throw new DOMException('页面已离开', 'AbortError');
  const controller = new AbortController(); controllers.add(controller); const timer = setTimeout(() => controller.abort(), 10000);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(prefix + 'api/' + path, { method, credentials: 'same-origin', redirect: 'error', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: requestSignal });
    let value; try { value = await response.json(); } catch { throw Error('响应未确认，请刷新状态核对'); }
    requestSignal.throwIfAborted();
    if (!current(epoch)) throw new DOMException('页面已离开', 'AbortError');
    if (response.status === 401 && path !== 'login') loggedOut('网关登录已过期');
    if (!response.ok) throw Object.assign(Error(value.error || '请求未完成'), { status: response.status });
    return value;
  } finally { clearTimeout(timer); controllers.delete(controller); }
}
function health(value) { return value.ready === true ? '就绪' : value.ready === false ? '当前不可用' : '尚未检查'; }
function renderHealth(row, node) { row.querySelector('.node-health').textContent = health(node) + (node.checkedAt ? ' · ' + new Date(node.checkedAt).toLocaleTimeString() + ' 检查' : ''); }
function render() {
  $('nodes').replaceChildren(); $('active-name').textContent = state.activeName || '尚未选择'; $('enter').hidden = !state.activeId;
  $('summary').textContent = `已接入 ${state.total} 台机器` + (state.pending ? ' · 正在核对一次切换' : '');
  $('previous').hidden = !offset; $('next').hidden = state.next === null; $('page').textContent = state.total ? `第 ${Math.floor(offset / 16) + 1} 页` : '';
  if (!state.nodes.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '这一页还没有节点。接入新机器后刷新列表。'; $('nodes').append(empty); }
  for (const node of state.nodes) {
    const row = document.createElement('article'); row.className = 'node-row'; row.dataset.nodeId = node.id;
    const details = document.createElement('div'); details.className = 'node-details'; const title = document.createElement('h3'); title.textContent = node.name;
    if (node.id === state.activeId) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '当前'; title.append(badge); }
    const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${node.mode === 'terminal' ? '网页终端' : '桌面'} · ${node.id.slice(0, 8)}`;
    const status = document.createElement('p'); status.className = 'muted node-health'; details.append(title, meta, status);
    const actions = document.createElement('div'); actions.className = 'node-actions'; const select = document.createElement('button'); select.type = 'button'; select.dataset.action = 'select'; select.dataset.current = String(node.id === state.activeId); select.textContent = node.id === state.activeId ? '当前节点' : '检查并切换'; select.addEventListener('click', () => confirm('switch', node)); actions.append(select);
    if (node.id !== state.activeId) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary danger'; remove.dataset.action = 'remove'; remove.textContent = '移除'; remove.addEventListener('click', () => confirm('remove', node)); actions.append(remove); }
    row.append(details, actions); $('nodes').append(row); renderHealth(row, node);
  }
  update();
}
async function probes(epoch) {
  if (!state || busy || epoch !== generation) return;
  stopProbes();
  const controller = probeController = new AbortController();
  const nodes = [...state.nodes]; let index = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, nodes.length) }, async () => {
      while (index < nodes.length && !controller.signal.aborted && epoch === generation && state && !busy) {
        const node = nodes[index++]; try {
          const value = await api('probe', { method: 'POST', body: { nodeId: node.id }, signal: controller.signal });
          if (epoch !== generation || !state) return; Object.assign(node, value);
          const row = [...$('nodes').children].find(row => row.dataset.nodeId === node.id); if (row) renderHealth(row, node);
        } catch { /* A failed probe leaves the last known status. */ }
      }
    }));
  } finally { if (probeController === controller) probeController = undefined; }
}
async function load(probe = true) {
  if (suspended) return;
  stopProbes();
  const epoch = ++generation; loading = true; update();
  try {
    const value = await api('nodes?offset=' + offset); if (epoch !== generation) return;
    if (!value || value.version !== 1 || !Array.isArray(value.nodes) || value.nodes.length > 16 || typeof value.csrf !== 'string' || !Number.isSafeInteger(value.revision)) throw Error('节点列表响应无效');
    state = value; csrf = value.csrf; $('boot-status').hidden = true; $('login').hidden = true; $('workspace').hidden = $('logout').hidden = false; render();
    if (probe) void probes(epoch);
    return true;
  } catch (error) { if (epoch === generation) { if (!state || error.status === 401) loggedOut(error.status === 401 ? '' : error.message); else message(error.message, true); } }
  finally { if (epoch === generation) { loading = false; update(); } }
}
function closeConfirmation() { pending = null; if ($('confirmation').open) $('confirmation').close(); }
function confirm(kind, node) {
  if (!state || busy || loading || pending) return;
  pending = { kind, node, revision: state.revision };
  $('confirmation-title').textContent = kind === 'switch' ? `切换到“${node.name}”？` : `移除“${node.name}”？`;
  $('confirmation-description').textContent = kind === 'switch' ? '检查就绪后更新默认入口并进入该节点。原机器上的任务继续运行，已发送操作不会重发。' : '只移除网关中的登记，机器上的任务、工作区和 Tunnel 继续保留。';
  $('accept').textContent = kind === 'switch' ? '确认切换' : '确认移除'; $('confirmation').showModal(); $('cancel').focus();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || suspended) return; const epoch = lifecycle;
  busy = true; $('login-submit').disabled = true; $('login-error').textContent = '';
  try { await api('login', { method: 'POST', body: { password: $('password').value } }); if (!current(epoch)) return; $('password').value = ''; offset = 0; await load(false); }
  catch (error) { if (current(epoch)) $('login-error').textContent = error.message; }
  finally { if (current(epoch)) { busy = false; $('login-submit').disabled = false; update(); if (state) void probes(generation); } }
});
$('logout').addEventListener('click', async () => {
  if (busy || suspended) return; const epoch = lifecycle; busy = true;
  try { await api('logout', { method: 'POST', body: {} }); if (current(epoch)) loggedOut(); }
  catch (error) { if (current(epoch)) message(error.message, true); }
  finally { if (current(epoch)) { busy = false; update(); } }
});
$('refresh').addEventListener('click', () => { const epoch = lifecycle; message('正在刷新节点状态…'); void load().then(loaded => { if (loaded && current(epoch)) message('列表已刷新；状态为最近一次检查结果。'); }); });
$('previous').addEventListener('click', () => { if (!busy && offset) { offset = Math.max(0, offset - 16); void load(); } });
$('next').addEventListener('click', () => { if (!busy && state?.next !== null) { offset = state.next; void load(); } });
$('cancel').addEventListener('click', closeConfirmation); $('confirmation').addEventListener('cancel', event => { event.preventDefault(); closeConfirmation(); });
$('confirmation').addEventListener('keydown', event => { if (event.key === 'Enter' && document.activeElement !== $('accept')) { event.preventDefault(); closeConfirmation(); } });
$('accept').addEventListener('click', async () => {
  const action = pending; if (!action || busy || !state || suspended) return; const epoch = lifecycle; closeConfirmation(); busy = true; generation++; stopProbes(); update();
  const operation = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    if (action.kind === 'remove') { await api('nodes/' + action.node.id, { method: 'DELETE', body: { revision: action.revision } }); if (!current(epoch)) return; offset = 0; await load(); if (current(epoch)) message('节点登记已移除，原机器和任务保持。'); }
    else {
      message('正在检查目标节点并切换…'); const value = await api('switch', { method: 'POST', body: { nodeId: action.node.id, revision: action.revision, operation } });
      if (!current(epoch)) return;
      if (value.ok !== true || value.activeId !== action.node.id || value.operation !== operation) throw Error('切换响应未确认');
      location.assign('/');
    }
  } catch (error) { if (!current(epoch)) return; await load(false); if (!current(epoch)) return; if (state?.lastSwitch?.id === operation && state.activeId === action.node.id) message(`已核对入口是“${action.node.name}”，可点击“进入当前节点”。`); else message(error.status ? error.message : '切换或移除结果未知，请刷新状态核对；不会自动重试。', true); }
  finally { if (current(epoch)) { busy = false; update(); } }
});
async function loadCodes() {
  codesController?.abort();
  if (!$('enrollment').open) return;
  const epoch = lifecycle, controller = codesController = new AbortController();
  let value;
  try { value = await api('codes', { signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted && current(epoch)) throw error; return; }
  finally { if (codesController === controller) codesController = undefined; }
  if (controller.signal.aborted || !current(epoch) || !$('enrollment').open) return;
  $('codes').replaceChildren();
  for (const code of (value.codes || []).slice(0, 16)) {
    const row = document.createElement('li'), name = document.createElement('span'), button = document.createElement('button'); name.textContent = code.name; button.className = 'secondary'; button.textContent = '撤销'; button.type = 'button';
    button.addEventListener('click', async () => { if (!current(epoch)) return; button.disabled = true; try { await api('codes/' + code.id, { method: 'DELETE', body: {} }); if (current(epoch)) await loadCodes(); } catch (error) { if (current(epoch)) { message(error.message, true); button.disabled = false; } } }); row.append(name, button); $('codes').append(row);
  }
}
$('enrollment').querySelector('summary').addEventListener('click', () => {
  if ($('enrollment').open) enrollmentGeneration++;
});
$('enrollment').addEventListener('toggle', () => { const epoch = lifecycle; if ($('enrollment').open && state && current(epoch)) void loadCodes().catch(error => { if (current(epoch)) message(error.message, true); }); else { enrollmentGeneration++; codesController?.abort(); $('code-value').value = ''; $('new-code').hidden = true; } });
$('code-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || loading || suspended) return; const epoch = lifecycle, enrollment = enrollmentGeneration; busy = true; update();
  try {
    const value = await api('codes', { method: 'POST', body: { name: $('code-name').value } });
    if (!current(epoch)) return;
    if (enrollment !== enrollmentGeneration || !$('enrollment').open) {
      message('接入码已创建，面板关闭后无法再显示该接入码；可在列表中撤销。');
    } else { $('code-value').value = value.code; $('new-code').hidden = false; }
    await loadCodes();
  }
  catch (error) { if (current(epoch)) message(error.message, true); }
  finally { if (current(epoch)) { busy = false; update(); } }
});
$('copy-code').addEventListener('click', async () => { const epoch = lifecycle; try { await navigator.clipboard.writeText($('code-value').value); if (current(epoch)) message('接入码已复制，请仅提供给自己的节点。'); } catch { if (current(epoch)) { $('code-value').focus(); $('code-value').select(); message('请手动复制已选中的接入码。'); } } });
window.addEventListener('pagehide', () => {
  suspended = true; lifecycle++; generation++;
  stopProbes();
  for (const controller of controllers) controller.abort(); controllers.clear();
  state = null; csrf = ''; busy = false; loading = true; closeConfirmation();
  $('login-submit').disabled = false; $('password').value = ''; resetEnrollment();
  $('workspace').hidden = $('logout').hidden = $('login').hidden = true; $('boot-status').hidden = false; update();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  const epoch = lifecycle;
  suspended = false; message('正在重新核对网关登录与节点状态…');
  // Restore with reads only. Interrupted switches, removals, logins and
  // enrollment mutations may already have committed and must never be replayed.
  void load(false).then(loaded => { if (loaded && current(epoch)) message('网关登录与节点状态已重新核对；未重发离开前的操作。'); });
});
if (new URLSearchParams(location.search).has('unavailable')) message('当前节点暂不可用，可选择其他已接入机器。', true);
void load();
