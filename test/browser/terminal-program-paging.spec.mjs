import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

for (const alternate of [false, true]) test(`program paging buttons resume after find and copy in the ${alternate ? 'alternate' : 'normal'} screen`, async ({ page }) => {
  const app = await fixture({ terminalHistory: 'ONLY-SNAPSHOT\n', terminalHistoryAlternate: alternate });
  try {
    await page.addInitScript(() => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
      if (location.pathname !== '/terminal/index.html') return;
      let Terminal;
      Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
        set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.pagingTerminal = this; } }; } });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.pagingCopy = text; } } });
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    const text = (alternate ? '\x1b[?1049h' : '') + '\x1b[2J\x1b[HPROGRAM-PAGE\r\n';
    app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
    await expect.poll(() => frame.evaluate(() => window.pagingTerminal.buffer.active.getLine(0)?.translateToString(true))).toBe('PROGRAM-PAGE');
    await frame.locator('#history-program').click(); await frame.locator('#history-up').click();
    const inputs = ['\x1b[5~']; await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(inputs);
    const archive = frame.locator('#history-archive');
    for (const direction of ['down', 'up', 'up']) {
      await frame.locator('#history-tools-toggle').click();
      await expect(archive).toBeVisible(); await expect(archive).toContainText('PROGRAM-PAGE');
      await expect(page.locator('#history-tools')).toBeVisible();
      await page.locator('#history-query').fill('PROGRAM-PAGE'); await expect(page.locator('#history-find-state')).toContainText('1/1');
      await page.locator('#history-copy-all').click(); expect(await frame.evaluate(() => window.pagingCopy)).toContain('PROGRAM-PAGE');
      await expect(frame.locator('#history-up')).toBeEnabled(); await expect(frame.locator('#history-down')).toBeEnabled();
      await frame.locator('#history-' + direction).click();
      inputs.push(direction === 'up' ? '\x1b[5~' : '\x1b[6~');
      await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(inputs);
      await expect(archive).toBeHidden(); await expect(page.locator('#history-tools')).toBeHidden();
      await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
    }
    // Explicit clicks remain independent even when they are less than 160 ms apart.
    await frame.evaluate(() => { document.getElementById('history-up').click(); document.getElementById('history-down').click(); });
    inputs.push('\x1b[5~', '\x1b[6~'); await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(inputs);
    expect(app.terminalHistoryReads).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
