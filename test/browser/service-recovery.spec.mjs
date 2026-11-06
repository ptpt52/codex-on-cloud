import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test('service recovery diagnostics are read-only, update on refresh and do not resend an existing draft', async ({ page }) => {
  let restarts = 2;
  const app = await fixture({ rfb: true, serviceDiagnostics: async () => ({ available: true, panel: { state: 'active', restarts, limited: false }, manager: { state: 'active' }, actions: { state: 'inactive' } }) });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('保留，不自动发送');
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-recovery')).toHaveText('已自动恢复 · 2 次'); await expect(page.locator('#diag-services')).toContainText('桌面执行：未就绪');
    restarts = 3; await page.locator('#refresh-connection').click(); await expect(page.locator('#diag-recovery')).toHaveText('已自动恢复 · 3 次');
    await page.locator('#close-connection').click(); await expect(page.locator('#mobile-input')).toHaveValue('保留，不自动发送'); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a delayed recovery cannot take over another page and preserves the unsent draft', async ({ page }) => {
  const app = await fixture({ rfb: true }), conditional = [];
  page.on('request', request => { if (request.url().endsWith('/api/desktop/claim') && request.postDataJSON()?.ifFree) conditional.push(request.postDataJSON()); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('恢复不得抢占另一页面');
    const other = '22222222-2222-4222-8222-222222222222'; await app.login(); await app.claim(other);
    await page.route('**/api/state', async route => { const response = await route.fetch(), state = await response.json(); await route.fulfill({ response, json: { ...state, mine: false, claimable: true } }); });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => conditional.length).toBe(1);
    expect((await (await app.request('/api/state', { headers: { 'x-viewer-id': other } })).json()).mine).toBe(true);
    expect(app.inputCalls).toEqual([]); await expect(page.locator('#mobile-input')).toHaveValue('恢复不得抢占另一页面');
  } finally { await app.close(); }
});
