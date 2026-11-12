import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

test('tools keep their close button and preference status reachable while keyboard focus scrolls to the last action', async ({ page }) => {
  test.setTimeout(60000);
  for (const mode of ['desktop', 'terminal']) {
    const app = await fixture({ rfb: true, mode }), errors = [];
    const pageError = error => errors.push(error.message); page.on('pageerror', pageError);
    try {
      await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
      await expect(page.locator('#connection-status')).toContainText('在线');
      await openInput(page); await page.locator('#mobile-input').fill('滚动工具面板后保留的草稿'); await closePanels(page);
      const source = await page.locator('#desktop-frame').getAttribute('src'), connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
      for (const [index, size] of [{ width: 320, height: 500 }, { width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 1440, height: 240 }].entries()) {
        await page.setViewportSize(size);
        // The media-query change moves controls after the viewport updates.
        await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', size.width >= 1200 ? 'sidebar' : 'top');
        const frame = await page.locator('#desktop-frame').boundingBox();
        await openTools(page);
        const close = page.locator('#close-controls-button'), initial = await close.boundingBox();
        await page.locator('#access-settings-button').focus();
        await expect(page.locator('#access-settings-button')).toBeInViewport();
        await expect(page.locator('#browser-preferences-note')).toBeInViewport();
        await expect(close).toBeInViewport();
        expect(await close.boundingBox()).toEqual(initial);
        // Firefox can round a 44px rectangle down by a few millionths of a pixel.
        expect(initial.width).toBeGreaterThanOrEqual(43.99); expect(initial.height).toBeGreaterThanOrEqual(43.99);
        expect(await page.locator('#workspace-tools').evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
        if (index % 2) { await page.keyboard.press('Escape'); await expect(page.locator('#toggle-controls-button')).toBeFocused(); }
        else await close.click();
        await expect(page.locator('#workspace-tools')).toBeHidden();
        expect(await page.locator('#desktop-frame').boundingBox()).toEqual(frame);
        expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
      }
      await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('滚动工具面板后保留的草稿');
      expect({ vnc: app.vncConnections, terminal: app.terminalConnections }).toEqual(connections); expect(app.managementStats.restarts).toBe(0);
      expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(errors).toEqual([]);
    } finally { page.off('pageerror', pageError); await app.close(); }
  }
});
