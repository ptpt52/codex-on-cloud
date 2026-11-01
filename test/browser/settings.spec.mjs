import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function open(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await page.locator('#desktop-settings-button').click();
  await expect(page.locator('#settings-current')).toContainText('1600 × 1600');
}

test('save persists pending settings; only explicit confirmed apply restarts and restores once', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await open(page, app);
    await page.locator('#resolution-preset').selectOption('1920x1600');
    await page.locator('#terminal-font-size').fill('18');
    await expect(page.locator('#apply-desktop-settings')).toBeDisabled();
    await page.locator('#save-desktop-settings').click();
    await expect(page.locator('#settings-pending')).toContainText('待应用：1920 × 1600');
    await expect(page.locator('#settings-current')).toContainText('1600 × 1600');
    expect(app.managementStats.restarts).toBe(0);
    await page.reload();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#desktop-width')).toHaveValue('1920');
    await expect(page.locator('#terminal-font-size')).toHaveValue('18');
    await expect(page.locator('#settings-recovery')).toContainText('11111111-1111-4111-8111-111111111111');
    await expect(page.locator('#apply-desktop-settings')).toBeDisabled();
    await page.locator('#confirm-desktop-restart').check();
    await page.locator('#apply-desktop-settings').click();
    await expect(page.locator('#desktop-settings-status')).toContainText('已按准确 ID 启动会话恢复', { timeout: 10000 });
    await expect(page.locator('#settings-current')).toContainText('1920 × 1600');
    expect(app.managementStats.restarts).toBe(1); expect(app.managementStats.resumes).toBe(1);
    await page.reload();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toHaveJSProperty('width', 1920);
    expect(app.managementStats.restarts).toBe(1); expect(app.managementStats.resumes).toBe(1);
    expect(app.received.filter(call => ['/paste', '/key', '/terminal'].includes(call.url))).toHaveLength(0);
  } finally { await app.close(); }
});

test('terminal font and window actions preserve tasks and never submit terminal input', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await open(page, app);
    await page.locator('#terminal-font-size').fill('20');
    await expect(page.locator('#apply-terminal-font')).toBeDisabled();
    await page.locator('#save-desktop-settings').click();
    await expect(page.locator('#apply-terminal-font')).toBeEnabled();
    await page.locator('#apply-terminal-font').click();
    await expect(page.locator('#desktop-settings-status')).toContainText('终端显示已更新');
    await expect(page.locator('#maximize-terminal')).toBeEnabled();
    await page.locator('#maximize-terminal').click();
    await expect.poll(() => app.managementStats.maximizes).toBe(1);
    await expect(page.locator('#restore-terminal')).toBeEnabled();
    await page.locator('#restore-terminal').click();
    await expect.poll(() => app.managementStats.restores).toBe(1);
    await expect(page.locator('#restore-terminal')).toBeEnabled();
    expect(app.managementStats.fontChanges).toBe(1); expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.resumes).toBe(0);
    expect(app.received.filter(call => ['/paste', '/key', '/terminal'].includes(call.url))).toHaveLength(0);
    await page.locator('#desktop-width').fill('9999');
    await page.locator('#save-desktop-settings').click();
    expect(app.managementStats.saves).toBe(1);
    expect(await page.locator('#desktop-width').evaluate(input => input.validity.rangeOverflow)).toBe(true);
    await page.locator('#close-desktop-settings').click();
    await expect(page.locator('#desktop-settings-dialog')).not.toBeVisible();
  } finally { await app.close(); }
});
