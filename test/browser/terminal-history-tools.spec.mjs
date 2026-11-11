import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function prepare(page) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal; window.terminalInstances = 0;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.toolsTerminal = this; window.terminalInstances++; } }; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { (window.copiedHistory ||= []).push(text); } } });
  });
}
async function login(page, app) {
  await prepare(page); await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
function output(app, text) {
  const bytes = Buffer.from(text), child = app.terminalChildren.at(-1);
  for (let index = 0; index < bytes.length; index += 8192) child.stdout.write(JSON.stringify({ type: 'output', data: bytes.subarray(index, index + 8192).toString('base64') }) + '\n');
}
async function snapshot(page, app) {
  const frame = await login(page, app); await frame.locator('#history-up').click(); await expect(frame.locator('#history-archive')).toBeVisible(); return frame;
}
const size = frame => frame.evaluate(() => ({ rows: window.toolsTerminal.rows, cols: window.toolsTerminal.cols, height: document.getElementById('terminal').clientHeight }));
async function select(frame, text) {
  return frame.evaluate(text => {
    const pre = document.getElementById('history-archive'), walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT), start = pre.textContent.indexOf(text);
    const range = document.createRange(); let node, offset = 0, began = false;
    while ((node = walker.nextNode())) {
      if (!began && start < offset + node.length) { range.setStart(node, start - offset); began = true; }
      if (began && start + text.length <= offset + node.length) { range.setEnd(node, start + text.length - offset); break; }
      offset += node.length;
    }
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  }, text);
}

for (const program of [false, true]) test(`find and copy preserve program paging ${program ? 'on' : 'off'} while snapshot keyboard navigation stays local`, async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app);
    output(app, Array.from({ length: 240 }, (_, index) => `PAGING-COPY-${index}\r\n`).join(''));
    await expect.poll(() => frame.evaluate(() => window.toolsTerminal.buffer.active.baseY)).toBeGreaterThan(100);
    if (program) await frame.locator('#history-program').click();
    await frame.locator('#history-tools-toggle').click(); const archive = frame.locator('#history-archive');
    await expect(archive).toBeVisible(); await expect(page.locator('#history-tools')).toBeVisible();
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
    if (program) await expect(frame.locator('#history-state')).toContainText('程序翻页已暂停');
    await page.locator('#history-query').fill('PAGING-COPY-12'); await expect(page.locator('#history-find-state')).toContainText('/11');
    expect(await select(frame, 'PAGING-COPY-120')).toBe('PAGING-COPY-120');
    await page.locator('#history-copy-selection').click(); expect(await frame.evaluate(() => window.copiedHistory)).toEqual(['PAGING-COPY-120']);
    const middle = await archive.evaluate(element => { element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2); return element.scrollTop; });
    await expect(frame.locator('#history-up')).toBeEnabled();
    if (program) await archive.press('PageUp'); else await frame.locator('#history-up').click();
    await expect.poll(() => archive.evaluate(element => element.scrollTop)).toBeLessThan(middle);
    const older = await archive.evaluate(element => element.scrollTop);
    if (program) await archive.press('PageDown'); else await frame.locator('#history-down').click();
    await expect.poll(() => archive.evaluate(element => element.scrollTop)).toBeGreaterThan(older);
    await archive.press('PageUp'); await expect(archive).toBeVisible();
    expect(app.terminalInputs).toEqual([]); expect(app.terminalHistoryReads).toEqual([]);
    await page.locator('#history-tools-close').click(); await expect(page.locator('#history-tools')).toBeHidden(); await expect(archive).toBeVisible();
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
    await frame.locator('#history-latest').click(); await expect(archive).toBeHidden();
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
    if (program) { await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(['\x1b[1;5F']); await frame.locator('#history-up').click(); await expect.poll(() => app.terminalInputs.at(-1)?.text).toBe('\x1b[5~'); }
    else expect(app.terminalInputs).toEqual([]);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('program paging can change during find without closing or sending input from the readonly snapshot', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app); output(app, 'COPY-MODE\r\n'.repeat(240));
    await expect.poll(() => frame.evaluate(() => window.toolsTerminal.buffer.active.baseY)).toBeGreaterThan(100);
    await frame.locator('#history-tools-toggle').click(); const archive = frame.locator('#history-archive');
    const original = await archive.textContent();
    for (const program of [true, false, true]) {
      await frame.locator('#history-program').click();
      await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', String(program));
      await expect(page.locator('#history-tools')).toBeVisible(); await expect(archive).toBeVisible(); await expect(archive).toHaveText(original);
      expect(app.terminalInputs).toEqual([]);
    }
    await page.locator('#history-tools-close').click(); await expect(archive).toBeVisible();
    await archive.press('Escape'); await expect(archive).toBeHidden(); await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
    expect(app.terminalInputs).toEqual([]); expect(app.terminalHistoryReads).toEqual([]);
    await frame.locator('#history-latest').click(); await expect.poll(() => app.terminalInputs.map(value => value.text)).toEqual(['\x1b[1;5F']);
    await expect(frame.locator('#history-program')).toHaveAttribute('aria-pressed', 'true');
  } finally { await app.close(); }
});

test('history search crosses styled runs, navigates literal Unicode matches, and never resizes the terminal or fetches more data', async ({ page }, info) => {
  const source = 'HEAD\n\x1b[31mERR\x1b[0m\x1b[1mOR\x1b[0m 中文😀\nerror 中文\nERROR\n[.*] <img src="/never-search-image">\n' + 'x'.repeat(180) + 'FAR-NEEDLE\n' + 'tail\n'.repeat(50);
  const app = await fixture({ webrtc: true, terminalHistory: source });
  try {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
    const frame = await snapshot(page, app), archive = frame.locator('#history-archive'), original = await archive.textContent(), dimensions = await size(frame), reads = app.terminalHistoryReads.length;
    const position = await archive.evaluate(element => { element.scrollTop = 22; return element.scrollTop; });
    await frame.locator('#history-tools-toggle').click(); await expect(page.locator('#history-tools')).toBeVisible();
    expect(await archive.evaluate(element => element.scrollTop)).toBe(position); expect(await size(frame)).toEqual(dimensions);
    await page.locator('#history-query').fill('error'); await expect(page.locator('#history-find-state')).toContainText('1/3');
    expect(await archive.textContent()).toBe(original);
    const styles = await archive.locator('mark[data-match="0"]').evaluateAll(marks => marks.map(mark => ({ text: mark.textContent, color: getComputedStyle(mark).color, weight: getComputedStyle(mark).fontWeight })));
    expect(styles).toEqual([{ text: 'ERR', color: 'rgb(204, 0, 0)', weight: '400' }, { text: 'OR', color: 'rgb(231, 238, 233)', weight: '700' }]);
    await page.locator('#history-find-next').click(); await expect(page.locator('#history-find-state')).toContainText('2/3');
    await page.locator('#history-query').press('Shift+Enter'); await expect(page.locator('#history-find-state')).toContainText('1/3');
    await page.locator('#history-find-prev').click(); await expect(page.locator('#history-find-state')).toContainText('3/3');
    await page.locator('#history-query').fill('[.*]'); await expect(page.locator('#history-find-state')).toContainText('1/1');
    await page.locator('#history-query').fill('😀'); await expect(page.locator('#history-find-state')).toContainText('1/1');
    await page.locator('#history-query').fill('FAR-NEEDLE'); await expect(page.locator('#history-find-state')).toContainText('1/1');
    await expect(archive.locator('mark[data-current=true]')).toHaveText('FAR-NEEDLE');
    expect(await archive.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await archive.locator('img,script,a').count()).toBe(0); expect(await size(frame)).toEqual(dimensions);
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 500 });
      await expect.poll(async () => { const tools = await page.locator('#history-tools').boundingBox(), pre = await archive.boundingBox(); return tools.y + tools.height <= pre.y + 1; }).toBe(true);
      await frame.locator('#history-tools-toggle').click(); await frame.locator('#history-tools-toggle').click();
      await expect.poll(async () => { const box = await page.locator('#history-query').boundingBox(); return box.y >= 0 && box.y + box.height <= 500; }).toBe(true);
      await page.locator('#history-query').fill('FAR-NEEDLE'); await expect(archive.locator('mark[data-current=true]')).toHaveText('FAR-NEEDLE');
    }
    await page.screenshot({ path: `test-results/${info.project.name}-history-search.png` });
    await page.locator('#history-query').press('Escape'); await expect(page.locator('#history-tools')).toBeHidden();
    expect(await archive.locator('mark').count()).toBe(0); expect(await archive.textContent()).toBe(original);
    expect(app.terminalHistoryReads.length).toBe(reads); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalConnections).toBe(1);
  } finally { await app.close(); }
});

test('clipboard stub receives only the selected plain text or current snapshot, with a readonly manual fallback', async ({ page }) => {
  const app = await fixture({ terminalHistory: '\x1b[31mERR\x1b[0m\x1b[1mOR\x1b[0m 中文\n    code();\n' });
  try {
    const frame = await snapshot(page, app), archive = frame.locator('#history-archive'), original = await archive.textContent();
    await frame.locator('#history-tools-toggle').click(); await expect(page.locator('#history-copy-selection')).toBeDisabled();
    expect((await page.locator('#history-copy-all').boundingBox()).width).toBeGreaterThanOrEqual(128);
    expect(await select(frame, 'ERROR 中文')).toBe('ERROR 中文'); await expect(page.locator('#history-copy-selection')).toBeEnabled();
    await page.locator('#history-copy-selection').click(); await expect(page.locator('#history-copy-state')).toContainText('已复制选区');
    expect(await frame.evaluate(() => window.copiedHistory)).toEqual(['ERROR 中文']);
    await page.locator('#history-copy-all').click(); await expect(page.locator('#history-copy-state')).toContainText('已复制当前快照');
    expect(await frame.evaluate(() => window.copiedHistory)).toEqual(['ERROR 中文', original]);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.locator('#history-copy-all').click(); const field = page.locator('#history-copy-text');
    await expect(field).toBeVisible(); await expect(field).toHaveValue(original);
    await expect(page.locator('#history-copy-manual')).toHaveJSProperty('open', true);
    const area = await field.boundingBox(); expect(area.height).toBeGreaterThanOrEqual(240); expect(area.width).toBeGreaterThanOrEqual(260);
    expect(await field.evaluate(el => { const rect = el.getBoundingClientRect(); return el.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 10) === el; })).toBe(true);
    expect(await field.evaluate(element => ({ readonly: element.readOnly, start: element.selectionStart, end: element.selectionEnd }))).toEqual({ readonly: true, start: 0, end: original.length });
    await field.press('x'); await expect(field).toHaveValue(original);
    await field.evaluate(el => el.setSelectionRange(0, 1)); await page.locator('#history-copy-select').click();
    expect(await field.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, original.length]);
    await page.locator('#history-copy-dismiss').click(); await expect(field).toBeHidden(); await expect(field).toHaveValue('');
    await expect(page.locator('#history-copy-all')).toBeFocused(); await expect(page.locator('#history-tools')).toBeVisible();
    await page.locator('#history-copy-all').click(); await field.press('Escape');
    await expect(field).toBeHidden(); await expect(field).toHaveValue(''); await expect(page.locator('#history-tools')).toBeVisible();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalHistoryReads.length).toBe(1);
  } finally { await app.close(); }
});

test('the copy window button writes the browser clipboard even when the Clipboard API is unavailable', async ({ page, context }) => {
  const app = await fixture({ terminalHistory: 'COPY-BUTTON 中文\n    preserved spaces\n' });
  try {
    const frame = await snapshot(page, app), original = await frame.locator('#history-archive').textContent();
    await context.grantPermissions(['clipboard-read'], { origin: app.config.origin });
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.evaluate(() => {
      window.browserClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const copy = document.execCommand.bind(document); window.copyCommands = [];
      document.execCommand = command => { window.copyCommands.push(command); return copy(command); };
    });
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-copy-all').click();
    await page.getByRole('button', { name: '复制到本机', exact: true }).click();
    await expect(page.locator('#history-copy-result')).toContainText('已复制到本机剪贴板');
    expect(await page.evaluate(() => window.browserClipboard.readText())).toBe(original);
    expect(await page.evaluate(() => window.copyCommands)).toEqual(['copy']);
    await expect(page.locator('#history-copy-manual')).toHaveJSProperty('open', true);
    await expect(page.locator('#history-copy-text')).toHaveValue(original);
    expect(app.terminalInputs).toEqual([]); expect(app.terminalHistoryReads.length).toBe(1);
  } finally { await app.close(); }
});

test('the copy button retries the local Clipboard API, reports denial and ignores results after closing', async ({ page }) => {
  const app = await fixture({ terminalHistory: 'COPY-RETRY-ONLY\n' });
  try {
    const frame = await snapshot(page, app), original = await frame.locator('#history-archive').textContent();
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.evaluate(() => {
      document.execCommand = () => false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { (window.retryCopies ||= []).push(text); } } });
    });
    await frame.locator('#history-tools-toggle').click(); await page.locator('#history-copy-all').click();
    const retry = page.locator('#history-copy-retry'), field = page.locator('#history-copy-text'), result = page.locator('#history-copy-result');
    await retry.click(); await expect(result).toContainText('已复制'); expect(await page.evaluate(() => window.retryCopies)).toEqual([original]);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await retry.click(); await expect(result).toContainText('复制未成功'); await expect(field).toHaveValue(original);
    expect(await field.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, original.length]);
    await page.evaluate(() => { window.pendingCopyCalls = 0; navigator.clipboard.writeText = () => new Promise(resolve => { window.pendingCopyCalls++; window.finishCopy = resolve; }); });
    await retry.click(); await expect(retry).toBeDisabled(); await retry.dispatchEvent('click');
    expect(await page.evaluate(() => window.pendingCopyCalls)).toBe(1);
    await page.locator('#history-copy-dismiss').click(); await expect(field).toBeHidden(); await expect(field).toHaveValue('');
    await page.evaluate(async () => { window.finishCopy(); await new Promise(requestAnimationFrame); });
    await expect(page.locator('#history-copy-manual')).toBeHidden(); await expect(result).toHaveText('关闭窗口会清空这里的文字。');
    expect(await page.evaluate(() => document.activeElement.id)).not.toBe('history-copy-text');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalHistoryReads.length).toBe(1);
  } finally { await app.close(); }
});

test('opening local find freezes already received rows and styles without sending a history request; new output cannot alter the results', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app);
    output(app, Array.from({ length: 150 }, (_, index) => `LOCAL-${index}\r\n`).join('') + '\x1b[1;31mCOLORED-LOCAL\x1b[0m\r\n');
    await expect.poll(() => frame.evaluate(() => window.toolsTerminal.buffer.active.getLine(window.toolsTerminal.buffer.active.baseY)?.translateToString(true))).toContain('LOCAL-');
    await frame.evaluate(() => window.toolsTerminal.scrollLines(-10)); const dimensions = await size(frame);
    await frame.locator('#history-tools-toggle').click(); const archive = frame.locator('#history-archive');
    await expect(archive).toContainText('COLORED-LOCAL'); await expect(page.locator('#history-find-state')).toHaveAttribute('aria-label', /本地已加载内容/);
    const colored = archive.locator('span').filter({ hasText: /^COLORED-LOCAL$/ });
    expect(await colored.evaluate(element => getComputedStyle(element).color)).toBe('rgb(239, 41, 41)');
    await page.locator('#history-query').fill('LOCAL-12'); await expect(page.locator('#history-find-state')).toContainText('/11');
    const before = await archive.textContent(), position = await archive.evaluate(element => element.scrollTop);
    output(app, 'LOCAL-12-NEW\r\n'); await expect(frame.locator('#history-new-output')).toBeVisible();
    expect(await archive.textContent()).toBe(before); expect(await archive.evaluate(element => element.scrollTop)).toBe(position); expect(await size(frame)).toEqual(dimensions);
    expect(app.terminalHistoryReads).toEqual([]); expect(app.terminalInputs).toEqual([]);
    await frame.locator('#history-latest').click(); await expect(archive).toBeHidden(); await expect(page.locator('#history-tools')).toBeVisible();
  } finally { await app.close(); }
});

test('search remains local across reconnect, respects IME composition, and caps highlighted matches', async ({ page }) => {
  const app = await fixture({ terminalHistory: '中文 中文\n' + 'a '.repeat(2500) });
  try {
    const frame = await snapshot(page, app); await frame.locator('#history-tools-toggle').click(); const query = page.locator('#history-query');
    await query.dispatchEvent('compositionstart'); await query.fill('中文');
    await query.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true }); await page.waitForTimeout(180);
    await expect(page.locator('#history-find-state')).toContainText('输入中'); expect(await frame.locator('#history-archive mark').count()).toBe(0);
    await query.dispatchEvent('compositionend'); await expect(page.locator('#history-find-state')).toContainText('1/2');
    await query.fill('a'); await expect(page.locator('#history-find-state')).toContainText('1/1000+');
    expect(await frame.locator('#history-archive mark').count()).toBe(1000); const before = await frame.locator('#history-archive').textContent();
    app.disconnectTerminals(); await expect.poll(() => app.terminalConnections).toBe(2); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(query).toHaveValue('a'); await expect(page.locator('#history-find-state')).toContainText('1/1000+');
    expect(await frame.locator('#history-archive').textContent()).toBe(before); expect(await frame.evaluate(() => window.terminalInstances)).toBe(1);
    expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]);
    await query.dispatchEvent('compositionstart'); await query.fill('中文');
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#history-find-state')).toContainText('1/2');
    await expect(query).toHaveValue('中文'); expect(app.terminalHistoryReads.length).toBe(1); expect(app.terminalInputs).toEqual([]);
    expect(await frame.evaluate(() => [localStorage, sessionStorage].every(storage => Object.values(storage).every(value => !String(value).includes('中文 中文'))))).toBe(true);
  } finally { await app.close(); }
});

test('a delayed clipboard denial cannot reopen the copy dialog or focus a hidden field after returning live', async ({ page }) => {
  const app = await fixture({ terminalHistory: 'COPY-REQUEST-ONLY\n' });
  try {
    const frame = await snapshot(page, app); await frame.locator('#history-tools-toggle').click();
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_resolve, reject) => { window.denyHistoryCopy = reject; }) } }));
    await page.locator('#history-copy-all').click(); await expect(page.locator('#history-copy-all')).toBeDisabled();
    await frame.locator('#history-latest').click(); await frame.evaluate(() => window.denyHistoryCopy(new Error('denied'))); await page.waitForTimeout(100);
    await expect(page.locator('#history-tools')).toBeVisible(); await expect(page.locator('#history-copy-manual')).toBeHidden();
    expect(await frame.evaluate(() => document.activeElement.id)).not.toBe('history-copy-text');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
