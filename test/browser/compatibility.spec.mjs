import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

const historyText = Array.from({ length: 180 }, (_, n) => `ROW-${n} 中文与空格    code();\n`).join('');
async function prepare(page, terminal = false) {
  await page.addInitScript(terminal => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, mode: terminal ? 'terminal' : 'desktop', collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let TerminalClass;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => TerminalClass, set: Native => {
      TerminalClass = class extends Native { constructor(...args) { super(...args); window.compatTerminal = this; } };
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { (window.compatCopies ||= []).push(text); } } });
  }, terminal);
}
async function login(page, app, terminal = false) {
  await prepare(page, terminal); await page.goto(app.config.origin);
  await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText(terminal ? '终端在线' : '桌面在线');
  return page.frames().find(frame => frame.url().includes(terminal ? '/terminal/index.html' : '/desktop/index.html'));
}
const dimensions = frame => frame.evaluate(() => ({ rows: window.compatTerminal.rows, cols: window.compatTerminal.cols, height: document.getElementById('terminal').clientHeight }));
async function reachable(locator, viewport) {
  const rect = await locator.boundingBox(); expect(rect).not.toBeNull();
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1); expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await locator.evaluate(el => { const r = el.getBoundingClientRect(); return el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; })).toBe(true);
}

test('controls and drafts remain usable in portrait, landscape and tablet layouts without a remote resize', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1600, height: 3200 } });
  try {
    await login(page, app);
    for (const viewport of [{ width: 320, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 1366 }, { width: 1366, height: 1024 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('旋转窗口后仍然保留的中文草稿');
      await reachable(page.locator('#paste-button'), viewport); await reachable(page.locator('#close-input-button'), viewport);
      await page.locator('#close-input-button').click(); await page.locator('#toggle-controls-button').click();
      await reachable(page.locator('#close-controls-button'), viewport); await page.locator('#close-controls-button').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.locator('#toggle-input-button').click(); await expect(page.locator('#mobile-input')).toHaveValue('旋转窗口后仍然保留的中文草稿');
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.viewportResizes).toBe(0);
  } finally { await app.close(); }
});

test('Chinese composition stays local until paste, and Enter is a separate deliberate action', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await page.locator('#toggle-input-button').click(); const field = page.locator('#mobile-input');
    await field.fill('中文组合\n第二行'); await field.dispatchEvent('compositionstart', { data: '中文' });
    await expect(page.locator('#paste-button')).toBeDisabled(); await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true }); expect(app.inputCalls).toEqual([]);
    await field.dispatchEvent('compositionend', { data: '中文' }); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toEqual([{ action: 'paste', text: '中文组合\n第二行', target: 'terminal' }]);
    await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.inputCalls.length).toBe(2);
    expect(app.inputCalls[1]).toEqual({ action: 'key', key: 'Enter' });
  } finally { await app.close(); }
});

test('a reduced visual viewport keeps the input actions visible without losing the draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    if (window !== parent) return;
    const viewport = new EventTarget(); let height; viewport.offsetTop = 0;
    Object.defineProperty(viewport, 'height', { get: () => height ?? innerHeight, set: value => { height = value; } });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('软键盘模拟期间保留');
    await page.evaluate(() => { visualViewport.height = 320; visualViewport.dispatchEvent(new Event('resize')); });
    await expect(page.locator('html')).toHaveClass(/workspace-keyboard-open/);
    await reachable(page.locator('#paste-button'), { width: 390, height: 320 }); await reachable(page.locator('[data-key="Enter"]'), { width: 390, height: 320 });
    await expect(page.locator('#mobile-input')).toHaveValue('软键盘模拟期间保留'); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('Shift with left and right arrows can be sent from the shortcut menu in both modes without Enter', async ({ context }) => {
  for (const terminal of [false, true]) {
    const app = await fixture({ rfb: true }), page = await context.newPage();
    try {
      await login(page, app, terminal); await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('只保留草稿');
      for (const key of ['Shift+ArrowLeft', 'Shift+ArrowRight']) {
        await page.locator('#shortcuts-button').click(); await page.locator(`[data-shortcut="${key}"]`).click();
        await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
      }
      if (terminal) expect(app.terminalInputs.map(value => value.text)).toEqual(['\x1b[1;2D', '\x1b[1;2C']);
      else expect(app.inputCalls).toEqual([{ action: 'key', key: 'Shift+ArrowLeft' }, { action: 'key', key: 'Shift+ArrowRight' }]);
      await expect(page.locator('#mobile-input')).toHaveValue('只保留草稿');
    } finally { await page.close(); await app.close(); }
  }
});

test('history selection, search and composition keep the text area and terminal dimensions unchanged', async ({ page }) => {
  const app = await fixture({ terminalHistory: historyText });
  try {
    const frame = await login(page, app, true); await frame.locator('#history-up').click(); const archive = frame.locator('#history-archive');
    await expect(archive).toBeVisible(); const before = await archive.boundingBox(), size = await dimensions(frame), position = await archive.evaluate(el => el.scrollTop);
    await frame.locator('#history-tools-toggle').click(); await expect(page.locator('#history-tools')).toBeFocused();
    expect(await archive.boundingBox()).toEqual(before); expect(await dimensions(frame)).toEqual(size); expect(await archive.evaluate(el => el.scrollTop)).toBe(position);
    const query = page.locator('#history-query'); await query.dispatchEvent('compositionstart'); await query.fill('中文');
    await query.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true }); await expect(page.locator('#history-tools')).toBeVisible();
    await query.dispatchEvent('compositionend'); await expect(page.locator('#history-find-state')).toContainText('1/180');
    await query.press('Enter'); await expect(page.locator('#history-find-state')).toContainText('2/180');
    const selected = await frame.evaluate(() => { const pre = document.getElementById('history-archive'), range = document.createRange(); range.selectNodeContents(pre); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
    await page.locator('#history-copy-selection').click(); await expect(page.locator('#history-find-state')).toContainText('已复制选区');
    expect(selected).toContain('ROW-179'); expect(await frame.evaluate(() => window.compatCopies)).toEqual([selected]); expect(app.terminalInputs).toEqual([]);
    await page.locator('#history-tools-close').click(); await expect(frame.locator('#history-tools-toggle')).toBeFocused();
    await archive.press('Control+f'); await expect(page.locator('#history-query')).toBeFocused();
    await page.locator('#history-query').press('Escape'); await expect(frame.locator('#history-tools-toggle')).toBeFocused();
  } finally { await app.close(); }
});

test('manual copy stays large, readonly and usable through rotation, with explicit copy feedback and close cleanup', async ({ page }, info) => {
  const app = await fixture({ terminalHistory: historyText });
  try {
    const frame = await login(page, app, true);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.evaluate(() => { document.execCommand = () => false; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.compatCopied = text; } } }); });
    await frame.locator('#history-up').click(); await frame.locator('#history-tools-toggle').click(); await page.locator('#history-copy-all').click();
    const field = page.locator('#history-copy-text'); await expect(field).toHaveValue(historyText); await expect(field).toBeFocused();
    expect(await field.evaluate(el => ({ readonly: el.readOnly, selected: el.selectionEnd - el.selectionStart }))).toEqual({ readonly: true, selected: historyText.length });
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 1366 }]) {
      await page.setViewportSize(viewport); await expect.poll(async () => (await field.boundingBox()).height).toBeGreaterThan(100);
      await reachable(page.locator('#history-copy-retry'), viewport); await reachable(page.locator('#history-copy-dismiss'), viewport);
    }
    await page.locator('#history-copy-retry').click(); await expect(page.locator('#history-copy-result')).toContainText('已复制到本机');
    expect(await page.evaluate(() => window.compatCopied)).toBe(historyText);
    await page.screenshot({ path: `test-results/compatibility/${info.project.name}-copy.png` });
    await page.locator('#history-copy-dismiss').click(); await expect(field).toBeHidden(); await expect(field).toHaveValue(''); await expect(page.locator('#history-tools')).toBeVisible();
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('fullscreen either works with reachable controls or offers a usable fallback', async ({ page }) => {
  const app = await fixture({ terminalHistory: historyText });
  try {
    const frame = await login(page, app, true); await page.locator('#toggle-controls-button').click();
    const supported = await page.evaluate(() => !!document.getElementById('desktop-card').requestFullscreen);
    await page.locator('#tools-fullscreen-button').click();
    if (supported) {
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('desktop-card');
      await frame.locator('#history-up').click(); await frame.locator('#history-tools-toggle').click();
      await reachable(page.locator('#history-tools-close'), page.viewportSize());
      const panel = await page.locator('#history-tools').boundingBox(), up = await frame.locator('#history-up').boundingBox(); expect(panel.y + panel.height).toBeLessThanOrEqual(up.y);
      await page.evaluate(() => document.exitFullscreen());
    } else {
      await expect(page.locator('#toast')).toContainText('不支持');
      await frame.locator('#history-tools-toggle').click(); await reachable(page.locator('#history-tools-close'), page.viewportSize());
    }
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
