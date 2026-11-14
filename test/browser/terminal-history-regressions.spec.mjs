import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });

async function terminal(page, app) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.regressionCopied = text; } } });
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode: 'terminal', terminalFontSize: 15, terminalWidthMode: 'viewport' }));
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(options) { super(options); window.regressionTerminal = this; } }; } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}

test('wrapped commands remain searchable and copyable intact without changing their visible row layout', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    const frame = await terminal(page, app);
    const seed = await frame.evaluate(async () => {
      const t = window.regressionTerminal, source = 'LONG-COMMAND-' + Array.from({ length: t.cols }, (_, index) => index.toString(36).padStart(3, '0')).join('');
      const text = source.slice(0, t.cols - 2) + '  ' + source.slice(t.cols);
      await new Promise(resolve => t.write('\x1bc' + text + '\r\nHARD\r\nBREAK', resolve));
      const rows = Array.from({ length: t.buffer.active.length }, (_, index) => t.buffer.active.getLine(index).translateToString(true, 0, t.cols));
      return { text, query: text.slice(t.cols - 4, t.cols + 8), rows };
    });
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-query').fill(seed.query);
    await expect(frame.locator('#history-archive')).toBeVisible(); await expect(page.locator('#history-find-state')).toContainText('1/1');
    expect((await frame.locator('#history-archive').textContent()).split('\n')).toEqual(seed.rows);
    await page.locator('#history-copy-all').click();
    expect(await frame.evaluate(() => window.regressionCopied)).toContain(seed.text + '\nHARD\nBREAK');
    const selected = await frame.locator('#history-archive').evaluate(element => {
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
      const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }); element.dispatchEvent(event);
      return event.clipboardData.getData('text/plain');
    });
    expect(selected).toContain(seed.text + '\nHARD\nBREAK');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
