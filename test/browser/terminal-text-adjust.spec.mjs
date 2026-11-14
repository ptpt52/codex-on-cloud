import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

test('mobile text adjustment cannot grow terminal glyphs beyond their grid after font changes', async ({ page }, info) => {
  test.skip(!info.project.use.isMobile, 'Mobile browser text adjustment');
  const app = await fixture({ mode: 'terminal' });
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', terminalWidthMode: 'viewport' }));
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.adjustTerminal = this; } }; } });
  });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    const connections = app.terminalConnections;
    for (const [adjust, step] of [['100%', 0], ['125%', 0], ['125%', 1], ['175%', 0], ['175%', 1], ['100%', -1]]) {
      // Model an inherited mobile text-size change after xterm cached glyph
      // measurements. CSS must isolate the grid, while tools remain readable.
      await frame.evaluate(value => { document.documentElement.style.webkitTextSizeAdjust = value; document.documentElement.style.textSizeAdjust = value; }, adjust);
      if (step) {
        await openTools(page); await page.locator(step > 0 ? '#terminal-font-up' : '#terminal-font-down').click(); await closePanels(page);
      }
      await expect.poll(async () => frame.evaluate(async () => {
        const t = window.adjustTerminal;
        const sample = 'commit 99b3df1 (HEAD -> master) fi_Wm0123中文 '.repeat(10).slice(0, t.cols - 1) + 'Z';
        await new Promise(resolve => t.write('\x1b[2J\x1b[H\x1b[33m' + sample + '\x1b[0m', resolve));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
        return [...document.querySelectorAll('.xterm-rows > div')].filter(row => row.textContent).every(row => {
          const range = document.createRange(); range.selectNodeContents(row);
          return range.getBoundingClientRect().right <= screen.right + 1;
        }) && screen.right <= innerWidth && screen.bottom <= innerHeight;
      })).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('mobile-terminal-text-adjust.png') });
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
