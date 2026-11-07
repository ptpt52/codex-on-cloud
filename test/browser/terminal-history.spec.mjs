import { openTools, openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function prepare(page) {
  await page.addInitScript(() => {
    if (window === parent && !localStorage.getItem('codex-cloud.display.v1')) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal; window.terminalInstances = 0;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.historyTerminal = this; window.terminalInstances++; } }; } });
  });
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 20000 });
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
function output(app, text) {
  const bytes = Buffer.from(text), child = app.terminalChildren.at(-1);
  for (let i = 0; i < bytes.length; i += 8192) child.stdout.write(JSON.stringify({ type: 'output', data: bytes.subarray(i, i + 8192).toString('base64') }) + '\n');
}
const lines = (count, prefix = 'LOCAL-HISTORY') => Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, '0')} 中文`).join('\r\n') + '\r\n';
const buffer = frame => frame.evaluate(() => {
  const term = window.historyTerminal, buffer = term.buffer.active;
  return { type: buffer.type, base: buffer.baseY, view: buffer.viewportY, length: buffer.length, rows: term.rows,
    first: buffer.getLine(buffer.viewportY)?.translateToString(true), all: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join('\n') };
});
async function seeded(page, app, count = 220) {
  await prepare(page); const frame = await login(page, app);
  output(app, lines(count));
  await expect.poll(async () => (await buffer(frame)).all.includes(`LOCAL-HISTORY-${String(count - 1).padStart(4, '0')}`)).toBe(true);
  return frame;
}
async function wheel(frame, delta) { await frame.locator('#terminal').dispatchEvent('wheel', { deltaY: delta, deltaMode: 0, bubbles: true, cancelable: true }); }
async function reviewing(frame) { await expect(frame.locator('#terminal')).toHaveAttribute('data-reviewing', 'true'); }

test('styled snapshots preserve colors and decorations over direct transport, with literal markup and inert control strings', async ({ page }, info) => {
  const source = '\x1b[31m红字\x1b[0m  \x1b[1m粗体\x1b[0m\n\x1b[3;4;9m样式\x1b[0m\n\x1b[38;2;1;128;255;48;5;22mRGB\x1b[0m\n' +
    '\x1b]52;c;c2VjcmV0\x07\x1b[6n\x1bPignored\x1b\\<img src="/never-history-image" onerror="window.historyExecuted=true">\n' + lines(90, 'STYLED-HISTORY');
  const app = await fixture({ webrtc: true, terminalHistory: source });
  try {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
    const frame = await seeded(page, app); await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -100);
    const archive = frame.locator('#history-archive'); await expect(archive).toContainText('红字  粗体');
    const styles = await archive.evaluate(element => Object.fromEntries(['红字', '粗体', '样式', 'RGB'].map(text => {
      const span = [...element.children].find(child => child.textContent === text), css = getComputedStyle(span);
      return [text, { color: css.color, background: css.backgroundColor, weight: css.fontWeight, italic: css.fontStyle, decoration: css.textDecorationLine }];
    })));
    expect(styles['红字'].color).toBe('rgb(204, 0, 0)'); expect(styles['粗体'].weight).toBe('700');
    expect(styles['样式'].italic).toBe('italic'); expect(styles['样式'].decoration).toContain('underline'); expect(styles['样式'].decoration).toContain('line-through');
    expect(styles.RGB.color).toBe('rgb(1, 128, 255)'); expect(styles.RGB.background).toBe('rgb(0, 95, 0)');
    expect(await archive.locator('img,script,iframe,a').count()).toBe(0); expect(await frame.evaluate(() => window.historyExecuted)).toBeUndefined();
    expect(await archive.textContent()).not.toMatch(/\x1b|c2VjcmV0|ignored/); await expect(archive).toContainText('<img src="/never-history-image"');
    await expect(frame.locator('#history-state')).toContainText('保留颜色与样式'); await expect(frame.locator('#history-new-output')).toBeHidden();
    const before = await archive.evaluate(element => { element.scrollTop = 24; return element.scrollTop; }), reads = app.terminalHistoryReads.length;
    const viewport = await frame.evaluate(() => ({ rows: window.historyTerminal.rows, height: document.getElementById('terminal').clientHeight }));
    output(app, lines(90, 'AFTER-STYLED'));
    await expect(frame.locator('#history-new-output')).toBeVisible(); await expect.poll(async () => (await buffer(frame)).all.includes('AFTER-STYLED-0089')).toBe(true);
    expect(await archive.evaluate(element => element.scrollTop)).toBe(before); expect(await archive.textContent()).not.toContain('AFTER-STYLED');
    expect(await frame.evaluate(() => ({ rows: window.historyTerminal.rows, height: document.getElementById('terminal').clientHeight }))).toEqual(viewport);
    expect(app.terminalHistoryReads.length).toBe(reads); expect(app.terminalChildren.at(-1).stdout.isPaused()).toBe(false);
    await page.screenshot({ path: `test-results/${info.project.name}-styled-history-new-output.png` });
    await frame.locator('#history-new-output').press('Enter'); await expect(archive).toBeHidden(); await expect(frame.locator('#history-new-output')).toBeHidden();
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); await page.waitForTimeout(100);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('new output notification preserves local reading position and survives reconnect without replay or automatic history reads', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app); await wheel(frame, -320); await reviewing(frame); const before = await buffer(frame);
    await expect(frame.locator('#history-new-output')).toBeHidden(); output(app, lines(20, 'UNSEEN-OUTPUT'));
    await expect(frame.locator('#history-new-output')).toBeVisible(); expect((await buffer(frame)).first).toBe(before.first);
    const box = await frame.locator('#history-new-output').boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    app.disconnectTerminals(); await expect.poll(() => app.terminalConnections).toBe(2); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(frame.locator('#history-new-output')).toBeVisible(); expect((await buffer(frame)).first).toBe(before.first);
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1); expect(app.terminalHistoryReads).toEqual([]);
    await frame.locator('#history-new-output').click(); await expect(frame.locator('#terminal')).toHaveAttribute('data-reviewing', 'false');
    expect((await buffer(frame)).view).toBe((await buffer(frame)).base); await expect(frame.locator('#history-new-output')).toBeHidden();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('new output can return live during a pending snapshot without retrying it or accepting a late reply', async ({ page }) => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ terminalHistory: '\x1b[31mLATE-STYLED\x1b[0m', terminalHistoryHook: async () => { entered(); await hold; } });
  try {
    const frame = await seeded(page, app); await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -100); await started;
    output(app, 'OUTPUT-DURING-READ\r\n'); await expect(frame.locator('#history-new-output')).toBeVisible();
    await frame.locator('#history-new-output').click(); await expect(frame.locator('#terminal')).toHaveAttribute('data-reviewing', 'false');
    release(); await page.waitForTimeout(150); await expect(frame.locator('#history-archive')).toBeHidden(); await expect(frame.locator('#history-new-output')).toBeHidden();
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.terminalConnections).toBe(1);
  } finally { release(); await app.close(); }
});

test('alternate-screen redraws never become scrollback, and history preserves the live font, line height, spaces and wide rows', async ({ page }) => {
  const text = '列一            Column two             列三\n' + '    indented_code();  ' + 'x'.repeat(260) + '\n' + lines(60, 'FAITHFUL-HISTORY');
  const app = await fixture({ terminalHistory: text });
  try {
    await prepare(page); const frame = await login(page, app);
    output(app, '\x1b[?1049h' + Array.from({ length: 40 }, (_, index) => `\x1b[H\x1b[2JREDRAW-${index}\r\n\x1b[8;10HCURSOR-CONTENT`).join(''));
    await expect.poll(async () => (await buffer(frame)).type).toBe('alternate');
    await expect.poll(async () => (await buffer(frame)).all.includes('REDRAW-39')).toBe(true);
    expect((await buffer(frame)).base).toBe(0); await wheel(frame, -200);
    await expect(frame.locator('#history-archive')).toHaveText(text);
    expect(await frame.locator('#history-archive').textContent()).not.toContain('REDRAW');
    const reads = app.terminalHistoryReads.length;
    await openTools(page);
    for (let i = 0; i < 3; i++) await page.locator('#terminal-font-up').click();
    await expect.poll(() => frame.evaluate(() => getComputedStyle(document.getElementById('history-archive')).fontSize)).toBe('18px');
    const style = await frame.evaluate(() => {
      const pre = document.getElementById('history-archive'), css = getComputedStyle(pre), term = window.historyTerminal;
      return { font: css.fontFamily, expected: term.options.fontFamily, height: parseFloat(css.lineHeight), rowHeight: document.querySelector('.xterm-screen').getBoundingClientRect().height / term.rows,
        whiteSpace: css.whiteSpace, width: pre.clientWidth, scrollWidth: pre.scrollWidth };
    });
    expect(style.font).toBe(style.expected); expect(style.height).toBeCloseTo(style.rowHeight, 1);
    expect(style.whiteSpace).toBe('pre'); expect(style.scrollWidth).toBeGreaterThan(style.width);
    expect(await frame.locator('#history-archive').textContent()).toBe(text);
    output(app, '\x1b[H\x1b[2JNEW-REDRAW'); await page.waitForTimeout(150);
    expect(app.terminalHistoryReads.length).toBe(reads); expect(app.terminalInputs).toEqual([]);
    await frame.locator('#history-latest').click(); await expect(frame.locator('#history-archive')).toBeHidden();
    expect((await buffer(frame)).type).toBe('alternate'); expect((await buffer(frame)).base).toBe(0);
  } finally { await app.close(); }
});

test('local history stays in the browser, pauses input, and keeps its position while new output and protocol replies arrive', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app); expect((await buffer(frame)).type).toBe('normal'); await wheel(frame, -320); await reviewing(frame);
    const before = await buffer(frame); await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    const selected = await frame.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedHistory = text; } } });
      const term = window.historyTerminal; term.select(0, term.buffer.active.viewportY, 12); return term.getSelection();
    });
    await frame.locator('.xterm-helper-textarea').press('Control+Shift+C'); await expect.poll(() => frame.evaluate(() => window.copiedHistory)).toBe(selected);
    await frame.locator('.xterm-helper-textarea').press('x'); expect(app.terminalInputs).toEqual([]);
    output(app, lines(60, 'NEW-OUTPUT'));
    await expect.poll(async () => (await buffer(frame)).all.includes('NEW-OUTPUT-0059')).toBe(true);
    const after = await buffer(frame); expect(after.view).toBe(before.view); expect(after.first).toBe(before.first); expect(after.base).toBeGreaterThan(before.base);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalChildren[0].stdout.isPaused()).toBe(false);
    output(app, '\x1b[6n'); await expect.poll(() => app.terminalInputs.length).toBe(1); expect(app.terminalInputs[0].text).toMatch(/^\x1b\[\d+;\d+R$/);
    expect((await buffer(frame)).view).toBe(before.view);
    await frame.locator('#history-latest').click(); await expect(frame.locator('#terminal')).toHaveAttribute('data-reviewing', 'false');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); expect((await buffer(frame)).view).toBe((await buffer(frame)).base);
    expect(app.terminalInputs.length).toBe(1); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('history has a hard row bound, respects screen clears and never stores terminal text in browser storage', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app, 10500); const value = await buffer(frame);
    expect(value.length).toBeLessThanOrEqual(value.rows + 10000); expect(value.all).not.toContain('LOCAL-HISTORY-0000');
    output(app, '\x1b[H\x1b[2JAFTER-CLEAR\r\n'); await expect.poll(async () => (await buffer(frame)).all.includes('AFTER-CLEAR')).toBe(true);
    expect((await buffer(frame)).all).toContain('LOCAL-HISTORY-10400');
    expect(await frame.evaluate(() => [localStorage, sessionStorage].every(storage => Object.values(storage).every(value => !String(value).includes('LOCAL-HISTORY'))))).toBe(true);
    expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('history row choices apply without reconnecting, discard oldest rows when reduced and persist only valid preferences', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app, 2600);
    expect(await frame.evaluate(() => window.historyTerminal.options.scrollback)).toBe(10000);
    expect((await buffer(frame)).all).toContain('LOCAL-HISTORY-0000');
    const connections = app.terminalConnections;
    for (const rows of [2000, 5000, 10000, 20000]) {
      await openTools(page); await page.locator('#terminal-history-rows').selectOption(String(rows));
      await expect.poll(() => frame.evaluate(() => window.historyTerminal.options.scrollback)).toBe(rows);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).terminalHistoryRows)).toBe(rows);
      if (rows === 2000) { const value = await buffer(frame); expect(value.length).toBeLessThanOrEqual(value.rows + rows); expect(value.all).not.toContain('LOCAL-HISTORY-0000'); }
    }
    expect(app.terminalConnections).toBe(connections); expect(await frame.evaluate(() => window.terminalInstances)).toBe(1);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    const restored = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    expect(await restored.evaluate(() => window.historyTerminal.options.scrollback)).toBe(20000);
    for (const invalid of [999999, '20000']) {
      await page.evaluate(value => { const key = 'codex-cloud.display.v1', saved = JSON.parse(localStorage.getItem(key)); saved.terminalHistoryRows = value; localStorage.setItem(key, JSON.stringify(saved)); }, invalid);
      await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
      const current = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
      expect(await current.evaluate(() => window.historyTerminal.options.scrollback)).toBe(10000);
    }
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a 1 MiB history snapshot downloads literal UTF-8 text without additional reads or terminal input', async ({ page }) => {
  const source = Array.from({ length: 12500 }, (_, index) => `DOWNLOAD-${String(index).padStart(5, '0')} 中文😀 ${'x'.repeat(80)}\n`).join('');
  let expected = Buffer.from(source).subarray(-1048576); expected = expected.subarray(expected.indexOf(10) + 1);
  const app = await fixture({ terminalHistory: source });
  try {
    await prepare(page); const frame = await login(page, app);
    await frame.evaluate(() => {
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      window.historyURLs = new Set();
      URL.createObjectURL = blob => { const url = create(blob); window.historyURLs.add(url); return url; };
      URL.revokeObjectURL = url => { window.historyURLs.delete(url); revoke(url); };
    });
    await frame.locator('#history-up').click();
    const archive = frame.locator('#history-archive'); await expect(archive).toContainText('DOWNLOAD-12499', { timeout: 20000 });
    expect(await archive.textContent()).toBe(expected.toString()); expect(expected.length).toBeGreaterThan(65536);
    await expect(frame.locator('#history-state')).toContainText('1 MiB');
    const reads = app.terminalHistoryReads.length; await frame.locator('#history-tools-toggle').click();
    for (let index = 0; index < 2; index++) {
      const pending = page.waitForEvent('download'); await page.locator('#history-download').click(); const download = await pending;
      expect(download.suggestedFilename()).toBe('codex-terminal-history.txt');
      expect(await readFile(await download.path(), 'utf8')).toBe(expected.toString());
      expect(await frame.evaluate(() => window.historyURLs.size)).toBe(1);
    }
    await frame.locator('#history-latest').click(); expect(app.terminalHistoryReads.length).toBe(reads);
    expect(await frame.evaluate(() => window.historyURLs.size)).toBe(0);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('local history tools include more than 2200 loaded rows without fetching remote history', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app, 6000); await frame.evaluate(() => window.historyTerminal.scrollToTop());
    await frame.locator('#history-tools-toggle').click(); const archive = frame.locator('#history-archive');
    await expect(archive).toContainText('LOCAL-HISTORY-0000'); await expect(archive).toContainText('LOCAL-HISTORY-5999');
    expect(Buffer.byteLength(await archive.textContent())).toBeGreaterThan(65536);
    expect(app.terminalHistoryReads).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('reconnect and cached page restoration keep the same renderer, history and reading position without replay', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app); await wheel(frame, -360); await reviewing(frame); const before = await buffer(frame);
    app.disconnectTerminals(); await expect.poll(() => app.terminalConnections).toBe(2); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1); expect((await buffer(frame)).first).toBe(before.first); expect((await buffer(frame)).all).toContain('LOCAL-HISTORY-0000');
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => app.terminalConnections).toBe(3); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1); expect((await buffer(frame)).first).toBe(before.first); expect(app.terminalInputs).toEqual([]);
    await frame.locator('#history-latest').click(); await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
  } finally { await app.close(); }
});

test('program paging is opt-in, rate bounded and never adds Enter; returning live only changes the local view', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await seeded(page, app); await wheel(frame, -200); await reviewing(frame); expect(app.terminalInputs).toEqual([]);
    await frame.locator('#history-program').click(); await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); await frame.locator('#history-up').click();
    await expect.poll(() => app.terminalInputs.length).toBe(1); expect(app.terminalInputs[0].text).toBe('\x1b[5~');
    await frame.evaluate(() => { for (let i = 0; i < 20; i++) document.getElementById('terminal').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); });
    expect(app.terminalInputs.length).toBeLessThanOrEqual(2);
    await page.waitForTimeout(200); await frame.locator('#history-down').click(); await expect.poll(() => app.terminalInputs.at(-1).text).toBe('\x1b[6~');
    await page.locator('#desktop-mode').click(); await expect(frame.locator('#history-up')).toBeDisabled(); const before = app.terminalInputs.length;
    await wheel(frame, -200); expect(app.terminalInputs.length).toBe(before); await page.locator('#cancel-confirmation').click();
    await frame.locator('#history-latest').click(); await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'false');
    expect(app.terminalInputs.length).toBe(before); expect(app.terminalInputs.every(value => ['\x1b[5~', '\x1b[6~'].includes(value.text))).toBe(true);
  } finally { await app.close(); }
});

test('single finger history scrolling is local and controls fit a narrow screen with touch targets', async ({ page }, info) => {
  const app = await fixture();
  try {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
    const frame = await seeded(page, app);
    await frame.evaluate(() => {
      const host = document.getElementById('terminal'), touch = y => new Touch({ identifier: 1, target: host, clientX: 120, clientY: y });
      host.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
      host.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(270)], bubbles: true, cancelable: true }));
      host.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    });
    await reviewing(frame); expect(app.terminalInputs).toEqual([]);
    for (const id of ['history-program', 'history-up', 'history-down', 'history-latest']) {
      const box = await frame.locator('#' + id).boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await frame.locator('#history-latest').click(); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('reading history postpones automatic direct promotion, then the route changes without discarding the buffer', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let offers = 0;
  try {
    await page.clock.install(); await page.route('**/api/terminal/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
    const frame = await seeded(page, app); await wheel(frame, -320); await reviewing(frame);
    await page.clock.fastForward(16000); await page.waitForTimeout(100); expect(offers).toBe(1); expect(app.terminalConnections).toBe(1);
    await frame.locator('#history-latest').click(); await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(2); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1); expect((await buffer(frame)).all).toContain('LOCAL-HISTORY-0000'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('switching target discards the previous terminal buffer and history mode', async ({ page }) => {
  const app = await fixture();
  try {
    await app.controls.manageTerminals({ action: 'create', name: '另一个任务', view: 'terminal' }); const frame = await seeded(page, app);
    await wheel(frame, -300); await reviewing(frame); output(app, 'NEW-BEFORE-TARGET-SWITCH\r\n'); await expect(frame.locator('#history-new-output')).toBeVisible();
    await openTools(page); await page.locator('#terminal-view-select').selectOption('aux1');
    await expect(page.locator('#connection-status')).toContainText('终端在线'); const next = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    expect((await buffer(next)).all).not.toContain('LOCAL-HISTORY'); await expect(next.locator('#terminal')).toHaveAttribute('data-reviewing', 'false');
    await expect(next.locator('#history-new-output')).toBeHidden();
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('tmux history is fetched only at the local edge, in bounded pages over the existing direct channel', async ({ page }) => {
  const text = lines(1200, 'REMOTE-SNAPSHOT') + 'SNAPSHOT-END', app = await fixture({ webrtc: true, terminalHistory: text });
  try {
    const frame = await seeded(page, app); expect(app.terminalHistoryReads).toEqual([]);
    await frame.evaluate(() => window.historyTerminal.scrollToTop()); expect(app.terminalHistoryReads).toEqual([]);
    await wheel(frame, -120); await expect(frame.locator('#history-archive')).toBeVisible();
    await expect(frame.locator('#history-archive')).toHaveText(text); expect((await frame.locator('#history-archive').textContent()).includes('\ufffd')).toBe(false);
    expect(app.terminalHistoryReads.length).toBe(Math.ceil(Buffer.byteLength(text) / 8192)); expect(app.terminalHistoryReads.length).toBeLessThanOrEqual(8);
    const before = await frame.locator('#history-archive').evaluate(element => { element.scrollTop = 25; return element.scrollTop; });
    output(app, lines(30, 'LIVE-AFTER-SNAPSHOT')); await expect.poll(async () => (await buffer(frame)).all.includes('LIVE-AFTER-SNAPSHOT-0029')).toBe(true);
    expect(await frame.locator('#history-archive').evaluate(element => element.scrollTop)).toBe(before);
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled(); await frame.locator('#history-latest').click();
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalConnections).toBe(1);
  } finally { await app.close(); }
});

test('returning live cancels a snapshot without resending it and late replies cannot disrupt new input', async ({ page }) => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ terminalHistory: lines(600, 'CANCELLED-SNAPSHOT'), terminalHistoryHook: async () => { entered(); await hold; } });
  try {
    const frame = await seeded(page, app); await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -100); await started;
    await expect(frame.locator('#history-state')).toContainText('补取'); await frame.locator('#history-latest').click();
    await page.locator('#toggle-input-button').click(); await expect(page.locator('[data-key="Enter"]')).toBeEnabled(); await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success'); release(); await page.waitForTimeout(200);
    await expect(frame.locator('#history-archive')).toBeHidden(); expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalConnections).toBe(1);
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\r' }]);
  } finally { release(); await app.close(); }
});

test('real isolated tmux and Python PTY retain ordinary output across reconnect and page a full-screen receiver without replay', async ({ page }, info) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'codex-browser-history-')), socket = join(directory, 'tmux.sock'), clients = [];
  const proof = join(directory, 'once'), tui = join(directory, 'tui.py'), tuiReady = join(directory, 'ready'), keys = join(directory, 'keys');
  const env = { ...process.env, HOME: directory, HISTFILE: '/dev/null', TERM: 'xterm-256color', DEPLOY_MODE: 'terminal',
    PATH: `${resolve('data/host-tools/usr/bin')}:${process.env.PATH}`, HISTORY_TEST_PROOF: proof, HISTORY_TEST_TUI: tui };
  delete env.TMUX; delete env.DISPLAY; delete env.XAUTHORITY;
  const exec = promisify(execFile), run = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 8192 });
  let app, readyConnections = 0;
  page.on('websocket', ws => {
    if (new URL(ws.url()).pathname !== '/terminal/connect') return;
    ws.on('framereceived', ({ payload }) => {
      try { if (JSON.parse(payload).type === 'ready') readyConnections++; } catch {}
    });
  });
  try {
    await exec('tmux', ['-f', resolve('desktop/tmux.conf'), '-S', socket, 'new-session', '-d', '-s', 'codex', '-x', '80', '-y', '24', 'bash --noprofile --norc'], { env, timeout: 3000 });
    const token = (await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim();
    app = await fixture();
    // The manager remains mocked; the real terminal-only helper must not need X11.
    app.config.terminalLaunch = () => {
      const child = spawn('python3', [resolve('desktop/web-terminal.py'), socket, 'main', token, '--geometry'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      clients.push(child); return child;
    };
    await prepare(page); const frame = await login(page, app); await page.locator('#toggle-input-button').click();
    await openInput(page); await page.locator('#mobile-input').fill('printf \'once\\n\' >> "$HISTORY_TEST_PROOF"; printf \'NATIVE-HISTORY-%04d\\n\' {1..220}');
    await openInput(page); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await expect(readFile(proof, 'utf8')).rejects.toThrow();
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(async () => (await buffer(frame)).all.includes('NATIVE-HISTORY-0220')).toBe(true);
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(await readFile(proof, 'utf8')).toBe('once\n');
    await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -400); await expect(frame.locator('#history-archive')).toBeVisible();
    await expect(frame.locator('#history-archive')).toContainText('NATIVE-HISTORY-0001'); const before = await frame.locator('#history-archive').textContent();
    clients[0].kill('SIGTERM'); await expect.poll(() => clients.length).toBe(2);
    await expect.poll(() => readyConnections).toBe(2);
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1); expect(await frame.locator('#history-archive').textContent()).toBe(before);
    expect((await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim()).toBe(token); expect(await readFile(proof, 'utf8')).toBe('once\n');
    // Trailing spaces deliberately share the style run with the marker.
    await frame.locator('#history-latest').click(); await openInput(page); await page.locator('#mobile-input').fill("printf '\\033[1;31mNATIVE-STYLED-中文  \\033[0m\\n'");
    await openInput(page); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success'); await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect.poll(() => frame.evaluate(() => {
      const buffer = window.historyTerminal.buffer.active;
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (line.translateToString(true).trim() === 'NATIVE-STYLED-中文' && line.getCell(0).isBold()) return true;
      }
      return false;
    })).toBe(true);
    await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -120);
    const nativeArchive = frame.locator('#history-archive');
    try {
      await expect(nativeArchive).toBeVisible();
      await expect(nativeArchive).toContainText('NATIVE-STYLED-中文');
      // tmux may retain row padding/newlines in a style run. Check every
      // character of the actual output instead of assuming one exact span.
      const styled = await nativeArchive.evaluate(element => {
        const needle = 'NATIVE-STYLED-中文', text = element.textContent, start = text.lastIndexOf(needle);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), styles = [];
        let node, offset = 0, covered = 0;
        while ((node = walker.nextNode())) {
          const end = offset + node.textContent.length, overlap = Math.max(0, Math.min(end, start + needle.length) - Math.max(offset, start));
          if (start >= 0 && overlap) { const css = getComputedStyle(node.parentElement); styles.push({ color: css.color, weight: css.fontWeight }); covered += overlap; }
          offset = end;
        }
        return { text: start < 0 ? '' : text.slice(start, start + needle.length), covered, styles };
      });
      expect(styled.text).toBe('NATIVE-STYLED-中文'); expect(styled.covered).toBe(styled.text.length);
      expect(styled.styles.length).toBeGreaterThan(0);
      expect(styled.styles.every(style => style.color === 'rgb(239, 41, 41)' && style.weight === '700')).toBe(true);
      expect(readyConnections).toBe(2);
    } catch (error) {
      const state = await frame.evaluate(() => ({ history: document.getElementById('history-state')?.textContent,
        text: document.getElementById('history-archive')?.textContent?.slice(-65536),
        runs: [...document.querySelectorAll('#history-archive span')].slice(-256).map(span => ({ text: span.textContent.slice(0, 256), style: span.getAttribute('style') })) })).catch(() => ({ frameUnavailable: true }));
      const pane = (await exec('tmux', ['-S', socket, 'capture-pane', '-e', '-p', '-t', token.split(':', 1)[0], '-S', '-80'], { env, timeout: 3000, maxBuffer: 65536 }).catch(() => ({ stdout: '' }))).stdout;
      await info.attach('native-history-diagnostics', { body: Buffer.from(JSON.stringify({ readyConnections, clients: clients.map(child => ({ exitCode: child.exitCode, signal: child.signalCode })), state, pane })), contentType: 'application/json' });
      throw error;
    }
    await writeFile(tui, `import os, select, termios, time, tty\nfd=0\nprevious=termios.tcgetattr(fd)\ndata=b''\ntry:\n tty.setraw(fd)\n os.write(1,b'\\x1b[?1049h\\x1b[2J\\x1b[HFULL-SCREEN-RECEIVER\\r\\n')\n with open(${JSON.stringify(tuiReady)},'w') as f: f.write('ready')\n deadline=time.monotonic()+12\n while len(data)<8 and time.monotonic()<deadline:\n  if select.select([fd],[],[],0.1)[0]: data+=os.read(fd,8-len(data))\nfinally:\n termios.tcsetattr(fd,termios.TCSANOW,previous)\n os.write(1,b'\\x1b[?1049l')\n with open(${JSON.stringify(keys)},'w') as f: f.write(data.hex())\n`);
    await frame.locator('#history-latest').click(); await openInput(page); await page.locator('#mobile-input').fill('python3 "$HISTORY_TEST_TUI"'); await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success'); await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect.poll(() => readFile(tuiReady, 'utf8').catch(() => '')).toBe('ready');
    await frame.locator('#history-program').click(); await frame.locator('#history-up').click(); await page.waitForTimeout(200); await frame.locator('#history-down').click();
    await expect.poll(() => readFile(keys, 'utf8').catch(() => '')).toBe('1b5b357e1b5b367e');
    expect(await readFile(proof, 'utf8')).toBe('once\n');
    await frame.locator('#history-latest').click(); await openInput(page); await page.locator('#mobile-input').fill('for i in {1..1000}; do printf \'\\033[1;31mLARGE-HISTORY-%04d %080d\\033[0m\\n\' "$i" 0; done');
    await openInput(page); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success'); await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect.poll(async () => (await buffer(frame)).all.includes('LARGE-HISTORY-1000')).toBe(true);
    // Explicit snapshot requests are limited to one per second.
    await page.waitForTimeout(1100);
    await frame.evaluate(() => window.historyTerminal.scrollToTop()); await wheel(frame, -100);
    await expect(frame.locator('#history-archive')).toBeVisible(); await expect(frame.locator('#history-archive')).toContainText('LARGE-HISTORY-1000');
    const clippedStyle = frame.locator('#history-archive span').filter({ hasText: 'LARGE-HISTORY-1000' });
    expect(await clippedStyle.evaluate(element => getComputedStyle(element).color)).toBe('rgb(239, 41, 41)');
    expect(await frame.locator('#history-archive').textContent()).not.toContain('\x1b');
    expect(Buffer.byteLength(await frame.locator('#history-archive').textContent())).toBeLessThanOrEqual(1048576);
    const complete = await exec('tmux', ['-S', socket, 'capture-pane', '-e', '-p', '-t', token.split(':', 1)[0], '-S', '-10000'], { env, timeout: 3000, maxBuffer: 32 * 1024 * 1024 });
    if (Buffer.byteLength(complete.stdout) > 1048576) await expect(frame.locator('#history-state')).toContainText('1 MiB');
    else await expect(frame.locator('#history-state')).not.toContainText('截取');
    expect(await readFile(proof, 'utf8')).toBe('once\n');
  } finally {
    await app?.close(); for (const child of clients) if (child.exitCode === null) child.kill('SIGTERM');
    await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
