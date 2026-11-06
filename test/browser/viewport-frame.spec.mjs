import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test('ServerInit cannot resize a desktop before its first complete pixel frame and startup settlement', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1280, height: 720 }, rfbFrameHook: () => hold });
  try {
    await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true })));
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.waitForTimeout(1700);
    expect(app.managementStats.viewportResizes).toBe(0);
    expect(app.vncConnections).toBe(1);
    release();
    await page.waitForTimeout(300); expect(app.managementStats.viewportResizes).toBe(0);
    await expect.poll(() => page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(el => [el.width, el.height]), { timeout: 12000 }).toEqual([1600, 3200]);
    expect(app.managementStats.viewportResizes).toBe(1);
    expect(app.vncConnections).toBe(1); expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { release(); await app.close(); }
});
