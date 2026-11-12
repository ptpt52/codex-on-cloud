import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await closePanels(page);
  const frame = page.frames().find(value => value.url().includes('/desktop/index.html'));
  await frame.locator('#screen canvas').click({ position: { x: 30, y: 30 } });
  // Coarse pointer devices retain the input assistant. Programmatic focus here
  // exercises the same IME events without pretending to open an OS keyboard.
  if (await frame.evaluate(() => matchMedia('(pointer: coarse)').matches)) await frame.locator('#desktop-input').focus();
  else await expect(frame.locator('#desktop-input')).toBeFocused();
  return frame;
}
function keys(page) {
  const values = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (Buffer.isBuffer(payload) && payload.length === 8 && payload[0] === 4) values.push({ down: payload[1] === 1, sym: payload.readUInt32BE(4) });
  })); return values;
}
async function compose(frame, text) {
  await frame.locator('#desktop-input').evaluate((el, text) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    el.value = text; el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, isComposing: true, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
    el.value = text; el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromComposition', data: text, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }, text);
}

test('Chinese composition is committed once to the focused window; candidate Enter never submits and ordinary keys still work', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app); await compose(frame, '中文输入😀');
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'paste', text: '中文输入😀', target: 'focused' }]);
    await expect(frame.locator('#desktop-input-status')).toContainText('支持本机输入法');
    await frame.evaluate(() => parent.postMessage({ type: 'codex-desktop-text', frame: new URLSearchParams(location.search).get('frame'), id: 1, text: '重复消息不发送' }, location.origin));
    expect(sent.filter(value => value.down)).toEqual([]);
    await page.keyboard.type('abc'); await page.keyboard.press('Enter');
    await expect.poll(() => sent.filter(value => value.down).map(value => value.sym)).toEqual([97, 98, 99, 0xff0d]);
    expect(app.clipboardReads).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('keys and a second composition wait for the preceding paste and retain order without concurrent writes', async ({ page }) => {
  let release; const hold = new Promise(resolve => release = resolve);
  const app = await fixture({ rfb: true, inputHook: async () => hold }), sent = keys(page);
  try {
    const frame = await login(page, app);
    const busyPoll = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/state' && (await response.json()).controls?.inputBusy === true, { timeout: 7000 });
    await compose(frame, '第一段');
    await expect.poll(() => app.inputCalls.length).toBe(1);
    await page.keyboard.type('x'); await compose(frame, '第二段'); await page.keyboard.press('Enter');
    expect(app.inputCalls.length).toBe(1); expect(sent.filter(value => value.down)).toEqual([]);
    await busyPoll; release();
    await expect.poll(() => app.inputCalls.map(value => value.text)).toEqual(['第一段', '第二段']);
    await expect.poll(() => sent.filter(value => value.down).map(value => value.sym)).toEqual([120, 0xff0d]);
  } finally { release(); await app.close(); }
});

test('Chrome IME protocol commits real composition event sequences exactly once', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP IME simulation is Chromium-only');
  const app = await fixture({ rfb: true });
  try {
    const frame = await login(page, app), client = await context.newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    expect(app.inputCalls).toEqual([]);
    await client.send('Input.insertText', { text: '系统事件中文' });
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'paste', target: 'focused', text: '系统事件中文' }]);
    await expect(frame.locator('#desktop-input')).toHaveValue(''); await client.detach();
  } finally { await app.close(); }
});

test('an unmarked first pinyin key, full-width punctuation and emoji stay with the browser until text is committed', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    expect(await frame.locator('#desktop-input').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', keyCode: 78, bubbles: true, cancelable: true })))).toBe(true);
    expect(sent.filter(value => value.down)).toEqual([]);
    await compose(frame, '你好');
    await frame.locator('#desktop-input').evaluate(el => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', bubbles: true, cancelable: true }));
      el.value = '，'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '，', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ',', code: 'Comma', bubbles: true, cancelable: true }));
      el.value = '😀'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '😀', bubbles: true }));
    });
    await page.keyboard.type('123 '); await page.keyboard.press('Enter');
    await expect.poll(() => app.inputCalls.map(value => value.text)).toEqual(['你好', '，', '😀']);
    await expect.poll(() => sent.filter(value => value.down).map(value => value.sym)).toEqual([49, 50, 51, 32, 0xff0d]);
  } finally { await app.close(); }
});

test('remote clipboard shortcuts keep their native key path while local text uses the input assistant', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    await frame.locator('#desktop-input').evaluate(el => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
    });
    await expect.poll(() => sent.filter(value => value.down).map(value => value.sym)).toEqual([0xffe3, 118]);
    expect(app.inputCalls).toEqual([]); expect(app.clipboardReads).toEqual([]);
  } finally { await app.close(); }
});

test('closing tools or input restores desktop keyboard focus and the IME option persists independently', async ({ page }, info) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    for (const panel of ['tools', 'input']) {
      await (panel === 'tools' ? openTools(page) : openInput(page));
      await page.locator(panel === 'tools' ? '#close-controls-button' : '#close-input-button').click();
      const coarse = await frame.evaluate(() => matchMedia('(pointer: coarse)').matches);
      await expect(frame.locator(coarse ? '#screen canvas' : '#desktop-input')).toBeFocused();
    }
    await page.keyboard.type('a'); await expect.poll(() => sent.filter(value => value.down).map(value => value.sym)).toEqual([97]);
    await openTools(page); await expect(page.locator('#desktop-ime')).toBeChecked(); await page.locator('#desktop-ime').uncheck(); await closePanels(page);
    await expect(frame.locator('#screen canvas')).toBeFocused();
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await openTools(page);
    await expect(page.locator('#desktop-ime')).not.toBeChecked(); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a cancelled composition and a focus change discard uncommitted text', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    const frame = await login(page, app);
    await frame.locator('#desktop-input').dispatchEvent('compositionstart');
    await frame.locator('#desktop-input').dispatchEvent('compositionend', { data: '' });
    await frame.locator('#desktop-input').dispatchEvent('compositionstart');
    await openTools(page);
    await frame.locator('#desktop-input').dispatchEvent('compositionend', { data: '不要发送' });
    expect(app.inputCalls).toEqual([]); await expect(frame.locator('#desktop-input')).toHaveValue('');
  } finally { await app.close(); }
});

test('direct desktop text follows focus even when the input assistant remembers a closed terminal', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    const catalog = await app.controls.manageTerminals({ action: 'create', name: '旧目标' });
    const terminal = catalog.terminals.find(value => value.id === 'aux1');
    await login(page, app); await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await app.controls.manageTerminals({ action: 'close', terminalId: terminal.id, terminalToken: terminal.token, confirm: true });
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#terminal-target-note')).toContainText('终端已关闭'); await closePanels(page);
    const frame = page.frames().find(value => value.url().includes('/desktop/index.html'));
    await frame.locator('#desktop-input').focus(); await compose(frame, '跟随当前窗口');
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'paste', text: '跟随当前窗口', target: 'focused' }]);
  } finally { await app.close(); }
});

test('a lost paste acknowledgement clears later keys and never retries the accepted text on reconnect', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    let finish; const hold = new Promise(resolve => finish = resolve);
    await page.route('**/api/paste', async route => { await route.fetch(); await hold; await route.abort('failed'); });
    const frame = await login(page, app); await compose(frame, '只输入一次'); await expect.poll(() => app.inputCalls.length).toBe(1);
    await page.keyboard.type('queued'); finish();
    await expect(frame.locator('#desktop-input-status')).toContainText('结果未知');
    expect(sent.filter(value => value.down)).toEqual([]);
    app.disconnectViewers(); await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
    expect(app.inputCalls).toEqual([{ action: 'paste', text: '只输入一次', target: 'focused' }]);
  } finally { await app.close(); }
});

test('oversized commits and a full ordering buffer are rejected without replaying later input', async ({ page }) => {
  let release; const hold = new Promise(resolve => release = resolve);
  const app = await fixture({ rfb: true, inputHook: async () => hold }), sent = keys(page);
  try {
    const frame = await login(page, app); await compose(frame, '中'.repeat(11000));
    await expect(frame.locator('#desktop-input-status')).toContainText('32 KiB'); expect(app.inputCalls).toEqual([]);
    await compose(frame, '缓慢输入'); await expect.poll(() => app.inputCalls.length).toBe(1);
    await frame.locator('#desktop-input').evaluate(el => {
      for (let i = 0; i < 80; i++) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
        el.value = 'a'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a', bubbles: true }));
      }
    });
    await expect(frame.locator('#desktop-input-status')).toContainText('上限'); release();
    await page.waitForTimeout(200); expect(sent.filter(value => value.down)).toEqual([]); expect(app.inputCalls.length).toBe(1);
  } finally { release(); await app.close(); }
});
