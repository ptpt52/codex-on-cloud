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
const geometry = page => page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => [canvas.width, canvas.height]);
async function enableWindowFollowing(page) {
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
    zoom: 'fit', pan: false, collapsed: false, controlsCollapsed: false, autoResolution: true, mobileAutoResolution: true,
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
    await page.locator('#mobile-input').fill('尺寸变化后保留草稿');
    await page.locator('#toggle-input-button').click();
    await expect.poll(() => fillsViewport(page)).toBe(true);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    expect((await page.locator('#desktop-stage').boundingBox()).width).toBeGreaterThan(2400);
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
    await page.locator('#desktop-settings-button').click();
    await page.locator('#auto-resolution').check(); await page.locator('#close-desktop-settings').click();
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked();
    await page.locator('#auto-resolution').uncheck(); await page.locator('#close-desktop-settings').click();
    // Phones return from window-follow mode to their fixed square desktop.
    if (test.info().project.name === 'mobile') await expect.poll(() => geometry(page)).toEqual([1600, 1600]);
    const count = app.managementStats.viewportResizes;
    await page.setViewportSize({ width: 1100, height: 760 }); await page.waitForTimeout(1200);
    expect(app.managementStats.viewportResizes).toBe(count);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#desktop-settings-button').click(); await expect(page.locator('#auto-resolution')).not.toBeChecked();
    expect(app.managementStats.viewportResizes).toBe(count);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('device defaults keep phones square across rotation, keyboard, folding and reconnect', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1280, height: 720 } });
  let connections = 0;
  page.on('websocket', () => connections++);
  async function settled() {
    if (mobile) await expect.poll(() => geometry(page), { timeout: 12000 }).toEqual([1600, 1600]);
    else await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
  }
  try {
    await login(page, app); await settled();
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked({ checked: !mobile });
    if (mobile) {
      await expect(page.locator('#viewport-note')).toContainText('1600 × 1600');
      await expect(page.locator('#apply-desktop-settings')).toBeDisabled();
    }
    await page.locator('#close-desktop-settings').click();
    const initialChanges = app.managementStats.viewportResizes;
    await page.locator('#mobile-input').fill('尺寸切换保留草稿');
    const sizes = mobile ? [{ width: 844, height: 390 }, { width: 390, height: 450 }, { width: 390, height: 844 }]
      : [{ width: 640, height: 900 }, { width: 1366, height: 650 }];
    for (const size of sizes) {
      await page.setViewportSize(size); await page.waitForTimeout(1200); await settled();
    }
    await page.locator('#toggle-input-button').click(); await page.locator('#toggle-controls-button').click();
    await page.waitForTimeout(1200); await settled();
    if (mobile) expect(app.managementStats.viewportResizes).toBe(initialChanges);
    expect(connections).toBe(1);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await settled();
    app.disconnectViewers();
    await expect.poll(() => connections, { timeout: 12000 }).toBe(3);
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await settled();
    if (mobile) expect(app.managementStats.viewportResizes).toBe(initialChanges);
    await expect(page.locator('#mobile-input')).toHaveValue('尺寸切换保留草稿');
    expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.resumes).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('legacy automatic preference migrates only on mobile while preserving other display preferences', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1280, height: 720 } });
  try {
    await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
      zoom: 'fit', pan: true, collapsed: true, controlsCollapsed: false, autoResolution: true,
    })));
    await login(page, app);
    if (mobile) await expect.poll(() => geometry(page), { timeout: 12000 }).toEqual([1600, 1600]);
    else await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#pan-button')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked({ checked: !mobile });
    await page.locator('#close-desktop-settings').click();
    await page.locator('#toggle-input-button').click();
    const stored = await page.evaluate(() => localStorage.getItem('codex-cloud.display.v1'));
    expect(stored.length).toBeLessThanOrEqual(256);
    expect(JSON.parse(stored).mobileAutoResolution).toBe(false);
    expect(JSON.parse(stored).autoResolution).toBe(true);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked({ checked: !mobile });
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
