const list = document.getElementById('node-list'), status = document.getElementById('home-status');
const count = document.getElementById('node-count'), empty = document.getElementById('home-empty');
const refresh = document.getElementById('refresh-nodes'), section = document.querySelector('.home-nodes');
let timer, pending, stopped = false, previous = '';

function render(nodes) {
  const snapshot = JSON.stringify(nodes);
  if (previous !== snapshot) {
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('a')?.getAttribute('href') : null;
    const entries = nodes.map(node => {
      const item = document.createElement('li'), link = document.createElement('a');
      link.className = 'home-node'; link.href = node.path;
      const meta = document.createElement('span'); meta.className = 'home-node-meta';
      const mode = document.createElement('span'); mode.textContent = node.mode === 'terminal' ? '网页终端' : '开发桌面';
      const online = document.createElement('span'); online.className = 'status online'; online.textContent = '在线';
      meta.append(mode, online);
      const name = document.createElement('strong'); name.textContent = node.name;
      const path = document.createElement('span'); path.className = 'mono'; path.textContent = node.path;
      const action = document.createElement('span'); action.className = 'home-node-action'; action.textContent = '进入节点 →';
      link.append(meta, name, path, action); item.append(link); return item;
    });
    list.replaceChildren(...entries); previous = snapshot;
    if (focused) (list.querySelector(`a[href="${focused}"]`) || document.getElementById('nodes-title')).focus();
  }
  count.textContent = nodes.length + ' 个在线'; count.hidden = false;
  empty.hidden = nodes.length !== 0;
}

async function load() {
  if (stopped || document.hidden || pending) return;
  clearTimeout(timer);
  const controller = new AbortController(); pending = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  refresh.disabled = true; section.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/public/nodes', { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw Error();
    const value = await response.json();
    if (!Array.isArray(value.nodes) || value.nodes.length > 64 || !value.nodes.every(node =>
      node && typeof node.name === 'string' && node.name.length <= 80 && /^\/node\/[a-z0-9-]{1,48}\/$/.test(node.path) && ['desktop', 'terminal'].includes(node.mode))) throw Error();
    if (stopped) return;
    render(value.nodes); status.className = 'muted'; status.textContent = '每 15 秒自动更新，也可手动刷新。';
  } catch {
    if (stopped || controller.signal.reason === 'pagehide') return;
    // Do not leave stale nodes labelled online after a failed refresh.
    render([]); count.hidden = true; empty.hidden = true;
    status.className = 'error'; status.textContent = '节点列表暂不可用，请稍后刷新重试。';
  } finally {
    clearTimeout(timeout); pending = null; refresh.disabled = false; section.setAttribute('aria-busy', 'false');
    if (!stopped && !document.hidden) timer = setTimeout(load, controller.signal.reason === 'pagehide' ? 0 : 15000);
  }
}

refresh.addEventListener('click', load);
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void load(); });
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); pending?.abort('pagehide'); });
window.addEventListener('pageshow', () => { stopped = false; void load(); });
void load();
