import RFB from './novnc/core/rfb.js';

const status = document.getElementById('status');
const viewer = new URLSearchParams(location.search).get('viewer');
let rfb, retry, stopping = false;
function announce(state) {
  parent.postMessage({ type: 'codex-desktop', state }, location.origin);
}
function connect() {
  if (stopping || !/^[a-f0-9-]{16,64}$/.test(viewer || '')) return;
  const url = new URL('/desktop/websockify', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('viewer', viewer);
  status.hidden = false;
  status.textContent = '正在连接独立桌面…';
  rfb = new RFB(document.getElementById('screen'), url.href, { shared: false });
  rfb.scaleViewport = true;
  // Preserve a usable terminal size on phones; rotating the phone scales the view.
  rfb.resizeSession = false;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener('connect', () => { status.hidden = true; announce('connected'); });
  rfb.addEventListener('disconnect', () => {
    if (stopping) return;
    status.hidden = false;
    status.textContent = '连接已断开，正在等待恢复。桌面任务继续运行。';
    announce('disconnected');
    // Reconnect only the framebuffer stream. Never replay input or start a task.
    retry = setTimeout(connect, 2500);
  });
}
window.addEventListener('pagehide', () => { stopping = true; clearTimeout(retry); rfb?.disconnect(); });
connect();
