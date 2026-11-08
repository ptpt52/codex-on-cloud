import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PUBLIC = new URL('./public/', import.meta.url);
export const UI_LIMITS = Object.freeze({ file: 4 * 1024 * 1024, total: 16 * 1024 * 1024, generations: 4 });
export const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/access-ui.js', ['access-ui.js', 'text/javascript; charset=utf-8']],
  ['/node-directory.js', ['node-directory.js', 'text/javascript; charset=utf-8']],
  ['/node-ui.js', ['node-ui.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/browser-preferences.js', ['browser-preferences.js', 'text/javascript; charset=utf-8']],
  ['/rtc-hints.js', ['rtc-hints.js', 'text/javascript; charset=utf-8']],
  ['/service-link.js', ['service-link.js', 'text/javascript; charset=utf-8']],
  ['/file-wire.js', ['file-wire.js', 'text/javascript; charset=utf-8']],
  ['/file-client.js', ['file-client.js', 'text/javascript; charset=utf-8']],
  ['/file-upload.js', ['file-upload.js', 'text/javascript; charset=utf-8']],
  ['/file-list.js', ['file-list.js', 'text/javascript; charset=utf-8']],
  ['/rtc-transport.js', ['rtc.js', 'text/javascript; charset=utf-8']],
  ['/rtc-stats.js', ['rtc-stats.js', 'text/javascript; charset=utf-8']],
  ['/transport-policy.js', ['transport-policy.js', 'text/javascript; charset=utf-8']],
  ['/workspace-panels.js', ['workspace-panels.js', 'text/javascript; charset=utf-8']],
  ['/terminal-state.js', ['terminal-state.js', 'text/javascript; charset=utf-8']],
  ['/terminal-slots.js', ['terminal-slots.js', 'text/javascript; charset=utf-8']],
  ['/terminal-history-limits.js', ['terminal-history-limits.js', 'text/javascript; charset=utf-8']],
  ['/terminal-tabs.js', ['terminal-tabs.js', 'text/javascript; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
  ['/forward-report.js', ['forward-report.js', 'text/javascript; charset=utf-8']],
  ['/forward-ui.js', ['forward-ui.js', 'text/javascript; charset=utf-8']],
  ['/forward-platform.js', ['forward-platform.js', 'text/javascript; charset=utf-8']],
  ['/control.js', ['control.js', 'text/javascript; charset=utf-8']],
  ['/shortcuts.js', ['shortcuts.js', 'text/javascript; charset=utf-8']],
  ['/shortcut-menu.js', ['shortcut-menu.js', 'text/javascript; charset=utf-8']],
  ['/health.js', ['health.js', 'text/javascript; charset=utf-8']],
  ['/connection-trace.js', ['connection-trace.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/desktop/index.html', ['viewer.html', 'text/html; charset=utf-8']],
  ['/desktop/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/desktop/desktop-pointer.js', ['desktop-pointer.js', 'text/javascript; charset=utf-8']],
  ['/desktop/rtc.js', ['rtc.js', 'text/javascript; charset=utf-8']],
  ['/desktop/transport-policy.js', ['transport-policy.js', 'text/javascript; charset=utf-8']],
  ['/desktop/frame-hold.js', ['frame-hold.js', 'text/javascript; charset=utf-8']],
  ['/desktop/first-frame.js', ['first-frame.js', 'text/javascript; charset=utf-8']],
  ['/desktop/stream-client.js', ['stream-client.js', 'text/javascript; charset=utf-8']],
  ['/desktop/rtc-stats.js', ['rtc-stats.js', 'text/javascript; charset=utf-8']],
  ['/desktop/viewer.css', ['viewer.css', 'text/css; charset=utf-8']],
  ['/terminal/index.html', ['terminal.html', 'text/html; charset=utf-8']],
  ['/terminal/terminal.js', ['terminal.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-health.js', ['terminal-health.js', 'text/javascript; charset=utf-8']],
  ['/terminal/health.js', ['health.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-rtc.js', ['terminal-rtc.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-history.js', ['terminal-history.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-history-style.js', ['terminal-history-style.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal-history-limits.js', ['terminal-history-limits.js', 'text/javascript; charset=utf-8']],
  ['/terminal/terminal.css', ['terminal.css', 'text/css; charset=utf-8']],
  ['/terminal/xterm.js', ['../../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['/terminal/fit.js', ['../../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8']],
  ['/terminal/xterm.css', ['../../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
]);

async function boundedRead(url) {
  const file = await open(url, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > UI_LIMITS.file) throw Error('前端资源不是普通文件或超过 4 MiB');
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size !== info.size) throw Error('前端资源在读取期间发生变化');
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
async function checkScripts(raw) {
  const sources = Object.fromEntries([...raw].filter(([route]) => route.endsWith('.js')).map(([route, asset]) => [route, asset.bytes.toString()]));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('../scripts/validate-ui.mjs', import.meta.url))], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdin.on('error', () => {}); child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('前端 JavaScript 语法或模块依赖校验失败')); });
    child.stdin.end(JSON.stringify(sources));
  });
}
export async function createUIAssets({ root = PUBLIC, validate = true } = {}) {
  const versions = new Map(); let current, busy = false;
  async function reload() {
    if (busy) throw Error('前端更新正在进行，请稍后重试');
    busy = true;
    try {
      const raw = new Map(); let total = 0;
      for (const [route, [name, type]] of ASSETS) {
        const bytes = await boundedRead(new URL(name, root));
        total += bytes.length; if (total > UI_LIMITS.total) throw Error('前端资源总量超过 16 MiB');
        raw.set(route, { bytes, type });
      }
      const hash = createHash('sha256');
      for (const [route, asset] of raw) hash.update(route).update(asset.bytes);
      const revision = hash.digest('hex').slice(0, 24);
      if (current?.revision === revision) return { revision, changed: false };
      if (validate) await checkScripts(raw);
      // Reject a deployment still writing files; publish only a complete snapshot.
      for (const [route, [name]] of ASSETS) if (!(await boundedRead(new URL(name, root))).equals(raw.get(route).bytes)) throw Error('资源仍在修改，未发布；请完成文件更新后重试');
      const imports = Object.fromEntries([...raw.keys()].filter(route => route.endsWith('.js') && route !== '/sw.js').map(route => [route, route + '?ui=' + revision]));
      const importMap = JSON.stringify({ imports });
      const scriptHash = createHash('sha256').update(importMap).digest('base64');
      const prepared = new Map();
      for (const [route, asset] of raw) {
        let bytes = asset.bytes;
        if (asset.type.startsWith('text/html')) {
          let html = bytes.toString();
          if (!/<head(?:\s[^>]*)?>/i.test(html) || !/<\/head>/i.test(html)) throw Error('前端 HTML 缺少资源版本插入位置');
          html = html.replace(/\b(src|href)=("|')([^"']+)\2/g, (match, attr, quote, value) => {
            const url = new URL(value, 'http://ui.local' + route);
            if (url.origin !== 'http://ui.local' || !raw.has(url.pathname) || url.pathname === '/sw.js') return match;
            url.searchParams.set('ui', revision); return attr + '=' + quote + url.pathname + url.search + url.hash + quote;
          });
          html = html.replace(/<head(?:\s[^>]*)?>/i, '<head><meta name="ui-revision" content="' + revision + '"><script type="importmap">' + importMap + '</script>');
          bytes = Buffer.from(html);
        }
        if (route === '/sw.js') bytes = Buffer.from(bytes.toString().replace('__UI_REVISION__', revision));
        prepared.set(route, { ...asset, bytes });
      }
      const version = { revision, assets: prepared, scriptHash };
      versions.delete(revision); versions.set(revision, version); current = version;
      while (versions.size > UI_LIMITS.generations) versions.delete(versions.keys().next().value);
      return { revision, changed: true };
    } finally { busy = false; }
  }
  await reload();
  return { reload, get revision() { return current.revision; }, get(route, revision) {
    if (!ASSETS.has(route)) return null;
    const version = revision ? versions.get(revision) : current;
    if (!version) throw Object.assign(Error('页面资源版本已更新，请保存草稿后刷新页面'), { status: 410 });
    return { ...version.assets.get(route), revision: version.revision, scriptHash: version.scriptHash };
  } };
}
