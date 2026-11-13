import { openInput, openTools } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}

test('logout requires an explicit confirmation; double tap, default Enter and Escape keep the workspace', async ({ page }) => {
  const app = await fixture({ rfb: true }); let logouts = 0;
  page.on('request', request => { if (request.url().endsWith('/api/logout')) logouts++; });
  try {
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('误触后保留草稿');
    await page.locator('#logout-button').dblclick();
    await expect(page.locator('#action-confirmation')).toBeVisible();
    await expect(page.locator('#confirmation-description')).toContainText('任务会继续保留');
    await expect(page.locator('#cancel-confirmation')).toBeFocused();
    expect(logouts).toBe(0);
    await page.keyboard.press('Enter'); await expect(page.locator('#action-confirmation')).toBeHidden();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#logout-button').click(); await page.keyboard.press('Escape');
    await expect(page.locator('#action-confirmation')).toBeHidden(); expect(logouts).toBe(0);
    await expect(page.locator('#mobile-input')).toHaveValue('误触后保留草稿');
    await page.locator('#logout-button').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#login-view')).toBeVisible();
    await page.locator('#accept-confirmation').evaluate(button => { button.click(); button.click(); });
    expect(logouts).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('opening terminal and reconnecting require their own confirmation and execute only once', async ({ page }) => {
  const app = await fixture({ rfb: true }); let claims = 0, streams = 0;
  page.on('request', request => { if (request.url().endsWith('/api/desktop/claim')) claims++; });
  page.on('websocket', () => streams++);
  try {
    await login(page, app);
    for (const id of ['terminal-button', 'reconnect-button']) {
      await openTools(page);
      await page.locator('#' + id).click(); await expect(page.locator('#cancel-confirmation')).toBeFocused();
      await page.locator('#cancel-confirmation').click();
    }
    expect(app.inputCalls).toEqual([]); expect(claims).toBe(1); expect(streams).toBe(1);
    await openTools(page); await page.locator('#terminal-button').click(); await expect(page.locator('#accept-confirmation')).toHaveText('确认打开终端');
    await page.locator('#accept-confirmation').click();
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'terminal' }]);
    await expect(page.locator('#terminal-button')).toBeEnabled();
    await openTools(page); await page.locator('#reconnect-button').click(); await expect(page.locator('#accept-confirmation')).toHaveText('确认重新连接');
    await page.locator('#accept-confirmation').click();
    await expect.poll(() => streams).toBe(2); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(claims).toBe(2); expect(app.inputCalls).toEqual([{ action: 'terminal' }]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('interrupt button is confirmed separately while Enter remains a direct explicit action', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    const interrupt = page.locator('[data-key="Ctrl+C"]');
    await openInput(page);
    await interrupt.click(); await page.locator('#cancel-confirmation').click(); expect(app.inputCalls).toEqual([]);
    await interrupt.click(); await expect(page.locator('#confirmation-title')).toContainText('中断');
    await page.locator('#accept-confirmation').click();
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+C' }]);
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+C' }, { action: 'key', key: 'Enter' }]);
    await expect(page.locator('#action-confirmation')).toBeHidden();
  } finally { await app.close(); }
});

test('takeover discards an unconfirmed terminal action rather than keeping it for a new stream', async ({ page, context }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await openTools(page); await page.locator('#terminal-button').click();
    await expect(page.locator('#action-confirmation')).toBeVisible();
    const second = await context.newPage(); await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#action-confirmation')).toBeHidden({ timeout: 10000 });
    await page.locator('#accept-confirmation').evaluate(button => button.click());
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    await second.close();
  } finally { await app.close(); }
});

test('touch targets remain separate and the narrow mobile layout stays within the screen', async ({ page }, info) => {
  const app = await fixture({ rfb: true });
  try {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
    await login(page, app);
    for (const selector of ['#logout-button', '#terminal-button', '#reconnect-button', '[data-key="Ctrl+C"]']) {
      if (selector.startsWith('[data-key=')) await openInput(page);
      else if (selector !== '#logout-button') await openTools(page);
      const rect = await page.locator(selector).boundingBox(); expect(rect.width).toBeGreaterThanOrEqual(44);
      // The wide sidebar deliberately keeps its account row compact. Phone
      // header controls and all actions inside panels retain 44px targets.
      const sidebarLogout = selector === '#logout-button' && await page.locator('#workspace-view').evaluate(element => element.classList.contains('sidebar-layout'));
      expect(rect.height).toBeGreaterThanOrEqual(sidebarLogout ? 32 : 44);
    }
    const files = await page.locator('#files-button').boundingBox(), logout = await page.locator('#logout-button').boundingBox();
    expect(Math.max(logout.x - files.x - files.width, files.x - logout.x - logout.width,
      logout.y - files.y - files.height, files.y - logout.y - logout.height)).toBeGreaterThanOrEqual(8);
    const card = await page.locator('#desktop-card').boundingBox();
    await openTools(page);
    for (const id of ['width-button', 'fit-button', 'actual-size-button', 'zoom-out-button', 'zoom-in-button', 'awake-button']) {
      const rect = await page.locator('#' + id).boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(card.x); expect(rect.x + rect.width).toBeLessThanOrEqual(card.x + card.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#logout-button').click();
    await page.screenshot({ path: `test-results/${info.project.name}-confirmation.png` });
    if (info.project.name === 'desktop') {
      await page.locator('#cancel-confirmation').click(); await page.locator('#fullscreen-button').click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
      await openTools(page); await page.locator('#terminal-button').click(); await expect(page.locator('#action-confirmation')).toBeVisible();
      await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.locator('#cancel-confirmation').click();
      expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
      await page.evaluate(() => document.exitFullscreen());
    }
  } finally { await app.close(); }
});
