const CACHE = 'codex-cloud-shell-0.2.0-history-copy-button';
const SHELL = ['/', '/app.js', '/workspace-panels.js', '/workspace.css', '/terminal-state.js', '/terminal-tabs.js', '/forward-ui.js', '/forward-platform.js', '/shortcut-menu.js', '/shortcuts.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
// Updates activate after old pages close. Never interrupt an active input with an automatic reload.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('codex-cloud-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  // Cache only the public shell. Desktop frames, credentials, files and APIs never enter this cache.
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
