import { FORWARD_CLIENTS, forwardOS, detectForwardClient } from './forward-platform.js';
import { nodeLink } from './node-scope.js';
import { rtcRouteKind, rtcRouteLabel } from './rtc-stats.js';
import { createForwardAgentsUI } from './forward-agents-ui.js';

export function createForwardUI({ api, allowed, hints = () => ({}), capabilities = () => ({ manageDevices: true }),
  prepareDownloads = () => false, downloadClient = () => null, downloadRoute = () => null, saveDownload }) {
  const $ = id => document.getElementById(id), dialog = $('forward-dialog');
  let generation = 0, controller, timer, downloads = [], detection, downloadController, downloadMessage = '', downloadSignature = '';
  let platform = { os: forwardOS(navigator), arch: null };
  const agentsUI = createForwardAgentsUI({ api, hints, allowed: () => allowed() && (capabilities().manageDevices || capabilities().viewHelperKeys), canManage: () => capabilities().manageDevices, visible: () => dialog.open && !document.hidden });
  function downloadStatus() {
    const path = { direct: '直连', relay: 'TURN 中继', unknown: '路径待确认' }[rtcRouteKind(downloadRoute())];
    $('forward-download-status').textContent = downloadMessage || (downloadClient() && globalThis.crypto?.subtle ? `助手下载：WebRTC 加密通道已就绪（${path}）` : '助手下载：HTTPS；WebRTC 就绪后优先使用');
  }
  function cancelDownload() { const old = downloadController; downloadController = undefined; old?.abort(); downloadMessage = ''; downloadStatus(); }
  async function downloadHelper(file, href) {
    if (downloadController || !allowed()) return;
    const request = downloadController = new AbortController(), live = () => downloadController === request && !request.signal.aborted && allowed();
    try {
      if (!Object.hasOwn(FORWARD_CLIENTS, file.arch) || file.name !== FORWARD_CLIENTS[file.arch].name || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('助手下载信息无效，请刷新列表');
      downloadMessage = '正在准备助手下载…'; downloadStatus();
      const deadline = performance.now() + 1500;
      let client = downloadClient();
      while (!client && live() && performance.now() < deadline && prepareDownloads()) {
        await new Promise(resolve => setTimeout(resolve, 50)); client = downloadClient();
      }
      if (!live()) return;
      if (!client || !globalThis.crypto?.subtle) {
        const link = document.createElement('a'); link.href = href; link.download = file.name;
        document.body.append(link); link.click(); link.remove();
        downloadMessage = '已开始通过 HTTPS 下载助手'; downloadStatus(); return;
      }
      if (client.busy) throw Error('文件通道正在传输，请完成后再下载助手');
      const url = new URL(href, location.origin), versions = url.searchParams.getAll('generation');
      if (versions.length > 1 || versions.length && !/^[a-f0-9]{32}$/.test(versions[0])) throw Error('助手版本信息无效，请刷新列表');
      const helper = { arch: file.arch, ...(versions.length ? { generation: versions[0] } : {}) };
      let lastUpdate = -Infinity;
      downloadMessage = `正在通过 ${rtcRouteLabel(downloadRoute())} 下载助手…`; downloadStatus();
      const blob = await client.downloadHelper(helper, file.size, request.signal, (received, size) => {
        if (!live() || performance.now() - lastUpdate < 100 && received !== size) return;
        lastUpdate = performance.now(); downloadMessage = `正在通过 ${rtcRouteLabel(downloadRoute())} 下载助手：` + Math.floor(received * 100 / size) + '%'; downloadStatus();
      });
      if (!live()) return;
      downloadMessage = '正在校验助手文件…'; downloadStatus();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      if (!live()) return;
      const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (blob.size !== file.size || actual !== file.sha256) throw Error('助手文件校验失败，请刷新下载列表后重试');
      saveDownload(blob, file.name); downloadMessage = '助手已通过 WebRTC 下载，SHA256 校验通过'; downloadStatus();
    } catch (error) {
      if (live()) { downloadMessage = (error.message || '助手下载失败') + '；请手动重试'; downloadStatus(); }
    } finally { if (downloadController === request) downloadController = undefined; }
  }
  function renderDownloads() {
    const signature = JSON.stringify([platform, downloads]); if (signature === downloadSignature) return; downloadSignature = signature;
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
      const row = document.createElement('div'), link = document.createElement('a'), hash = document.createElement('small'), details = document.createElement('details'), summary = document.createElement('summary');
      row.className = 'forward-download'; row.dataset.arch = file.arch;
      link.href = nodeLink(file.href); link.download = file.name; link.textContent = '下载 ' + FORWARD_CLIENTS[file.arch].label + ' 助手';
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (downloadController) { event.preventDefault(); return; }
        if (!allowed()) { event.preventDefault(); return; }
        if ((!downloadClient() && !prepareDownloads()) || !saveDownload) { downloadMessage = '已开始通过 HTTPS 下载助手'; downloadStatus(); return; }
        event.preventDefault(); void downloadHelper(file, link.href);
      });
      if (file.arch === platform.arch) { row.classList.add('recommended'); link.setAttribute('aria-description', '推荐版本'); }
      summary.textContent = '版本与 SHA256'; hash.textContent = '版本：' + file.build + ' · SHA256：' + file.sha256;
      details.className = 'forward-download-integrity'; details.append(summary, hash); row.append(link, details); target.append(row);
    }
    if (!downloads.length) target.textContent = '助手暂时无法下载，请在服务器完成助手构建后刷新列表。';
    const hasMac = downloads.some(file => FORWARD_CLIENTS[file.arch].os === 'darwin');
    $('forward-mac-help').hidden = !hasMac;
    const notice = $('forward-mac-notice'); if (notice) notice.hidden = !hasMac;
  }
  function detectPlatform() {
    detection ||= detectForwardClient(navigator).then(value => { platform = value; if (dialog.open && allowed()) renderDownloads(); });
  }

  function cancel() { generation++; controller?.abort(); controller = null; clearTimeout(timer); timer = null; }
  function update() {
    $('forward-button').disabled = !allowed();
    if (!allowed()) reset();
    $('forward-description').textContent = capabilities().temporary ? '选择管理员已开放的助手，查看或复制 key，再粘贴到对应电脑的助手。' : '选择一台助手，管理这台电脑的网络和串口规则。';
    $('forward-permission').textContent = capabilities().temporary ? '管理员尚未开放可查看的助手 key。下方仍可下载助手。' : '解锁并接管工作台后，可管理助手、key 和规则。下方仍可下载助手。';
    agentsUI.update(); downloadStatus();
  }
  async function load() {
    clearTimeout(timer); timer = null;
    if (!allowed() || !dialog.open || document.hidden) return;
    if (controller) { timer = setTimeout(load, 3000); return; }
    const epoch = generation, request = controller = new AbortController(), deadline = setTimeout(() => request.abort(), 8000);
    try {
      const data = await api('/api/forward', { signal: request.signal });
      if (epoch !== generation || !dialog.open || !allowed()) return;
      if (data.managedHelpersProtocol !== 2) throw Error('助手管理版本不匹配，请更新节点和网页');
      downloads = (data.downloads || []).filter(file => Object.hasOwn(FORWARD_CLIENTS, file.arch)).slice(0, 4); renderDownloads();
      agentsUI.policy(data); await agentsUI.refresh();
    } catch (error) { if (epoch === generation && !request.signal.aborted) $('forward-status').textContent = error.message; }
    finally {
      clearTimeout(deadline); if (controller === request) controller = null;
      if (epoch === generation && allowed() && dialog.open && !document.hidden) timer = setTimeout(load, 3000);
    }
  }
  function reset() { cancel(); cancelDownload(); agentsUI.reset(); if (dialog.open) dialog.close(); }
  $('forward-button').addEventListener('click', () => {
    cancel(); $('forward-status').textContent = ''; update(); if (!allowed()) return;
    $('forward-download-section').open = !(capabilities().manageDevices || capabilities().viewHelperKeys);
    dialog.showModal(); $('forward-mac-help').open = platform.os === 'darwin'; prepareDownloads(); downloadStatus(); detectPlatform(); void load();
  });
  $('forward-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { cancel(); cancelDownload(); agentsUI.reset(); });
  $('forward-refresh').addEventListener('click', () => { $('forward-status').textContent = ''; void load(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancel(); cancelDownload(); agentsUI.suspend(); }
    else if (dialog.open) { update(); void load(); }
  });
  window.addEventListener('pagehide', reset);
  return { update, reset, get busy() { return agentsUI.busy || !!downloadController; } };
}
