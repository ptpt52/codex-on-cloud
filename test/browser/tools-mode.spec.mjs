import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools } from './ui.mjs';

const desktopControls = ['#terminal-button', '#workspace-tools .zoom-controls', '#pointer-options', '#desktop-settings-button', '#pan-button'];
const terminalControls = ['#terminal-view-controls', '#terminal-view-select', '#terminal-width-mode', '#terminal-font-up', '#terminal-history-rows'];
const commonControls = ['#terminals-button', '#reconnect-button', '#tools-fullscreen-button', '#awake-button', '#portal-settings-button', '#access-settings-button'];
async function login(page, app, status) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText(status);
}
async function tools(page, mode) {
  await openTools(page);
  for (const selector of desktopControls) {
    if (mode === 'desktop') await expect(page.locator(selector)).toBeVisible();
    else await expect(page.locator(selector)).toBeHidden();
  }
  for (const selector of terminalControls) {
    if (mode === 'terminal') await expect(page.locator(selector)).toBeVisible();
    else await expect(page.locator(selector)).toBeHidden();
  }
  for (const selector of commonControls) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#display-controls')).toHaveAttribute('aria-label', mode === 'terminal' ? '网页终端显示控制' : '桌面显示控制');
  if (mode === 'terminal') expect((await page.locator('#terminal-width-mode').boundingBox()).width).toBeGreaterThan(120);
}
async function mode(page, value) {
  await page.locator(`#${value}-mode`).click(); await page.locator('#accept-confirmation').click();
  await expect(page.locator('#connection-status')).toContainText(value === 'terminal' ? '终端在线' : '桌面在线');
}

test('tools show only the active mode settings and switching modes preserves both sets of preferences', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app, '桌面在线'); await tools(page, 'desktop');
    const original = (await app.controls.listTerminals()).terminals;
    await page.locator('#fit-button').click(); await page.locator('#pointer-mode').selectOption('trackpad');
    await mode(page, 'terminal'); await tools(page, 'terminal');
    await page.locator('#terminal-font-up').click(); await page.locator('#terminal-width-mode').selectOption('manual');
    await page.locator('#terminal-history-rows').selectOption('5000');
    await mode(page, 'desktop'); await tools(page, 'desktop');
    await expect(page.locator('#fit-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pointer-mode')).toHaveValue('trackpad');
    await mode(page, 'terminal'); await tools(page, 'terminal');
    await expect(page.locator('#terminal-font-label')).toHaveText('16');
    await expect(page.locator('#terminal-width-mode')).toHaveValue('manual');
    await expect(page.locator('#terminal-history-rows')).toHaveValue('5000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await app.controls.listTerminals()).terminals).toEqual(original);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('terminal-only deployment hides all desktop tools even with a saved desktop mode', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'desktop', zoom: 'fit' })));
    await login(page, app, '终端在线'); await tools(page, 'terminal');
    await expect(page.locator('#desktop-mode')).toBeHidden();
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
