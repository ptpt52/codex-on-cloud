import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test('find and copy grows upward from the terminal edge without moving controls or resizing the terminal', async ({ page }, info) => {
  const app = await fixture({ terminalHistory: 'DRAWER-HISTORY\n'.repeat(100) });
  try {
    await page.addInitScript(() => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
      if (location.pathname !== '/terminal/index.html') return;
      let Terminal;
      Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
        set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.drawerTerminal = this; } }; } });
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    const geometry = () => frame.evaluate(() => ({ rows: window.drawerTerminal.rows, cols: window.drawerTerminal.cols, height: document.getElementById('terminal').clientHeight }));
    for (const viewport of [page.viewportSize(), { width: 320, height: 500 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => (await frame.locator('#history-tools-toggle').boundingBox())?.width).toBeGreaterThan(0);
      const before = await geometry(), button = await frame.locator('#history-up').boundingBox();
      await frame.locator('#history-tools-toggle').click(); const drawer = page.locator('#history-tools'); await expect(drawer).toBeVisible();
      await expect.poll(async () => {
        const bar = await drawer.boundingBox(), terminal = await page.locator('#desktop-frame').boundingBox();
        return Math.abs(bar.y + bar.height - terminal.y) <= 1 && Math.abs(bar.x - terminal.x) <= 1 && Math.abs(bar.width - terminal.width) <= 1;
      }).toBe(true);
      expect(await geometry()).toEqual(before);
      expect(await frame.locator('#history-up').boundingBox()).toEqual(button);
      await expect(page.locator('#history-query')).toBeInViewport(); await expect(page.locator('#history-tools-close')).toBeInViewport();
      expect(await drawer.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, bottom: getComputedStyle(el).borderBottomLeftRadius }))).toEqual({ shadow: 'none', bottom: '0px' });
      expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await drawer.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await page.screenshot({ path: info.outputPath(`drawer-${viewport.width}.png`) });
      await page.locator('#history-tools-close').click(); await expect(drawer).toBeHidden(); expect(await geometry()).toEqual(before);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await frame.locator('#history-tools-toggle').click();
    await expect(page.locator('#history-tools')).toHaveCSS('animation-name', 'none');
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
