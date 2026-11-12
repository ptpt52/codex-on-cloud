import { openInput, openTools, closePanels } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
}
async function fillsViewport(page) {
  const stage = await page.locator('#desktop-stage').boundingBox();
  const canvas = await page.frameLocator('#desktop-frame').locator('#screen canvas').boundingBox();
  return !!canvas && canvas.width <= stage.width + 2 && canvas.height <= stage.height + 2 && canvas.width * canvas.height > stage.width * stage.height * 0.96;
}
async function fitsWidth(page) {
  return page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => Math.abs(canvas.getBoundingClientRect().width - document.getElementById('viewport').clientWidth) <= 1);
}
const geometry = page => page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => [canvas.width, canvas.height]);
async function enableWindowFollowing(page) {
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
    layout: 2, zoom: 'fit', pan: false, collapsed: false, controlsCollapsed: false, autoResolution: true,
  })));
}

test('window-follow mode adapts framebuffer geometry to browser and folding without reconnect or input', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true }); let connections = 0;
  page.on('websocket', () => connections++);
  try {
    await enableWindowFollowing(page);
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, app);
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    const first = await page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => [canvas.width, canvas.height]);
    expect(first[0]).toBeGreaterThan(first[1]);
    await page.setViewportSize({ width: 1366, height: 650 });
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await openInput(page); await page.locator('#mobile-input').fill('尺寸变化后保留草稿');
    await page.locator('#toggle-input-button').click();
    await expect.poll(() => fillsViewport(page)).toBe(true);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    const sidebarWidth = (await page.locator('#workspace-sidebar').boundingBox())?.width || 0;
    expect((await page.locator('#desktop-stage').boundingBox()).width).toBeGreaterThan(2400 - sidebarWidth);
    const size = await page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => [canvas.width, canvas.height]);
    expect(Math.max(...size)).toBeLessThanOrEqual(1600);
    await expect(page.locator('#mobile-input')).toHaveValue('尺寸变化后保留草稿');
    expect(connections).toBe(1); expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.resumes).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('fixed desktop option persists and stops changing remote dimensions on window resize', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true });
  try {
    // Opt in through the control, so a phone's explicit choice survives reload.
    await page.setViewportSize({ width: 1366, height: 900 }); await login(page, app);
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await page.locator('#auto-resolution').check(); await page.locator('#close-desktop-settings').click();
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked();
    await page.locator('#auto-resolution').uncheck(); await page.locator('#close-desktop-settings').click();
    // Phones return from window-follow mode to their fixed tall desktop.
    await expect.poll(() => geometry(page)).toEqual([1600, 3200]);
    const count = app.managementStats.viewportResizes;
    await page.setViewportSize({ width: 1100, height: 760 }); await page.waitForTimeout(1200);
    expect(app.managementStats.viewportResizes).toBe(count);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await openTools(page); await page.locator('#desktop-settings-button').click(); await expect(page.locator('#auto-resolution')).not.toBeChecked();
    expect(app.managementStats.viewportResizes).toBe(count);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('fixed tall desktops fit width across window changes, folding and reconnect', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1280, height: 720 } });
  let connections = 0;
  page.on('websocket', () => connections++);
  async function settled() {
    await expect.poll(() => geometry(page), { timeout: 12000 }).toEqual([1600, 3200]);
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }
  try {
    await login(page, app); await settled();
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).not.toBeChecked();
    if (mobile) {
      await expect(page.locator('#viewport-note')).toContainText('1600 × 3200');
      await expect(page.locator('#apply-desktop-settings')).toBeDisabled();
    }
    await page.locator('#close-desktop-settings').click();
    const initialChanges = app.managementStats.viewportResizes;
    await openInput(page); await page.locator('#mobile-input').fill('尺寸切换保留草稿');
    const sizes = mobile ? [{ width: 844, height: 390 }, { width: 390, height: 450 }, { width: 390, height: 844 }]
      : [{ width: 640, height: 900 }, { width: 1366, height: 650 }];
    for (const size of sizes) {
      await page.setViewportSize(size); await page.waitForTimeout(1200); await settled();
    }
    await page.locator('#toggle-input-button').click(); await page.locator('#toggle-controls-button').click();
    await page.waitForTimeout(1200); await settled();
    expect(app.managementStats.viewportResizes).toBe(initialChanges);
    expect(connections).toBe(1);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await settled();
    app.disconnectViewers();
    await expect.poll(() => connections, { timeout: 12000 }).toBe(3);
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await settled();
    expect(app.managementStats.viewportResizes).toBe(initialChanges);
    await expect(page.locator('#mobile-input')).toHaveValue('尺寸切换保留草稿');
    expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.resumes).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('legacy preferences migrate to fixed width-fit on all devices while preserving other display preferences', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1280, height: 720 } });
  try {
    await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
      zoom: 'fit', pan: true, collapsed: true, controlsCollapsed: false, autoResolution: true,
    })));
    await login(page, app);
    await expect.poll(() => geometry(page), { timeout: 12000 }).toEqual([1600, 3200]);
    await expect.poll(() => fitsWidth(page)).toBe(true);
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#pan-button')).toHaveAttribute('aria-pressed', 'true');
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).not.toBeChecked();
    await page.locator('#close-desktop-settings').click();
    await page.locator('#toggle-input-button').click();
    const stored = await page.evaluate(() => localStorage.getItem('codex-cloud.display.v1'));
    expect(stored.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(stored).layout).toBe(2);
    expect(JSON.parse(stored).autoResolution).toBe(false);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).not.toBeChecked();
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('width-fit scrolls locally without remote drags and preserves tap coordinates and scroll position', async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 640 });
  const app = await fixture({ rfb: true, viewport: true });
  const pointers = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (Buffer.isBuffer(payload) && payload.length === 6 && payload[0] === 5) pointers.push({ buttons: payload[1], x: payload.readUInt16BE(2), y: payload.readUInt16BE(4) });
  }));
  try {
    await login(page, app);
    await expect.poll(() => geometry(page)).toEqual([1600, 3200]);
    await expect.poll(() => fitsWidth(page)).toBe(true);
    await page.waitForTimeout(1000);
    const viewport = page.frameLocator('#desktop-frame').locator('#viewport');
    const stage = await page.locator('#desktop-stage').boundingBox();
    const x = Math.round(stage.x + stage.width / 2), y = Math.round(stage.y + stage.height * 0.7);
    await closePanels(page); await page.mouse.move(x, y); await page.waitForTimeout(100);
    const before = pointers.length;
    if (info.project.name === 'mobile') {
      const client = await context.newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 24 }] });
        await page.waitForTimeout(16);
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach();
    } else await page.mouse.wheel(0, 240);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(60);
    expect(pointers.length).toBe(before);
    const top = await viewport.evaluate(element => element.scrollTop);
    await page.waitForTimeout(4500);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(top);
    const canvas = await page.frameLocator('#desktop-frame').locator('#screen canvas').boundingBox();
    if (info.project.name === 'mobile') await page.touchscreen.tap(x, y); else await closePanels(page); await page.mouse.click(x, y);
    await expect.poll(() => pointers.filter(value => value.buttons === 1).length).toBeGreaterThan(0);
    const pressed = pointers.findLast(value => value.buttons === 1), scale = canvas.width / 1600;
    expect(Math.abs(pressed.x - (x - canvas.x) / scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(pressed.y - (y - canvas.y) / scale)).toBeLessThanOrEqual(2);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('an old display limit keeps the current desktop and explains the required restart', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true, viewportMaximum: { width: 1600, height: 1600 } });
  try {
    await login(page, app);
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#viewport-note')).toContainText('显示上限不足');
    await page.waitForTimeout(2000);
    expect(await geometry(page)).toEqual([1600, 1600]);
    expect(app.managementStats.viewportResizes).toBe(0);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
