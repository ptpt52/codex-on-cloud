import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
async function setup(page, mode, options = {}) {
  await page.addInitScript(mode => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
  }, mode);
  const app = await fixture({ rfb: true, ...options });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText(mode === 'desktop' ? '桌面在线' : '终端在线');
    const frame = page.frames().find(value => value.url().includes(mode === 'desktop' ? '/desktop/index.html' : '/terminal/index.html'));
    const field = frame.locator(mode === 'desktop' ? '#desktop-input' : '.xterm-helper-textarea');
    if (mode === 'desktop') await frame.locator('#desktop-touch-keyboard').click(); else await field.focus();
    return { app, frame, field };
  } catch (error) { await app.close(); throw error; }
}

test('desktop: fast dictation revisions coalesce only unstarted snapshots behind one pending paste', async ({ page }) => {
  let release; const hold = new Promise(resolve => release = resolve);
  const { app, field } = await setup(page, 'desktop', { inputHook: () => hold });
  try {
    await update(field, '文'); await expect.poll(() => app.inputCalls.length).toBe(1);
    await field.evaluate(el => {
      for (let index = 1; index <= 100; index++) {
        const value = '文' + '字'.repeat(index); el.value = value;
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value, bubbles: true }));
      }
    });
    expect(app.inputCalls.length).toBe(1); release();
    await expect.poll(() => visible(app, 'desktop')).toBe('文' + '字'.repeat(100));
    expect(app.inputCalls.length).toBe(2); await expect(field).toBeFocused();
  } finally { release(); await app.close(); }
});

test('desktop: rewritten input uses the acknowledged RTC control path without HTTP replay', async ({ page }) => {
  const { app, frame, field } = await setup(page, 'desktop', { seamless: true, webrtc: true, fastConnect: true }); let http = 0;
  try {
    // A visible touch keyboard deliberately keeps a healthy transport stable.
    await frame.locator('#desktop-touch-close').click();
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#close-connection').click();
    await frame.locator('#desktop-touch-keyboard').click();
    await page.route(/\/api\/(paste|edit)$/, route => { http++; return route.abort(); });
    for (const value of ['实时', '实时语音输入', '实时，语音输入。']) {
      await update(field, value); await expect.poll(() => visible(app, 'desktop')).toBe(value);
    }
    expect(http).toBe(0);
  } finally { await app.close(); }
});
async function update(field, value, type = 'insertText') {
  await field.evaluate((el, { value, type }) => {
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: type, data: value, bubbles: true, cancelable: true }));
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { inputType: type, data: value, bubbles: true }));
  }, { value, type });
}
function visible(app, mode) {
  const segments = text => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), value => value.segment);
  let result = [];
  if (mode === 'desktop') {
    for (const call of app.inputCalls) if (['paste', 'edit'].includes(call.action)) {
      result.splice(Math.max(0, result.length - (call.erase || 0))); result.push(...segments(call.text));
    }
  } else for (const { text } of app.terminalInputs) {
    for (const value of segments(text.replace(/\x1b\[(?:200|201)~/g, ''))) { if (value === '\x7f') result.pop(); else result.push(value); }
  }
  return result.join('');
}

test('terminal: native paste updates the retained document through input exactly once', async ({ page }) => {
  const { app, field } = await setup(page, 'terminal');
  try {
    await update(field, '语音'); await expect.poll(() => visible(app, 'terminal')).toBe('语音');
    const count = app.terminalInputs.length;
    const nativeDefault = await field.evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', '粘贴');
      return el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    expect(nativeDefault).toBe(true); expect(app.terminalInputs.length).toBe(count);
    // Synthetic paste has no browser default action; reproduce its DOM edit.
    await update(field, '语音粘贴', 'insertFromPaste'); await expect.poll(() => visible(app, 'terminal')).toBe('语音粘贴');
    expect(app.terminalInputs.at(-1).text).toBe('\x1b[200~粘贴\x1b[201~');
    await update(field, '语音，粘贴。'); await expect.poll(() => visible(app, 'terminal')).toBe('语音，粘贴。');
    expect(app.terminalInputs.at(-1).text).toBe('\x7f\x7f，粘贴。');
  } finally { await app.close(); }
});

for (const mode of ['desktop', 'terminal']) {
  test(`${mode}: Enter finishes a dictation context and later text does not rewrite the submitted line`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      await update(field, '第一句'); await expect.poll(() => visible(app, mode)).toBe('第一句');
      if (mode === 'terminal') expect(app.terminalInputs.map(call => call.text)).toEqual(['第一句']);
      await page.keyboard.press('Enter');
      await update(field, '下一句');
      if (mode === 'desktop') await expect.poll(() => app.inputCalls.filter(call => call.action === 'paste').map(call => call.text)).toEqual(['第一句', '下一句']);
      else {
        await expect.poll(() => app.terminalInputs.map(call => call.text.replace(/\x1b\[(?:200|201)~/g, '')).join('')).toBe('第一句\r下一句');
      }
    } finally { await app.close(); }
  });

  test(`${mode}: blur discards an unfinished composition and its late events before a new dictation context`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      await field.evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = 'weizhong';
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: el.value, isComposing: true, bubbles: true }));
        el.blur(); el.value = '未中';
        el.dispatchEvent(new CompositionEvent('compositionend', { data: el.value, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: el.value, bubbles: true }));
      });
      await page.waitForTimeout(50); expect(visible(app, mode)).toBe('');
      await field.focus(); await update(field, '重新输入'); await expect.poll(() => visible(app, mode)).toBe('重新输入');
    } finally { await app.close(); }
  });

  test(`${mode}: iPad cumulative dictation updates and rewrites edit one retained document`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      for (const value of ['这', '这是', '这是语音', '这是语音输入', '这是语音输出', '这是语音输入。']) {
        await update(field, value); await expect.poll(() => visible(app, mode)).toBe(value);
      }
      const count = mode === 'desktop' ? app.inputCalls.length : app.terminalInputs.length;
      await update(field, '这是语音输入。'); await page.waitForTimeout(100);
      expect(mode === 'desktop' ? app.inputCalls.length : app.terminalInputs.length).toBe(count);
      await expect(field).toHaveValue('这是语音输入。'); await expect(field).toBeFocused();
      expect(app.managementStats.restarts).toBe(0);
    } finally { await app.close(); }
  });

  test(`${mode}: repeats are preserved when the DOM actually appends them and a long pause does not reset dictation`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      await update(field, '你好'); await expect.poll(() => visible(app, mode)).toBe('你好');
      await page.waitForTimeout(700);
      await update(field, '你好你好'); await expect.poll(() => visible(app, mode)).toBe('你好你好');
      await update(field, '你好你好，hello 123'); await expect.poll(() => visible(app, mode)).toBe('你好你好，hello 123');
    } finally { await app.close(); }
  });

  test(`${mode}: iPad composition and keyCode 229 have only one input writer`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      await field.evaluate(el => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: '', keyCode: 229, bubbles: true }));
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = 'zhongwen'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'zhongwen', isComposing: true, bubbles: true }));
      });
      await page.waitForTimeout(40); expect(visible(app, mode)).toBe('');
      await field.evaluate(el => {
        el.value = '中文'; el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '中文', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', code: '', keyCode: 229, bubbles: true }));
      });
      await expect.poll(() => visible(app, mode)).toBe('中文');
      await update(field, '中文输入'); await expect.poll(() => visible(app, mode)).toBe('中文输入');
    } finally { await app.close(); }
  });

  test(`${mode}: delete-only revisions work without pasting the clipboard again`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      await update(field, '这是一段错误'); await expect.poll(() => visible(app, mode)).toBe('这是一段错误');
      await update(field, '这是一段', 'deleteContentBackward'); await expect.poll(() => visible(app, mode)).toBe('这是一段');
      if (mode === 'desktop') expect(app.inputCalls.at(-1)).toMatchObject({ action: 'edit', text: '', erase: 2, focus: { window: '123', target: 'terminal' } });
    } finally { await app.close(); }
  });

  test(`${mode}: a comma inserted into an earlier dictated phrase rewrites its suffix without duplicating it`, async ({ page }) => {
    const { app, field } = await setup(page, mode);
    try {
      for (const value of ['我今天想试试语音输入', '我今天，想试试语音输入', '我今天想试试语音输入。']) {
        await update(field, value, 'insertReplacementText'); await expect.poll(() => visible(app, mode)).toBe(value);
      }
    } finally { await app.close(); }
  });
}
