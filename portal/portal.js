import { parseNodeDirectory, readNodeDirectoryResponse, decodePortalCode } from './node-directory.js';
const $ = id => document.getElementById(id);
let state, busy = false, editing = null, deleting = null, revision = 0, exportURL, requestController, generation = 0;
const directoryOf = value => parseNodeDirectory({ version: value.version, portalOrigin: value.portalOrigin, nodes: value.nodes });
function message(text) { $('portal-status').textContent = text; }
function clearCode() { $('enrollment-code').value = ''; $('code-status').textContent = ''; if ($('portal-code').open) $('portal-code').close(); }
function cancelPending() { generation++; requestController?.abort(); requestController = null; setBusy(false); }
function signedOut() {
  cancelPending();
  state = null; editing = deleting = null; clearCode();
  for (const id of ['portal-editor', 'portal-delete', 'portal-codes']) if ($(id).open) $(id).close();
  $('portal-workspace').hidden = $('portal-logout').hidden = true; $('portal-login').hidden = false; $('portal-nodes').replaceChildren(); $('portal-password').value = '';
}
function setBusy(value) { busy = value; for (const button of document.querySelectorAll('button')) button.disabled = value; for (const field of document.querySelectorAll('input,select')) field.disabled = value || (field.id === 'node-id' && !!editing); }
async function api(path, method = 'GET', body) {
  const current = generation, controller = new AbortController(); requestController = controller;
  const response = await fetch(path, { method, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(state?.csrf ? { 'x-csrf-token': state.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (current !== generation) throw new DOMException('操作已关闭', 'AbortError');
  if (response.status === 401) { signedOut(); message('请登录门户；如果刚才在登录，请检查密码'); throw Error('请登录门户；如果刚才在登录，请检查密码'); }
  const value = await readNodeDirectoryResponse(response, 40960);
  if (current !== generation) throw new DOMException('操作已关闭', 'AbortError');
  if (requestController === controller) requestController = null;
  if (!response.ok) throw Error(value.error || '请求失败');
  return value;
}
async function perform(work, errorTarget = $('portal-status')) {
  if (busy) return; const current = generation; setBusy(true);
  try { await work(); } catch (error) { if (current === generation) errorTarget.textContent = error.name === 'TimeoutError' ? '请求超时，操作结果可能未知；请刷新检查，不会自动重试。' : error.message; }
  finally { if (current === generation) { setBusy(false); if (state) render(); } }
}
function accept(value) {
  const directory = directoryOf(value);
  if (directory.portalOrigin !== location.origin || !Number.isSafeInteger(value.revision) || typeof value.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(value.csrf) || !Array.isArray(value.registeredIds) || value.registeredIds.length > 32) throw Error('门户目录响应无效');
  state = { ...directory, revision: value.revision, csrf: value.csrf, registeredIds: value.registeredIds };
  $('portal-login').hidden = true; $('portal-workspace').hidden = $('portal-logout').hidden = false; render();
}
async function refresh() { accept(await api('/api/nodes')); message(`${state.nodes.length} 台服务器 · 目录已更新`); }
function openEditor(node = null) {
  if (busy || !state) return;
  editing = node?.id || null; revision = state.revision;
  $('editor-title').textContent = node ? '编辑服务器' : '新增服务器';
  for (const key of ['id', 'name', 'origin', 'description']) $('node-' + key).value = node?.[key] || '';
  $('node-id').disabled = !!node; $('node-mode').value = node?.mode || 'desktop'; $('node-enabled').checked = node?.enabled ?? false; $('node-error').textContent = '';
  $('portal-editor').showModal(); $('node-cancel').focus();
}
async function loadCodes() {
  const value = await api('/api/authorization-codes');
  if (!Array.isArray(value.codes) || value.codes.length > 16) throw Error('授权码列表无效');
  $('authorization-code-list').replaceChildren();
  for (const code of value.codes) {
    if (!/^[a-f0-9]{32}$/.test(code.id) || typeof code.name !== 'string') throw Error('授权码列表无效');
    const row = document.createElement('div'); row.className = 'code-row';
    const name = document.createElement('span'); name.textContent = code.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除授权码'; remove.dataset.codeId = code.id;
    remove.addEventListener('click', () => { deleting = { ...code, kind: 'code' }; $('delete-title').textContent = '删除授权码？'; $('delete-accept').textContent = '确认删除授权码'; $('delete-destination').textContent = code.name; $('delete-effect').textContent = '删除后禁止使用此码注册新节点，已注册节点保持接入，各服务器继续独立运行。'; $('portal-delete').showModal(); $('delete-cancel').focus(); });
    row.append(name, remove); $('authorization-code-list').append(row);
  }
}

function render() {
  $('portal-nodes').replaceChildren(); if (!state) return;
  for (const node of state.nodes) {
    const card = document.createElement('article'); card.className = 'node-card'; card.dataset.nodeId = node.id;
    const title = document.createElement('h2'); title.textContent = node.name;
    const address = document.createElement('p'); address.className = 'node-address'; address.textContent = new URL(node.origin).host;
    const kind = document.createElement('p'); kind.className = 'node-kind'; kind.textContent = `${node.mode === 'terminal' ? '网页终端' : '桌面与网页终端'} · ${state.registeredIds.includes(node.id) ? '已注册' : '未注册'} · ${node.enabled ? '已启用' : state.registeredIds.includes(node.id) ? '已停用' : '待部署'}`;
    const description = document.createElement('p'); description.textContent = node.description;
    const enter = document.createElement(node.enabled ? 'a' : 'p');
    if (node.enabled) { enter.href = node.origin + '/'; enter.rel = 'noreferrer'; enter.textContent = '进入服务器 →'; enter.setAttribute('aria-label', '进入 ' + node.name); }
    else { enter.className = 'node-pending'; enter.textContent = '入口未启用'; }
    const actions = document.createElement('div'); actions.className = 'toolbar';
    for (const [label, action, handler] of [ ['编辑', 'edit', () => openEditor(node)], ['删除', 'delete', () => { deleting = { ...node, kind: 'node', revision: state.revision }; $('delete-title').textContent = '删除服务器入口？'; $('delete-accept').textContent = '确认删除入口'; $('delete-effect').textContent = '只移除目录入口和该节点的目录访问凭据。服务器、任务及端口映射继续运行。'; $('delete-destination').textContent = node.name + ' · ' + new URL(node.origin).host; $('portal-delete').showModal(); $('delete-cancel').focus(); }] ]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.action = action; button.disabled = busy; button.addEventListener('click', handler); actions.append(button);
    }
    card.append(title, address, kind, description, enter, actions); $('portal-nodes').append(card);
  }
  $('portal-add').disabled = busy || state.nodes.length >= 32;
}
$('portal-login-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { const password = $('portal-password').value; $('portal-password').value = ''; await api('/api/login', 'POST', { password }); await refresh(); }); });
$('portal-refresh').addEventListener('click', () => void perform(refresh));
$('portal-logout').addEventListener('click', () => void perform(async () => { await api('/api/logout', 'POST', {}); signedOut(); message('已退出门户，节点登录及任务保留。'); }));
$('portal-add').addEventListener('click', () => openEditor());
$('node-cancel').addEventListener('click', () => $('portal-editor').close());
$('portal-node-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => {
  const node = { id: $('node-id').value, name: $('node-name').value, origin: $('node-origin').value, description: $('node-description').value, mode: $('node-mode').value, enabled: $('node-enabled').checked };
  parseNodeDirectory({ version: 1, portalOrigin: location.origin, nodes: [node] });
  accept(await api(editing ? '/api/nodes/' + editing : '/api/nodes', editing ? 'PUT' : 'POST', { revision, node })); $('portal-editor').close(); message('服务器目录已保存。');
}, $('node-error')); });
$('delete-cancel').addEventListener('click', () => { deleting = null; $('portal-delete').close(); });
$('portal-delete').addEventListener('close', () => { deleting = null; });
$('portal-delete').addEventListener('keydown', event => { if (event.key === 'Enter' && document.activeElement !== $('delete-accept')) { event.preventDefault(); $('delete-cancel').click(); } });
$('delete-accept').addEventListener('click', () => { if (!$('portal-delete').open) return; void perform(async () => { const target = deleting; if (!target) return; deleting = null; $('portal-delete').close(); if (target.kind === 'code') { await api('/api/authorization-codes/' + target.id, 'DELETE', {}); await loadCodes(); message('已删除授权码，已注册节点保持接入。'); } else { accept(await api('/api/nodes/' + target.id, 'DELETE', { revision: target.revision })); message('已移除入口，节点继续独立运行。'); } }); });
$('portal-enroll').addEventListener('click', () => void perform(async () => { await loadCodes(); $('portal-codes').showModal(); $('codes-close').focus(); }));
$('codes-close').addEventListener('click', () => $('portal-codes').close());
$('portal-codes').addEventListener('close', () => { clearCode(); if (busy) { cancelPending(); message('窗口已关闭；在途操作结果可能未知，请重新打开检查，不会自动重试。'); } });
$('authorization-code-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { const name = $('authorization-code-name').value; const value = await api('/api/authorization-codes', 'POST', { name }); decodePortalCode(value.code); clearCode(); $('authorization-code-name').value = ''; await loadCodes(); $('code-target').textContent = value.name; $('enrollment-code').value = value.code; $('portal-code').showModal(); $('code-close').focus(); }); });
$('code-close').addEventListener('click', clearCode);
$('portal-code').addEventListener('close', () => { $('enrollment-code').value = ''; });
$('code-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('enrollment-code').value); $('code-status').textContent = '授权码已复制。'; } catch { $('enrollment-code').focus(); $('enrollment-code').select(); $('code-status').textContent = '请复制已选中的授权码。'; } });
$('portal-export').addEventListener('click', () => { if (!state) return; if (exportURL) URL.revokeObjectURL(exportURL); exportURL = URL.createObjectURL(new Blob([JSON.stringify(directoryOf(state), null, 2) + '\n'], { type: 'application/json' })); const link = document.createElement('a'); link.href = exportURL; link.download = 'codex-servers.json'; link.click(); });
window.addEventListener('pagehide', () => { signedOut(); if (exportURL) URL.revokeObjectURL(exportURL); });
window.addEventListener('pageshow', event => { if (event.persisted) void perform(refresh); });
void perform(refresh);
