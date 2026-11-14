import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

async function fallbackTerminal(page, app, family = 'monospace') {
  await page.addInitScript(family => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode: 'terminal', terminalFontSize: 10, terminalWidthMode: 'viewport' }));
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      // Model Android's separate Latin monospace and CJK fallback fonts.
      set: Native => { Terminal = class extends Native { constructor(options) { super({ ...options, fontFamily: family }); window.adjustTerminal = this; } }; } });
  }, family);
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

test('mixed CJK, Latin and numeric output occupies the same columns with browser contextual spacing enabled', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    const frame = await fallbackTerminal(page, app, '"Noto Sans Mono CJK SC", "WenQuanYi Zen Hei Mono", monospace');
    const connections = app.terminalConnections;
    // A TUI draws complete rows rather than relying on shell autowrap. Check
    // its last glyph against the assigned cells, with no padding to hide loss.
    for (let step = 0; step < 3; step++) {
      if (step) { await openTools(page); await page.locator('#terminal-font-up').click(); await closePanels(page); }
      const rows = await frame.evaluate(async () => {
        document.documentElement.style.setProperty('text-autospace', 'normal');
        const t = window.adjustTerminal, text = 'a中1文'.repeat(Math.floor(t.cols / 6)) + 'Z'.repeat(t.cols % 6);
        await new Promise(resolve => t.write('\x1b[?7l\x1b[2J\x1b[H' + text + '\r\n\x1b[1m' + text + '\x1b[0m\x1b[?7h', resolve));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
        return [...document.querySelectorAll('.xterm-rows > div')].filter(row => row.textContent).slice(0, 2).map(row => {
          const range = document.createRange(); range.selectNodeContents(row);
          return { text: row.textContent, expected: text, right: range.getBoundingClientRect().right - screen.left, width: screen.width };
        });
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) { expect(row.text).toBe(row.expected); expect(Math.abs(row.right - row.width)).toBeLessThanOrEqual(1); }
    }
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('history preserves live CJK column positions, styles and row spacing through font changes and search', async ({ page }, info) => {
  const text = 'Aa0123 中文字符，fi |END|', source = `\x1b[1;31m${text}\x1b[0m\n\x1b[3;32m${text}\x1b[0m\n`;
  const app = await fixture({ mode: 'terminal', terminalHistory: source });
  try {
    const frame = await fallbackTerminal(page, app), connections = app.terminalConnections;
    app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from('\x1b[?1049h\x1b[2J\x1b[H' + source.replaceAll('\n', '\r\n')).toString('base64') }) + '\n');
    await expect(frame.locator('.xterm-rows')).toContainText('|END|');
    // Read text-node ranges, not span borders: span borders can fit while
    // font fallback glyphs still extend past their assigned cell positions.
    const positions = async archive => frame.evaluate(({ archive, text }) => {
      const root = document.querySelector(archive ? '#history-archive' : '.xterm-rows'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const targets = [0, text.indexOf('中'), text.indexOf('，'), text.indexOf('|END|')], result = [];
      let node, offset = 0;
      while ((node = walker.nextNode()) && offset < text.length) {
        for (const target of targets) if (target >= offset && target < offset + node.length) {
          const range = document.createRange(); range.setStart(node, target - offset); range.setEnd(node, target - offset + 1);
          const box = range.getBoundingClientRect(), css = getComputedStyle(node.parentElement);
          result.push({ target, x: box.left - root.getBoundingClientRect().left + root.scrollLeft, y: box.top - root.getBoundingClientRect().top + root.scrollTop,
            color: css.color, weight: css.fontWeight, style: css.fontStyle });
        }
        offset += node.length;
      }
      return result;
    }, { archive, text });
    let live = await positions(false);
    await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    for (let step = 0; step < 2; step++) {
      if (step) {
        await openTools(page); await page.locator('#terminal-font-up').click(); await closePanels(page);
        live = await positions(false);
      }
      const snapshot = await positions(true); expect(snapshot).toHaveLength(live.length);
      for (let n = 0; n < live.length; n++) {
        expect(Math.abs(snapshot[n].x - live[n].x)).toBeLessThanOrEqual(1);
        expect(Math.abs(snapshot[n].y - live[n].y)).toBeLessThanOrEqual(1);
        expect([snapshot[n].color, snapshot[n].weight, snapshot[n].style]).toEqual([live[n].color, live[n].weight, live[n].style]);
      }
    }
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-query').fill('中文');
    await expect(frame.locator('#history-archive mark')).toHaveCount(2);
    await expect(frame.locator('#history-archive')).toHaveText(text + '\n' + text + '\n');
    await page.screenshot({ path: info.outputPath('cjk-history-grid.png') });
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('dense mixed-width history bounds its layout nodes while retaining all text', async ({ page }) => {
  const text = 'a中'.repeat(50000), app = await fixture({ mode: 'terminal', terminalHistory: text });
  try {
    const frame = await fallbackTerminal(page, app);
    app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from('\x1b[?1049h').toString('base64') }) + '\n');
    await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    const result = await frame.locator('#history-archive').evaluate((element, expected) => ({
      same: element.textContent === expected, nodes: element.querySelectorAll('.history-grid-run').length,
    }), text);
    expect(result.same).toBe(true); expect(result.nodes).toBeLessThanOrEqual(16384);
    expect(result.nodes).toBeGreaterThan(0); await expect(frame.locator('#history-state')).toContainText('部分样式已简化');
    const blank = await frame.evaluate(async () => {
      const { createHistoryGrid, parseHistoryStyles, renderHistoryRuns } = await import('/terminal/terminal-history-style.js');
      const pre = document.createElement('pre'), text = '\n'.repeat(100000);
      renderHistoryRuns(pre, parseHistoryStyles(text), [], createHistoryGrid(window.adjustTerminal, document.getElementById('terminal')));
      return { same: pre.textContent === text, nodes: pre.firstChild?.childNodes.length };
    });
    expect(blank.same).toBe(true); expect(blank.nodes).toBeLessThan(100);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
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
