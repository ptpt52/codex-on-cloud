import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';

async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', controlsCollapsed: true, terminalInputCollapsed: true }));
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
test('narrow toolbar preserves a usable terminal picker and quick close in one row with complete accessible names', async ({ page }, info) => {
  const app = await fixture({ rfb: true, maxTerminals: 8 });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '很长的网络诊断与设备分析终端', view: 'terminal' });
    await login(page, app);
    for (const width of [320, 360, 390, 420]) {
      await page.setViewportSize({ width, height: 844 });
      const picker = page.locator('#terminal-session-button'), close = page.locator('#terminal-session-close');
      await expect(picker).toHaveText('主终端 ▾'); await expect(picker).toHaveAccessibleName('Codex 主终端 ▾');
      const [pickBox, closeBox, toolbar] = await Promise.all([picker.boundingBox(), close.boundingBox(), page.locator('.desktop-toolbar').boundingBox()]);
      expect(pickBox.width).toBeGreaterThanOrEqual(72); expect(pickBox.height).toBeGreaterThanOrEqual(44);
      expect(closeBox.width).toBeGreaterThanOrEqual(44); expect(toolbar.height).toBeLessThanOrEqual(56);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(pickBox.x + pickBox.width).toBeLessThanOrEqual(closeBox.x + 1);
      for (const selector of ['#desktop-mode', '#toggle-controls-button', '#toggle-input-button']) {
        const box = await page.locator(selector).boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      if (info.project.use.hasTouch) await picker.tap(); else await picker.click();
      await expect(page.locator('#terminal-switch-dialog')).toBeVisible();
      await page.locator('#close-terminal-switch').click(); await expect(picker).toBeFocused();
    }
    await page.setViewportSize({ width: 320, height: 720 });
    await page.screenshot({ path: `test-results/${info.project.name}-compact-toolbar.png` });
    if (info.project.use.hasTouch) await page.locator('#terminal-session-button').tap(); else await page.locator('#terminal-session-button').click();
    await expect(page.locator('#terminal-switch-dialog')).toBeVisible();
    await page.locator('#terminal-switch-list [data-terminal-choice=aux1]').click();
    await expect(page.locator('#terminal-session-button')).toHaveAccessibleName('很长的网络诊断与设备分析终端 ▾');
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('#terminal-session-button')).toHaveText('很长的网络诊断与设备分析终端 ▾');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
test('compact mode action keeps cancellation, switching confirmation and the terminal draft without sending input', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.setViewportSize({ width: 320, height: 720 }); await login(page, app);
    const original = await app.controls.listTerminals();
    await openInput(page); await page.locator('#mobile-input').fill('只保留草稿，不提交'); await closePanels(page);
    await page.locator('#desktop-mode').click(); await expect(page.locator('#cancel-confirmation')).toBeFocused();
    await page.locator('#cancel-confirmation').click(); await expect(page.locator('#terminal-mode')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#desktop-mode').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#terminal-mode')).toBeVisible(); await expect(page.locator('#desktop-mode')).toBeHidden();
    await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('只保留草稿，不提交');
    expect(await app.controls.listTerminals()).toEqual(original); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('offline viewing shows an explicit notice without taking a terminal row and clears it after recovery', async ({ page, context }, info) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await page.setViewportSize({ width: 320, height: 720 }); await login(page, app);
    await expect(page.locator('#connection-notice')).toBeHidden();
    await openInput(page); await page.locator('#mobile-input').fill('网络恢复后再手动发送'); await closePanels(page);
    const before = await page.locator('#desktop-frame').boundingBox(), toolbar = await page.locator('.desktop-toolbar').boundingBox();
    await context.setOffline(true);
    await expect(page.locator('#connection-notice')).toContainText('网络已断开，输入已暂停');
    await expect(page.locator('#connection-status')).toContainText('等待网络');
    expect((await page.locator('#desktop-frame').boundingBox()).height).toBe(before.height);
    expect((await page.locator('.desktop-toolbar').boundingBox()).height).toBe(toolbar.height);
    expect(await page.locator('#connection-notice').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
    await page.screenshot({ path: `test-results/${info.project.name}-offline-notice.png` });
    await context.setOffline(false); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#connection-notice')).toBeHidden();
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('网络恢复后再手动发送');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await context.setOffline(false); await app.close(); }
});
