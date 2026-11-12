import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.scrollTerminal = this; } }; } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
const lines = count => Array.from({ length: count }, (_, index) => `HISTORY-${String(index).padStart(4, '0')}`).join('\n');
const metrics = frame => frame.evaluate(() => {
  const pre = document.getElementById('history-archive'), host = document.getElementById('terminal');
  return { viewport: host.clientHeight, line: parseFloat(getComputedStyle(pre).lineHeight), top: pre.scrollTop, height: pre.clientHeight, total: pre.scrollHeight };
});

test('a compact history opens near the latest rows and buttons move a few lines instead of jumping to its top', async ({ page }) => {
  let text = ''; const app = await fixture({ terminalHistory: () => text });
  try {
    const frame = await login(page, app), initial = await metrics(frame);
    text = lines(Math.ceil(initial.viewport / initial.line * 1.5));
    await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    const opened = await metrics(frame);
    expect(opened.total - opened.height).toBeGreaterThan(opened.line * 3); expect(opened.top).toBeGreaterThan(0);
    expect(opened.total - opened.height - opened.top).toBeLessThanOrEqual(opened.line * 3 + 1);
    await frame.locator('#history-up').click(); const older = await metrics(frame);
    expect(older.top).toBeCloseTo(Math.max(0, opened.top - opened.line * 3), 0);
    await frame.locator('#history-down').click(); expect((await metrics(frame)).top).toBeCloseTo(opened.top, 0);
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('long snapshots and the native buffer use small button steps while keyboard PageUp keeps full-page navigation', async ({ page }) => {
  const app = await fixture({ terminalHistory: lines(300) });
  try {
    const frame = await login(page, app); await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    const opened = await metrics(frame); await frame.locator('#history-up').click(); const next = await metrics(frame);
    expect(next.top).toBeCloseTo(opened.top - opened.line * 3, 0); expect(next.top).toBeGreaterThan(0);
    await frame.locator('#history-archive').press('PageUp'); const paged = await metrics(frame);
    expect(next.top - paged.top).toBeGreaterThan(opened.line * 3);
    await frame.locator('#history-latest').click();
    app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(lines(160).replaceAll('\n', '\r\n') + '\r\n').toString('base64') }) + '\n');
    await expect.poll(() => frame.evaluate(() => window.scrollTerminal.buffer.active.baseY)).toBeGreaterThan(20);
    const base = await frame.evaluate(() => window.scrollTerminal.buffer.active.baseY);
    await frame.locator('#history-up').click(); expect(await frame.evaluate(() => window.scrollTerminal.buffer.active.viewportY)).toBe(base - 3);
    await frame.locator('#history-down').click(); expect(await frame.evaluate(() => window.scrollTerminal.buffer.active.viewportY)).toBe(base);
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('the first upward gesture opens a snapshot by the gesture distance without jumping a page', async ({ page }, info) => {
  let text = ''; const app = await fixture({ terminalHistory: () => text });
  try {
    const frame = await login(page, app), initial = await metrics(frame);
    text = lines(Math.ceil(initial.viewport / initial.line * 1.5));
    await frame.evaluate(({ line, touch }) => {
      const host = document.getElementById('terminal');
      if (!touch) { host.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, deltaMode: 1, bubbles: true, cancelable: true })); return; }
      const finger = y => new Touch({ identifier: 1, target: host, clientX: 100, clientY: y });
      host.dispatchEvent(new TouchEvent('touchstart', { touches: [finger(100)], bubbles: true }));
      host.dispatchEvent(new TouchEvent('touchmove', { touches: [finger(100 + line * 2)], bubbles: true, cancelable: true }));
      host.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    }, { line: initial.line, touch: info.project.name === 'mobile' });
    await expect(frame.locator('#history-archive')).toBeVisible(); const opened = await metrics(frame);
    expect(opened.top).toBeGreaterThan(0);
    expect(opened.total - opened.height - opened.top).toBeGreaterThanOrEqual(opened.line - 1);
    expect(opened.total - opened.height - opened.top).toBeLessThanOrEqual(opened.line * 2 + 1);
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a full-screen snapshot explains its limited scope and never pages the program until explicitly enabled', async ({ page }) => {
  let text = ''; const app = await fixture({ terminalHistory: () => text, terminalHistoryAlternate: true });
  try {
    const frame = await login(page, app), initial = await metrics(frame); text = lines(Math.max(1, Math.floor(initial.viewport / initial.line) - 2));
    await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
    await expect(frame.locator('#history-state')).toContainText('当前画面快照'); await expect(frame.locator('#history-state')).toContainText('程序翻页');
    await expect(frame.locator('#history-up')).toBeDisabled(); await expect(frame.locator('#history-down')).toBeDisabled();
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'false'); expect(app.terminalInputs).toEqual([]);
    await frame.locator('#history-program').click(); await frame.locator('#history-up').click();
    await expect.poll(() => app.terminalInputs.length).toBe(1); expect(app.terminalInputs[0].text).toBe('\x1b[5~');
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
