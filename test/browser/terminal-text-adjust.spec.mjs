import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

async function fallbackTerminal(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode: 'terminal', terminalFontSize: 10, terminalWidthMode: 'viewport' }));
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      // Model Android's separate Latin monospace and CJK fallback fonts.
      set: Native => { Terminal = class extends Native { constructor(options) { super({ ...options, fontFamily: 'monospace' }); window.adjustTerminal = this; } }; } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}

test('CJK fallback ink fits inside each live row at small fonts, including wrapped and bold text', async ({ page }, info) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    const frame = await fallbackTerminal(page, app), connections = app.terminalConnections;
    for (let step = 0; step < 4; step++) {
      if (step) { await openTools(page); await page.locator('#terminal-font-up').click(); await closePanels(page); }
      const clipped = await frame.evaluate(async () => {
        const term = window.adjustTerminal;
        await new Promise(resolve => term.write('\x1b[2J\x1b[H' + '这是中文字符'.repeat(Math.ceil(term.cols / 6)) + '\r\n\x1b[1m' + '中文全角标点，。'.repeat(Math.ceil(term.cols / 6)) + '\x1b[0m', resolve));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const context = document.createElement('canvas').getContext('2d'), failures = [];
        for (const row of [...document.querySelectorAll('.xterm-rows > div')].filter(row => row.textContent).slice(0, 12)) {
          const box = row.getBoundingClientRect();
          for (const span of [...row.children].filter(span => span.textContent)) {
            const css = getComputedStyle(span), marker = document.createElement('i');
            Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0' }); span.append(marker);
            const baseline = marker.getBoundingClientRect().top; marker.remove();
            context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
            const ink = context.measureText(span.textContent);
            if (baseline - ink.actualBoundingBoxAscent < box.top - .5 || baseline + ink.actualBoundingBoxDescent > box.bottom + .5) {
              failures.push({ text: span.textContent, row: box.height, top: baseline - ink.actualBoundingBoxAscent - box.top, bottom: box.bottom - baseline - ink.actualBoundingBoxDescent });
            }
          }
        }
        return failures;
      });
      expect(clipped).toEqual([]);
    }
    await page.screenshot({ path: info.outputPath('cjk-fallback-ink.png') });
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

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
