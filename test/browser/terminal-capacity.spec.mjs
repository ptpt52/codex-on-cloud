import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

for (const direct of [false, true]) test(`eight configured terminals preserve drafts and route paste and Enter to aux7 over ${direct ? 'direct' : 'relay'}`, async ({ page }) => {
  const app = await fixture({ mode: 'terminal', maxTerminals: 8, rfb: true, seamless: true, fastConnect: true, webrtc: direct });
  for (let number = 1; number <= 7; number++) await app.controls.manageTerminals({ action: 'create', name: `辅助 ${number}`, view: 'terminal' });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await openInput(page); await page.locator('#mobile-input').fill('主终端草稿');
    await page.locator('#input-terminal').selectOption('aux7'); await expect(page.locator('#mobile-input')).toHaveValue('');
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#mobile-input').fill('第八终端文字'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux7', text: '\x1b[200~第八终端文字\x1b[201~' }]);
    await page.locator('[data-key="Enter"]').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux7', text: '\x1b[200~第八终端文字\x1b[201~' }, { terminalId: 'aux7', text: '\r' }]);
    await page.locator('#input-terminal').selectOption('main'); await expect(page.locator('#mobile-input')).toHaveValue('主终端草稿');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await closePanels(page); await openTools(page); await page.locator('#terminal-view-manage').click();
    await expect(page.locator('.terminal-row')).toHaveCount(8); await expect(page.locator('#terminals-status')).toContainText('8 / 8');
    await expect(page.locator('#create-terminal')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('the browser uses a deployment limit of one', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', maxTerminals: 1, rfb: true });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await openTools(page); await page.locator('#terminal-view-manage').click();
    await expect(page.locator('#terminals-status')).toContainText('1 / 1'); await expect(page.locator('#create-terminal')).toBeDisabled();
    expect((await app.controls.listTerminals()).terminals).toHaveLength(1);
  } finally { await app.close(); }
});
