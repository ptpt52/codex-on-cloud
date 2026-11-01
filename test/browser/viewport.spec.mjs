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

test('wide laptop adapts real framebuffer geometry to browser and folding without reconnect or input', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true }); let connections = 0;
  page.on('websocket', () => connections++);
  try {
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
    await page.setViewportSize({ width: 1366, height: 900 }); await login(page, app);
    await expect.poll(() => fillsViewport(page), { timeout: 12000 }).toBe(true);
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#auto-resolution')).toBeChecked();
    await page.locator('#auto-resolution').uncheck(); await page.locator('#close-desktop-settings').click();
    const count = app.managementStats.viewportResizes;
    await page.setViewportSize({ width: 1100, height: 760 }); await page.waitForTimeout(1200);
    expect(app.managementStats.viewportResizes).toBe(count);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#desktop-settings-button').click(); await expect(page.locator('#auto-resolution')).not.toBeChecked();
    expect(app.managementStats.viewportResizes).toBe(count);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
