const REVISION = '__UI_REVISION__';
const CACHE = 'codex-cloud-shell-' + REVISION;
const SHELL = ['/', '/app.js', '/browser-preferences.js', '/rtc-hints.js', '/service-link.js', '/rtc-transport.js', '/rtc-stats.js', '/transport-policy.js', '/control.js', '/health.js', '/connection-trace.js', '/file-wire.js', '/file-client.js', '/file-upload.js', '/file-list.js', '/access-ui.js', '/node-directory.js', '/node-ui.js', '/workspace-panels.js', '/workspace.css', '/terminal-state.js', '/terminal-slots.js', '/terminal-tabs.js', '/terminal-history-limits.js', '/forward-ui.js', '/forward-report.js', '/forward-platform.js', '/shortcut-menu.js', '/shortcuts.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'].map(path => path + '?ui=' + REVISION);
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE); await cache.addAll(SHELL);
  const keys = (await caches.keys()).filter(key => key.startsWith('codex-cloud-shell-'));
  await Promise.all(keys.slice(0, Math.max(0, keys.length - 4)).map(key => caches.delete(key)));
})()));
// Updates activate after old pages close. Never interrupt an active input with an automatic reload.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('codex-cloud-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !(url.pathname === '/' && !url.search || SHELL.includes(url.pathname + url.search))) return;
  // Cache only the public shell. Desktop frames, credentials, files and APIs never enter this cache.
  event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match(url.pathname === '/' && !url.search ? '/?ui=' + REVISION : event.request))));
});
