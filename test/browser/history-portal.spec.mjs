import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    if (window === parent) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
      const viewport = new EventTarget(); viewport.height = innerHeight; viewport.offsetTop = 0;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    }
    if (location.pathname !== '/terminal/index.html') return;
    let wrapped; window.portalTerminalCount = 0;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => wrapped, set: Native => { wrapped = class extends Native { constructor(...args) { super(...args); window.portalTerminal = this; window.portalTerminalCount++; } }; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { (window.portalCopies ||= []).push(text); } } });
  });
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, terminalHistory: Array.from({ length: 200 }, (_, n) => `ROW-${n} 中文\n`).join('') });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  const frame = page.frames().find(f => f.url().includes('/terminal/index.html'));
  await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible();
  return { app, frame };
}
const dimensions = frame => frame.evaluate(() => ({ rows: window.portalTerminal.rows, cols: window.portalTerminal.cols, height: document.getElementById('terminal').clientHeight }));
async function exposed(page, frame) {
  const panel = await page.locator('#history-tools').boundingBox();
  for (const id of ['history-up', 'history-down', 'history-latest']) {
    const button = await frame.locator('#' + id).boundingBox(); expect(panel.y + panel.height).toBeLessThanOrEqual(button.y);
  }
  const close = page.locator('#history-tools-close');
  expect(await close.evaluate(el => { const r = el.getBoundingClientRect(); return el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; })).toBe(true);
}

test('phone find uses the page header and keeps history controls, text geometry, scroll and selection available', async ({ page }, info) => {
  const { app, frame } = await setup(page);
  try {
    const archive = frame.locator('#history-archive'); await archive.evaluate(el => { el.scrollTop = 120; });
    const before = await archive.boundingBox(), size = await dimensions(frame), position = await archive.evaluate(el => el.scrollTop);
    await frame.locator('#history-tools-toggle').click(); await expect(page.locator('#history-tools')).toBeVisible();
    await exposed(page, frame); expect(await archive.boundingBox()).toEqual(before); expect(await dimensions(frame)).toEqual(size); expect(await archive.evaluate(el => el.scrollTop)).toBe(position);
    await expect(page.locator('#history-tools')).toBeFocused();
    await frame.locator('#history-up').click(); await expect.poll(() => archive.evaluate(el => el.scrollTop)).toBeLessThan(position);
    await frame.locator('#history-down').click(); await expect.poll(() => archive.evaluate(el => el.scrollTop)).toBe(position);
    await page.locator('#history-query').fill('ROW-12'); await expect(page.locator('#history-find-state')).toContainText('1/11');
    await frame.evaluate(() => { const pre = document.getElementById('history-archive'), range = document.createRange(); range.selectNodeContents(pre); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
    await page.locator('#history-copy-selection').click(); await expect(page.locator('#history-find-state')).toContainText('已复制选区');
    expect((await frame.evaluate(() => window.portalCopies)).length).toBe(1);
    await exposed(page, frame); await page.screenshot({ path: `test-results/${info.project.name}-history-header.png` });
    await frame.locator('#history-latest').click(); await expect(page.locator('#history-tools')).toHaveCount(0); await expect(archive).toBeHidden();
    expect(app.terminalInputs).toEqual([]); expect(app.terminalConnections).toBe(1); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('phone search keyboard and composition do not resize the terminal or send Enter; close stays reachable in a short header', async ({ page }) => {
  const { app, frame } = await setup(page);
  try {
    const size = await dimensions(frame); await frame.locator('#history-tools-toggle').click(); const query = page.locator('#history-query'); await query.focus();
    await page.evaluate(() => { visualViewport.height = 320; visualViewport.offsetTop = 20; visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); });
    await expect(page.locator('#history-tools')).toHaveClass(/history-tools-short/); await exposed(page, frame); expect(await dimensions(frame)).toEqual(size);
    await query.dispatchEvent('compositionstart'); await query.fill('中文'); await query.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
    await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#desktop-mode')).toBeDisabled();
    await query.dispatchEvent('compositionend'); await expect(page.locator('#history-find-state')).toContainText('1/200');
    await query.press('Enter'); await expect(page.locator('#history-find-state')).toContainText('2/200'); expect(app.terminalInputs).toEqual([]);
    await page.locator('#history-tools-close').click(); await expect(page.locator('#history-tools')).toHaveCount(0); await expect(frame.locator('#history-tools-toggle')).toBeFocused();
    expect(await dimensions(frame)).toEqual(size); expect(app.terminalConnections).toBe(1);
  } finally { await app.close(); }
});

test('full screen, orientation and desktop restoration retain one search panel and keep close outside its scrolling content', async ({ page }) => {
  const { app, frame } = await setup(page);
  try {
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-query').fill('ROW-12');
    await page.locator('#history-query').click(); await page.evaluate(() => document.getElementById('desktop-card').requestFullscreen());
    await expect(page.locator('#history-tools')).toHaveClass(/history-tools-short/); await exposed(page, frame);
    await page.locator('#history-copy-all').click(); await expect(page.locator('#history-find-state')).toContainText('已复制当前快照'); await exposed(page, frame);
    await page.evaluate(() => document.exitFullscreen());
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.locator('#history-tools')).toHaveCount(0); await expect(frame.locator('#history-tools')).toBeVisible(); await expect(frame.locator('#history-query')).toHaveValue('ROW-12');
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#history-query')).toHaveValue('ROW-12'); await exposed(page, frame);
    await page.locator('#history-query').press('Escape'); await expect(page.locator('#history-tools')).toHaveCount(0); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('takeover removes a portaled panel and a late clipboard result or stale frame request cannot restore it', async ({ page }) => {
  const { app, frame } = await setup(page);
  try {
    await frame.locator('#history-tools-toggle').click();
    const oldEpoch = new URL(await page.locator('#desktop-frame').getAttribute('src'), app.config.origin).searchParams.get('frame');
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_resolve, reject) => { parent.rejectPortalCopy = () => reject(new Error('denied')); }) } }));
    await page.locator('#history-copy-all').click(); await expect(page.locator('#history-copy-all')).toBeDisabled();
    expect(await page.evaluate(async () => {
      const { csrf } = await (await fetch('/api/me')).json();
      return (await fetch('/api/desktop/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ viewer: 'e'.repeat(32) }) })).status;
    })).toBe(200);
    await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 }); await expect(page.locator('#history-tools')).toHaveCount(0);
    await page.evaluate(frame => { window.rejectPortalCopy(); document.getElementById('desktop-frame').dispatchEvent(new CustomEvent('codex-history-tools', { detail: { frame, open: true, composing: false } })); }, oldEpoch);
    await page.waitForTimeout(100); await expect(page.locator('#history-tools')).toHaveCount(0); expect(await page.evaluate(() => document.activeElement.id)).not.toBe('history-copy-text');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
