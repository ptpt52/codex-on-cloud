import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.locator('#password').fill(app.config.password);
  await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
}

test('focus layout preserves a tall desktop and one-step panel access across viewport sizes', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1600, height: 3200 } });
  let connections = 0;
  page.on('websocket', () => connections++);
  try {
    await login(page, app);
    await expect(page.locator('#workspace-tools')).toBeHidden();
    await expect(page.locator('#input-dock')).toBeHidden();
    for (const size of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      const stage = await page.locator('#desktop-stage').boundingBox();
      const card = await page.locator('#desktop-card').boundingBox();
      // A short landscape viewport still reserves two accessible 44px rows.
      expect(stage.height).toBeGreaterThanOrEqual(size.height * (size.height < 540 ? 0.7 : 0.75));
      expect(stage.y + stage.height).toBeLessThanOrEqual(card.y + card.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await page.locator('#toggle-controls-button').click();
      await expect(page.locator('#workspace-tools')).toBeVisible();
      await expect(page.locator('#workspace-tools')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#workspace-tools')).toBeHidden();
      await expect(page.locator('#toggle-controls-button')).toBeFocused();
      await page.locator('#toggle-input-button').click();
      await expect(page.locator('#input-dock')).toBeVisible();
      await page.locator('#mobile-input').fill('查看和关闭面板不发送这段草稿');
      await page.locator('#close-input-button').click();
    }
    await page.locator('#toggle-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('查看和关闭面板不发送这段草稿');
    await page.locator('#toggle-controls-button').click();
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#workspace-tools')).toBeVisible();
    expect(connections).toBe(1);
    expect(app.inputCalls).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
    expect(app.managementStats.viewportResizes).toBe(0);
  } finally { await app.close(); }
});

test('IME Escape keeps the input assistant and draft; ordinary Escape returns focus to its entry', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-input-button').click();
    const input = page.locator('#mobile-input');
    await input.fill('尚未发送的中文');
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
      await expect(page.locator('#input-dock')).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('尚未发送的中文');
    }
    await input.dispatchEvent('compositionstart');
    await page.keyboard.press('Escape');
    await expect(page.locator('#input-dock')).toBeVisible();
    await expect(input).toBeFocused();
    await input.dispatchEvent('compositionend');
    await page.keyboard.press('Escape');
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#toggle-input-button')).toBeFocused();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('tool dialogs retain confirmation and return focus without losing the input draft', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.locator('#toggle-input-button').click();
    await page.locator('#mobile-input').fill('工具操作后继续编辑');
    await page.locator('#toggle-controls-button').click();
    await page.locator('#reconnect-button').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#reconnect-button')).toBeFocused();
    await expect(page.locator('#workspace-tools')).toBeVisible();
    await page.locator('#close-controls-button').click();
    await page.locator('#toggle-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('工具操作后继续编辑');
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('partial saved terminal preferences preserve display choices without opening an unspecified tool panel', async ({ page }) => {
  const app = await fixture({ rfb: true });
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({
    layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalFontSize: 18, terminalInputCollapsed: true,
  })));
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#workspace-tools')).toBeHidden();
    await expect(page.locator('#input-dock')).toBeHidden();
    await expect(page.locator('#terminal-font-label')).toHaveText('18');
    await expect(page.frameLocator('#desktop-frame').locator('#terminal')).toBeVisible();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
