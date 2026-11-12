import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { readFile } from 'node:fs/promises';

async function login(page, app, mouseReporting = false) {
  await page.addInitScript(mouseReporting => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true, terminalMouseReporting: mouseReporting }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.pagingTerminal = this; } }; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.pagingCopy = text; } } });
  }, mouseReporting);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
function output(app, text) {
  app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
}
const firstLine = frame => frame.evaluate(() => window.pagingTerminal.buffer.active.getLine(0)?.translateToString(true));

test('program wheels use fine native mouse reports without the page-key throttle, and fall back when mouse encoding is disabled', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app, true);
    output(app, '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[HNATIVE-WHEEL');
    await expect.poll(() => firstLine(frame)).toBe('NATIVE-WHEEL');
    await frame.locator('#history-program').click();
    await expect(frame.locator('#history-state')).toContainText('原生方式');
    await frame.locator('#history-tools-toggle').click();
    await page.locator('#history-query').fill('NATIVE');
    await frame.locator('.xterm-screen').evaluate(el => {
      const box = el.getBoundingClientRect();
      for (const deltaY of [-120, -120, 120]) el.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: box.x + 10, clientY: box.y + 10, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => app.terminalInputs.map(value => /^\x1b\[<(64|65);\d+;\d+M$/.exec(value.text)?.[1])).toEqual(['64', '64', '65']);
    await page.waitForTimeout(200);
    await expect(page.locator('#history-tools')).toBeVisible(); await expect(frame.locator('#history-archive')).toBeHidden();
    await expect(page.locator('#history-query')).toHaveValue('NATIVE');
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
    output(app, '\x1b[?1006l'); await expect(frame.locator('#history-state')).toContainText('PageUp');
    await frame.locator('.xterm-screen').dispatchEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    await expect.poll(() => app.terminalInputs.at(-1)?.text).toBe('\x1b[5~');
    const before = app.terminalInputs.length;
    await frame.evaluate(() => window.dispatchEvent(new Event('offline')));
    await frame.locator('.xterm-screen').dispatchEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    expect(app.terminalInputs.length).toBe(before); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

for (const alternate of [false, true]) for (const toolsFirst of [false, true]) test(`find stays open across paging in the ${alternate ? 'alternate' : 'normal'} screen (${toolsFirst ? 'tools first' : 'program first'})`, async ({ page }) => {
  const app = await fixture({ terminalHistory: 'ONLY-SNAPSHOT\n', terminalHistoryAlternate: alternate });
  try {
    const frame = await login(page, app);
    const text = (alternate ? '\x1b[?1049h' : '') + '\x1b[2J\x1b[HPROGRAM-PAGE\r\n';
    output(app, text); await expect.poll(() => firstLine(frame)).toBe('PROGRAM-PAGE');
    if (!toolsFirst) await frame.locator('#history-program').click();
    const archive = frame.locator('#history-archive');
    await frame.locator('#history-tools-toggle').click();
    await page.locator('#history-query').fill('PROGRAM-PAGE'); await expect(page.locator('#history-find-state')).toContainText('1/1');
    if (toolsFirst) await frame.locator('#history-program').click();
    const inputs = []; let index = 0;
    for (const direction of ['up', 'down', 'up', 'latest']) {
      await expect(frame.locator('#history-up')).toBeEnabled(); await expect(frame.locator('#history-down')).toBeEnabled();
      await frame.locator('#history-' + direction).click();
      inputs.push(direction === 'up' ? '\x1b[5~' : direction === 'down' ? '\x1b[6~' : '\x1b[1;5F');
      await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(inputs);
      await expect(archive).toBeHidden(); await expect(page.locator('#history-tools')).toBeVisible();
      await expect(page.locator('#history-query')).toHaveValue('PROGRAM-PAGE');
      await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
      // Paint a different received page. Find/copy must read this page rather
      // than reusing the snapshot from before the remote paging request.
      const marker = 'PROGRAM-PAGE-' + ++index;
      output(app, '\x1b[2J\x1b[H' + marker + '\r\n'); await expect.poll(() => firstLine(frame)).toBe(marker);
      if (index === 2) await page.locator('#history-copy-all').click();
      else if (index === 3) await page.locator('#history-find-next').click();
      else if (index === 4) {
        await frame.locator('.xterm-helper-textarea').press('Control+f'); await expect(page.locator('#history-query')).toBeFocused();
        await page.locator('#history-query').press('Enter');
      }
      else {
        await page.locator('#history-query').click();
        await expect(page.locator('#history-query')).toBeFocused();
        await page.locator('#history-query').press('Enter');
      }
      await expect(archive).toBeVisible(); await expect(archive.locator('mark')).toHaveText('PROGRAM-PAGE');
      await expect(archive).toContainText(marker);
      await page.locator('#history-copy-all').click(); expect(await frame.evaluate(() => window.pagingCopy)).toContain(marker);
      for (const program of [false, true]) {
        await frame.locator('#history-program').click();
        await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
        await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#history-query')).toHaveValue('PROGRAM-PAGE');
      }
    }
    // Explicit clicks remain independent even when they are less than 160 ms apart.
    await frame.evaluate(() => { document.getElementById('history-up').click(); document.getElementById('history-down').click(); });
    inputs.push('\x1b[5~', '\x1b[6~'); await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(inputs);
    await expect(page.locator('#history-tools')).toBeVisible();
    await page.locator('#history-tools-close').click(); await expect(page.locator('#history-tools')).toBeHidden();
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    expect(app.terminalHistoryReads).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('copy and download capture the current page while program and local paging keep the drawer open', async ({ page }, info) => {
  const app = await fixture({ terminalHistory: 'LOCAL-HISTORY\n' });
  try {
    const frame = await login(page, app); output(app, '\x1b[2J\x1b[HLIVE-DOWNLOAD\r\n');
    await expect.poll(() => firstLine(frame)).toBe('LIVE-DOWNLOAD');
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-query').fill('LIVE');
    await frame.locator('#history-latest').click(); await expect(frame.locator('#history-archive')).toBeHidden();
    const downloading = page.waitForEvent('download'); await page.locator('#history-download').click();
    const download = await downloading, path = info.outputPath('current-page.txt'); await download.saveAs(path);
    expect(await readFile(path, 'utf8')).toContain('LIVE-DOWNLOAD');
    await frame.locator('#history-latest').click(); await frame.locator('#history-program').click();
    await frame.locator('#terminal').dispatchEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(['\x1b[5~']);
    await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#history-query')).toHaveValue('LIVE');
    await frame.locator('.xterm-helper-textarea').press('x');
    await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(['\x1b[5~', 'x']);
    await frame.locator('#history-program').click(); await frame.locator('#history-up').click();
    await expect(frame.locator('#history-archive')).toContainText('LOCAL-HISTORY');
    await expect(page.locator('#history-tools')).toBeVisible(); await page.locator('#history-query').fill('LOCAL');
    await expect(page.locator('#history-find-state')).toContainText('1/1');
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('offline return-live and reconnect preserve find without replaying keys or accepting hidden toolbar clicks', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app); output(app, '\x1b[2J\x1b[HOFFLINE-PAGE\r\n');
    await expect.poll(() => firstLine(frame)).toBe('OFFLINE-PAGE');
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-query').fill('OFFLINE');
    await frame.locator('#history-program').click(); await frame.locator('#history-up').click();
    await expect.poll(() => app.terminalInputs.length).toBe(1);
    await frame.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
    await expect(frame.locator('#history-up')).toBeDisabled(); await frame.locator('#history-latest').dispatchEvent('click');
    await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#history-query')).toHaveValue('OFFLINE');
    await expect(frame.locator('#history-state')).toContainText('未发送');
    await page.locator('#history-copy-all').click(); expect(await frame.evaluate(() => window.pagingCopy)).toContain('OFFLINE-PAGE');
    await frame.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(app.terminalInputs.map(value => value.text)).toEqual(['\x1b[5~']);
    await expect(page.locator('#history-query')).toHaveValue('OFFLINE');
    await frame.locator('#history-latest').click(); await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(['\x1b[5~', '\x1b[1;5F']);
    await page.locator('#history-tools-close').click(); await frame.locator('#history-copy-all').dispatchEvent('click');
    await expect(frame.locator('#history-archive')).toBeHidden(); await expect(frame.locator('#terminal')).toHaveAttribute('data-reviewing', 'false');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('changing paging mode cancels pending history and paging cancels pending local find without closing the drawer', async ({ page }) => {
  let release, delivered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture({ terminalHistory: () => { delivered = true; return 'LATE-HISTORY\n'; }, terminalHistoryHook: () => gate });
  try {
    const frame = await login(page, app); await frame.locator('#history-up').click();
    await expect.poll(() => app.terminalHistoryReads.length).toBe(1);
    await frame.locator('#history-tools-toggle').click(); await expect(page.locator('#history-query')).toBeDisabled();
    await frame.locator('#history-program').click(); await expect(page.locator('#history-query')).toBeEnabled();
    release(); await expect.poll(() => delivered).toBe(true);
    await page.locator('#history-query').fill('pending'); await frame.locator('#history-up').click();
    await page.waitForTimeout(200);
    await expect(frame.locator('#history-archive')).toBeHidden(); await expect(page.locator('#history-tools')).toBeVisible();
    await expect(page.locator('#history-query')).toHaveValue('pending');
    expect(app.terminalInputs.map(value => value.text)).toEqual(['\x1b[5~']); expect(app.terminalHistoryReads.length).toBe(1);
  } finally { release(); await app.close(); }
});
