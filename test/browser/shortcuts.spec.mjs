import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
const item = (page, key) => page.locator(`[data-shortcut="${key}"]`);
async function open(page) {
  await openInput(page); await page.locator('#shortcuts-button').click(); await expect(page.locator('#shortcuts-menu')).toBeVisible();
}

test('opening, dismissing and navigating shortcuts sends nothing; selecting one key sends exactly once and preserves the draft', async ({ page }, info) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('菜单选择后仍保留这段草稿');
    await open(page); await expect(page.locator('#shortcuts-button')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#shortcuts-menu')).toBeFocused();
    await expect(page.getByRole('menuitem')).toHaveCount(39);
    await page.keyboard.press('Enter'); expect(app.inputCalls).toEqual([]);
    await page.keyboard.press('ArrowDown'); await expect(item(page, 'Enter')).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(item(page, 'Tab')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.locator('#shortcuts-menu')).toBeHidden();
    await expect(page.locator('#shortcuts-button')).toBeFocused(); expect(app.inputCalls).toEqual([]);
    await open(page); await page.mouse.click(2, 2); await expect(page.locator('#shortcuts-menu')).toBeHidden();
    await open(page); await item(page, 'Ctrl+R').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await expect(page.locator('#shortcuts-menu')).toBeHidden(); expect(app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+R' }]);
    await expect(page.locator('#mobile-input')).toHaveValue('菜单选择后仍保留这段草稿');
    await open(page); await item(page, 'Ctrl+J').click();
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+R' }, { action: 'key', key: 'Ctrl+J' }]);
    await expect(page.locator('#shortcuts-button')).toBeEnabled();
    await open(page); await item(page, 'Ctrl+R').evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => app.inputCalls.length).toBe(3);
    expect(app.inputCalls.at(-1)).toEqual({ action: 'key', key: 'Ctrl+R' });
    expect(app.managementStats.restarts).toBe(0);
    await expect(page.locator('#shortcuts-button')).toBeEnabled(); await open(page);
    await page.screenshot({ path: `test-results/${info.project.name}-shortcuts.png` });
  } finally { await app.close(); }
});

test('session-changing shortcuts require confirmation, default Enter cancels and confirmed selection is fixed', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app);
    for (const key of ['Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Escape Escape']) {
      await open(page); await item(page, key).click();
      await expect(page.locator('#action-confirmation')).toBeVisible(); await expect(page.locator('#cancel-confirmation')).toBeFocused();
      expect(app.inputCalls).toEqual([]);
      await page.keyboard.press('Enter'); await expect(page.locator('#action-confirmation')).toBeHidden();
    }
    await open(page); await item(page, 'Ctrl+D').click();
    await item(page, 'Ctrl+D').evaluate(button => { button.dataset.shortcut = 'Ctrl+Z'; });
    await page.locator('#accept-confirmation').evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+D' }]);
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
  } finally { await app.close(); }
});

test('busy, disconnect and takeover invalidate menus and pending shortcut confirmations without replay', async ({ page, context }) => {
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, inputHook: async () => { entered(); await hold; } });
  try {
    await login(page, app); await open(page); await item(page, 'Ctrl+R').click(); await started;
    await expect(page.locator('#shortcuts-button')).toBeDisabled();
    release(); await expect(page.locator('#shortcuts-button')).toBeEnabled();
    await open(page); app.disconnectViewers(); await expect(page.locator('#shortcuts-menu')).toBeHidden();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+R' }]);
    await open(page); await item(page, 'Ctrl+D').click();
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('桌面在线');
      await expect(page.locator('#action-confirmation')).toBeHidden({ timeout: 10000 });
      await page.locator('#accept-confirmation').evaluate(button => button.click());
      expect(app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+R' }]);
    } finally { await second.close(); }
  } finally { release(); await app.close(); }
});

test('shortcut choices use encrypted direct control and never resend an accepted key after a lost result', async ({ page }) => {
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, inputHook: async () => { entered(); await hold; } });
  let http = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/key')) http++; });
  try {
    await login(page, app); await page.locator('#connection-button').click();
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密直连'); await page.locator('#close-connection').click();
    await open(page); await item(page, 'Ctrl+ArrowLeft').click(); await started;
    app.disconnectViewers(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    release(); await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+ArrowLeft' }]); expect(http).toBe(0);
  } finally { release(); await app.close(); }
});

test('narrow dropdown remains in the visual viewport, has touch-sized rows and supports the no-popover fallback', async ({ page }, info) => {
  await page.addInitScript(() => { HTMLElement.prototype.showPopover = undefined; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 });
    await login(page, app); await open(page);
    await expect.poll(async () => {
      const box = await page.locator('#shortcuts-menu').boundingBox(), view = page.viewportSize();
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1;
    }).toBe(true);
    for (const key of ['Enter', 'Ctrl+R', 'Ctrl+D']) expect((await item(page, key).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await item(page, 'Ctrl+R').click(); await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+R' }]);
    await expect(page.locator('#shortcuts-button')).toBeEnabled(); await open(page); await page.keyboard.press('Escape');
    await expect(page.locator('#shortcuts-menu')).toBeHidden();
  } finally { await app.close(); }
});

test('an open shortcut menu postpones background transport replacement until it closes', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }); let offers = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'codex-desktop-options') window.shortcutFrameBusy = event.data.busy === true;
    });
  });
  await page.route('**/api/desktop/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
  try {
    await login(page, app); await open(page);
    const frame = page.frames().find(frame => frame.url().includes('/desktop/index.html'));
    await expect.poll(() => frame.evaluate(() => window.shortcutFrameBusy)).toBe(true);
    await page.clock.fastForward(16000);
    expect(offers).toBe(1); expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
    await expect(page.locator('#shortcuts-menu')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#shortcuts-menu')).toBeHidden();
    await expect.poll(() => frame.evaluate(() => window.shortcutFrameBusy)).toBe(false);
    // Real HTTP/ICE/DTLS replies must run between the probe's timers. Jumping
    // over them can expire an in-flight handshake before its reply is handled.
    await page.clock.runFor(6000);
    await expect.poll(() => app.vncConnections, { timeout: 15000 }).toBe(2);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(offers).toBe(2); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('the public offline shell includes shortcut modules and never caches authenticated desktop or API data', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await context.setOffline(true); await page.reload();
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('[data-shortcut]')).toHaveCount(39); await expect(page.locator('#shortcuts-button')).toBeDisabled();
    const { paths, names, revisions } = await page.evaluate(async () => {
      const names = (await caches.keys()).filter(name => name.startsWith('codex-cloud-shell-'));
      const cache = await caches.open(names[0]);
      const urls = (await cache.keys()).map(request => new URL(request.url));
      return { names, paths: urls.map(url => url.pathname), revisions: urls.map(url => url.searchParams.get('ui')) };
    });
    expect(names).toHaveLength(1);
    expect(paths).toContain('/shortcuts.js'); expect(paths).toContain('/shortcut-menu.js');
    expect(paths).toContain('/workspace-panels.js'); expect(paths).toContain('/workspace.css');
    expect(paths).toContain('/terminal-state.js'); expect(paths).toContain('/terminal-tabs.js');
    expect(paths).toContain('/terminal-history-limits.js');
    expect(paths).toContain('/access-ui.js'); expect(paths).toContain('/forward-report.js');
    expect(paths).not.toContain('/node-directory.js'); expect(paths).not.toContain('/node-ui.js');
    for (const path of ['/service-link.js', '/rtc-transport.js', '/rtc-stats.js', '/transport-policy.js', '/control.js', '/health.js', '/file-wire.js', '/file-client.js']) expect(paths).toContain(path);
    expect(paths.every(path => path === '/' || /^\/[a-z0-9-]+\.(js|css|svg|webmanifest)$/.test(path))).toBe(true);
    expect(new Set(revisions)).toEqual(new Set([app.panel.uiRevision]));
    expect(paths.some(path => path.startsWith('/api/') || path.startsWith('/desktop/'))).toBe(false);
    expect(app.inputCalls).toEqual([]);
  } finally { await context.setOffline(false); await app.close(); }
});
