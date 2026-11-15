import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { closePanels, openInput } from './ui.mjs';
async function switchMode(page, mode) {
  await closePanels(page); await page.locator(`#${mode}-mode`).click();
  await page.locator('#accept-confirmation').click();
  await expect(page.locator('#connection-status')).toContainText(mode === 'desktop' ? '桌面在线' : '终端在线');
}
for (const continuous of [false, true]) test(`parked desktop stops ${continuous ? 'continuous' : 'incremental'} frames and refreshes before accepting input`, async ({ page }) => {
  let release; const pending = new Set();
  const app = await fixture({ rfb: true, rfbSize: { width: 160, height: 100 }, rfbUpdates: true, rfbContinuous: continuous, seamless: true,
    rfbResumeHook: () => new Promise(resolve => { release = resolve; pending.add(resolve); }) });
  await page.addInitScript(() => {
    if (window !== parent) return;
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', modeStandby: true }));
    window.desktopFrameReady = false;
    window.addEventListener('message', e => { if (e.origin === location.origin && e.source === document.querySelector('#desktop-frame')?.contentWindow && e.data.type === 'codex-desktop-view') window.desktopFrameReady = e.data.frameReady; });
  });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect.poll(() => page.evaluate(() => window.desktopFrameReady)).toBe(true);
    await expect.poll(() => app.vncFrames).toBeGreaterThan(3);
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await expect(page.locator('#standby-frame')).toHaveAttribute('src', /terminal/);
    await switchMode(page, 'terminal');
    await page.waitForTimeout(200); const parked = app.vncFrames;
    await page.waitForTimeout(350); expect(app.vncFrames).toBe(parked);
    for (let i = 0; i < 2; i++) {
      release = undefined; await switchMode(page, 'desktop');
      await expect.poll(() => typeof release).toBe('function');
      await expect.poll(() => page.evaluate(() => window.desktopFrameReady)).toBe(false);
      await openInput(page); await expect(page.locator('#paste-button')).toBeDisabled();
      expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(1);
      release(); await expect.poll(() => page.evaluate(() => window.desktopFrameReady)).toBe(true);
      await expect(page.locator('#paste-button')).toBeEnabled();
      const frames = app.vncFrames; await expect.poll(() => app.vncFrames).toBeGreaterThan(frames + 2);
      if (i === 0) await switchMode(page, 'terminal');
    }
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { for (const resolve of pending) resolve(); await app.close(); }
});
