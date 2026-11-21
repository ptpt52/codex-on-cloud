import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function open(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await page.locator('#connection-button').click();
}

test('connection overview keeps current routes and actions visible with details collapsed and no horizontal scrolling', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await open(page, app);
    await expect(page.locator('#connection-overview')).toHaveAttribute('data-state', 'healthy');
    await expect(page.locator('#connection-summary')).toHaveText('桌面在线');
    await expect(page.locator('#diag-transport')).toContainText('中转');
    await expect(page.locator('#diag-file-transport')).toContainText('HTTPS');
    await expect(page.locator('#connection-refresh-state')).toContainText('更新于');
    for (const id of ['connection-network', 'connection-services']) await expect(page.locator('#' + id)).toHaveJSProperty('open', false);
    for (const id of ['refresh-connection', 'close-connection']) {
      await expect(page.locator('#' + id)).toBeInViewport();
      expect((await page.locator('#' + id).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.locator('#connection-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.locator('#connection-services > summary').click();
    await expect(page.locator('#diag-tunnel')).toHaveText('已连接 · 3 条连接');
    await expect(page.locator('#diag-services')).toBeVisible();
    await page.locator('#connection-dialog').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('#close-connection')).toBeInViewport();
    await page.locator('#close-connection').click(); await expect(page.locator('#connection-dialog')).toBeHidden();
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('top-layout fullscreen or its fallback keeps connection details reachable', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    // Firefox may expand the layout viewport to the screen size on entry.
    await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top' })));
    await open(page, app);
    await page.locator('#close-connection').click();
    await page.locator('#toggle-controls-button').click();
    const status = page.locator('#tools-connection-button');
    await expect(status).toBeHidden();
    const supported = await page.evaluate(() => Boolean(document.fullscreenEnabled && document.getElementById('desktop-card').requestFullscreen));
    await page.locator('#tools-fullscreen-button').click();
    if (supported) {
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
      await page.locator('#toggle-controls-button').click();
      await status.click();
    } else {
      await expect(page.locator('#toast')).toContainText('不支持网页全屏');
      await page.locator('#connection-button').click();
    }
    await expect(page.locator('#connection-summary')).toHaveText('桌面在线');
    await expect(page.locator('#close-connection')).toBeVisible();
    // Native fullscreen can change Firefox's pointer coordinate mapping.
    await page.locator('#close-connection').press('Enter');
    await expect(page.locator('#connection-dialog')).toBeHidden();
    if (supported) await expect(status).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe(supported ? 'desktop-card' : null);
    expect(app.vncConnections).toBe(1);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('connection diagnostics keep close and refresh reachable when the visual viewport is cropped', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
  });
  const app = await fixture({ rfb: true });
  try {
    await open(page, app);
    await expect(page.locator('#refresh-connection')).toBeEnabled();
    await page.evaluate(() => {
      Object.assign(visualViewport, { width: 254, height: 520, offsetLeft: 12, offsetTop: 40 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    const dialog = page.locator('#connection-dialog');
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 12 && box.x + box.width <= 266 && box.y >= 40 && box.y + box.height <= 560;
    }).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.locator('#refresh-connection').click({ trial: true });
    await page.locator('#close-connection').click();
    await expect(dialog).toBeHidden();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('diagnostic failure stays separate from the live session and repeated refreshes cannot overlap', async ({ page }) => {
  const app = await fixture({ rfb: true }); let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/diagnostics', async route => { requests++; await gate; await route.fulfill({ status: 503, json: { error: '节点诊断暂不可用' } }).catch(() => {}); });
    await open(page, app); await expect.poll(() => requests).toBe(1);
    await expect(page.locator('#refresh-connection')).toBeDisabled();
    for (let n = 0; n < 3; n++) await page.locator('#refresh-connection').dispatchEvent('click');
    expect(requests).toBe(1); release();
    await expect(page.locator('#connection-refresh-state')).toContainText('节点状态未更新');
    await expect(page.locator('#refresh-connection')).toBeEnabled();
    await expect(page.locator('#connection-overview')).toHaveAttribute('data-state', 'healthy');
    await expect(page.locator('#connection-summary')).toHaveText('桌面在线');
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release?.(); await app.close(); }
});
