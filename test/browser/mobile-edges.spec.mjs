import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

for (const mode of ['terminal', 'desktop']) test(`${mode} uses the phone width without outer gutters or header overflow`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await page.setViewportSize({ width: 444, height: 900 });
    await page.addInitScript(mode => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, controlsCollapsed: true, terminalInputCollapsed: true }));
    }, mode);
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    for (const width of [320, 360, 390, 420, 421, 444, 480, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await page.locator('#desktop-frame').boundingBox()).width).toBe(width);
      const bounds = await page.evaluate(() => {
        const card = document.getElementById('desktop-card').getBoundingClientRect();
        const frame = document.getElementById('desktop-frame').getBoundingClientRect();
        const actions = ['connection-button', 'forward-button', 'files-button', 'logout-button'].map(id => {
          const box = document.getElementById(id).getBoundingClientRect(); return { id, left: box.left, right: box.right, width: box.width, height: box.height };
        });
        return { card: [card.left, card.right], frame: [frame.left, frame.right], scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight, height: document.documentElement.clientHeight, actions };
      });
      expect(bounds.card).toEqual([0, width]); expect(bounds.frame).toEqual([0, width]);
      expect(bounds.scrollWidth).toBe(width); expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height + 1);
      for (const box of bounds.actions) {
        expect(box.left, box.id).toBeGreaterThanOrEqual(0); expect(box.right, box.id).toBeLessThanOrEqual(width);
        expect(box.width, box.id).toBeGreaterThanOrEqual(44); expect(box.height, box.id).toBeGreaterThanOrEqual(44);
      }
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    expect((await page.locator('#desktop-card').boundingBox()).x).toBeGreaterThan(0);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['terminal', 'desktop']) test(`${mode} keeps the wide-screen footer compact and fits short browser windows`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(mode => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, controlsCollapsed: true, terminalInputCollapsed: true }));
    }, mode);
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    for (const height of [900, 600, 540, 480, 320, 240, 900]) {
      await page.setViewportSize({ width: 1440, height });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height + 1);
      const frame = await page.locator('#desktop-frame').boundingBox(), card = await page.locator('#desktop-card').boundingBox();
      expect(card.x).toBeGreaterThan(0); expect(frame.height).toBeGreaterThan(0);
      expect(height - frame.y - frame.height).toBeLessThanOrEqual(20);
      const footer = await page.locator('.workspace-footer').boundingBox();
      if (height > 540) { expect(footer).not.toBeNull(); expect(footer.height).toBeLessThanOrEqual(20); }
      else expect(footer).toBeNull();
    }
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
