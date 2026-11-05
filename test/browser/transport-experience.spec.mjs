import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
for (const mode of ['desktop', 'terminal']) test(`${mode}: relay presents the task while direct negotiation waits in the background`, async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true });
  let release; const hold = new Promise(resolve => { release = resolve; });
  try {
    await page.addInitScript(mode => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true })), mode);
    await page.route(`**/api/${mode}/rtc`, async route => { await hold; await route.continue().catch(() => {}); });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText(mode === 'desktop' ? '桌面在线' : '终端在线');
    await expect(page.frameLocator('#desktop-frame').locator(mode === 'desktop' ? '#screen canvas' : '.xterm-screen')).toBeVisible();
    await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText(mode === 'desktop' ? '中转' : 'WebSocket');
    await page.locator('#close-connection').click(); release();
    await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { release(); await app.close(); }
});
