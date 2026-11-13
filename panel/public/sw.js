const REVISION = '__UI_REVISION__';
const BASE = '__ENTRY_BASE_PATH__';
const CACHE_PREFIX = 'codex-cloud-shell:';
const SCOPE_PREFIX = CACHE_PREFIX + encodeURIComponent(BASE) + ':';
const LEGACY_PREFIX = 'codex-cloud-shell-';
const CACHE = SCOPE_PREFIX + REVISION;
const ownsCache = key => key.startsWith(SCOPE_PREFIX) || key.startsWith(LEGACY_PREFIX) && key.endsWith('-' + BASE);
const SHELL = [BASE + '?ui=' + REVISION, ...['app.js', 'entry-path.js', 'node-scope.js', 'browser-preferences.js', 'desktop-input.js', 'rtc-address.js', 'rtc-recheck.js', 'rtc-hints.js', 'rtc-ice.js', 'service-link.js', 'rtc-transport.js', 'rtc-stats.js', 'transport-policy.js', 'control.js', 'health.js', 'connection-trace.js', 'input-notices.js', 'file-wire.js', 'transfer-window.js', 'file-client.js', 'file-upload.js', 'file-list.js', 'file-transfer.js', 'access-ui.js', 'workspace-panels.js', 'workspace.css', 'terminal-state.js', 'terminal-slots.js', 'terminal-tabs.js', 'terminal-history-limits.js', 'forward-ui.js', 'forward-agents-ui.js', 'forward-prompt.js', 'forward-rule-form.js', 'forward-platform.js', 'shortcut-menu.js', 'shortcuts.js', 'styles.css', 'icon.svg', 'manifest.webmanifest'].map(path => BASE + path + '?ui=' + REVISION)];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE); await cache.addAll(SHELL);
  const keys = (await caches.keys()).filter(ownsCache);
  await Promise.all(keys.slice(0, Math.max(0, keys.length - 4)).map(key => caches.delete(key)));
})()));
// Updates activate after old pages close. Never interrupt an active input with an automatic reload.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => ownsCache(key) && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !(url.pathname === BASE && !url.search || SHELL.includes(url.pathname + url.search))) return;
  // Cache only the public shell. Desktop frames, credentials, files and APIs never enter this cache.
  event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match(url.pathname === BASE && !url.search ? BASE + '?ui=' + REVISION : event.request))));
});
