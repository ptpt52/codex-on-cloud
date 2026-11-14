import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

// Headless browsers have no OS keyboard. Real IME, beforeinput and viewport
// event paths are exercised here; phone input methods still need device QA.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  });
});
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await closePanels(page);
  const frame = page.frames().find(value => value.url().includes('/desktop/index.html'));
  await expect(frame.locator('#desktop-touch-keyboard')).toBeVisible();
  await frame.locator('#desktop-touch-keyboard').click();
  await expect(frame.locator('#desktop-input')).toBeFocused();
  await expect(frame.locator('#desktop-touch-panel')).toBeVisible();
  return frame;
}
function keys(page) {
  const sent = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (Buffer.isBuffer(payload) && payload.length === 8 && payload[0] === 4 && payload[1] === 1) sent.push(payload.readUInt32BE(4));
  })); return sent;
}
async function insert(frame, text) {
  await frame.locator('#desktop-input').evaluate((field, text) => {
    field.value += text;
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
  }, text);
}
async function compose(frame, text) {
  await frame.locator('#desktop-input').evaluate((field, text) => {
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const committed = field.value + text; field.value = committed;
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, isComposing: true, bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
    field.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
    field.value = committed;
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }, text);
}

test('one tap enables touch IME and candidate confirmation never submits; explicit keys keep the keyboard focused', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app); await compose(frame, '手机中文😀');
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'paste', target: 'focused', text: '手机中文😀' }]);
    await insert(frame, 'abc 123');
    await expect.poll(() => app.inputCalls.map(value => value.text)).toEqual(['手机中文😀', 'abc 123']);
    const retained = await frame.evaluate(() => /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (retained) expect(await frame.locator('#desktop-input').inputValue()).toContain('手机中文😀abc 123');
    else expect(await frame.locator('#desktop-input').inputValue()).toHaveLength(1);
    expect(sent).toEqual([]);
    await frame.locator('[data-touch-key="Enter"]').click();
    await expect.poll(() => sent).toEqual([0xff0d]);
    await expect(frame.locator('#desktop-input')).toBeFocused();
    await frame.locator('#desktop-touch-more').click();
    await frame.locator('#desktop-touch-menu [data-touch-key="ArrowLeft"]').click();
    await expect.poll(() => sent).toEqual([0xff0d, 0xff51]);
    await expect(frame.locator('#desktop-input')).toBeFocused();
    await frame.locator('#desktop-touch-close').click();
    await expect(frame.locator('#desktop-touch-panel')).toBeHidden();
    await expect(frame.locator('#desktop-touch-keyboard')).toBeVisible();
    await expect(frame.locator('#desktop-input')).toHaveValue('');
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('soft-keyboard beforeinput and input-only deletion each send one backspace, while line breaks never submit', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    await frame.locator('#desktop-input').evaluate(field => {
      field.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
      // Some keyboards deliver input even after a cancelled beforeinput.
      field.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
      field.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true }));
      field.value = ''; field.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
      for (const type of ['insertParagraph', 'insertLineBreak']) {
        field.dispatchEvent(new InputEvent('beforeinput', { inputType: type, bubbles: true, cancelable: true }));
        field.value += '\n'; field.dispatchEvent(new InputEvent('input', { inputType: type, bubbles: true }));
      }
    });
    await expect.poll(() => sent).toEqual([0xff08, 0xff08]);
    expect(app.inputCalls).toEqual([]);
    await expect(frame.locator('#desktop-input-status')).toContainText('快捷栏 Enter');
    await compose(frame, '退格后的中文');
    await expect.poll(() => app.inputCalls.map(value => value.text)).toEqual(['退格后的中文']);
  } finally { await app.close(); }
});

test('a tablet hardware keyboard keeps English, backspace and Enter on their original key path', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    await page.keyboard.type('abc'); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
    await expect.poll(() => sent).toEqual([97, 98, 99, 0xff08, 0xff0d]); expect(app.inputCalls).toEqual([]);
    await expect(frame.locator('#desktop-input')).toBeFocused();
    await openTools(page); await page.locator('#desktop-ime').uncheck(); await closePanels(page);
    await expect(frame.locator('#desktop-touch-input')).toBeHidden();
    await openInput(page); await expect(page.locator('#mobile-input')).toBeVisible();
  } finally { await app.close(); }
});

test('soft keys with no physical code do not double-delete or submit when DOM input events follow', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page);
  try {
    const frame = await login(page, app);
    await frame.locator('#desktop-input').evaluate(field => {
      for (const [key, inputType] of [['Backspace', 'deleteContentBackward'], ['Enter', 'insertParagraph']]) {
        field.dispatchEvent(new KeyboardEvent('keydown', { key, code: '', bubbles: true, cancelable: true }));
        field.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
        field.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keyup', { key, code: '', bubbles: true, cancelable: true }));
      }
    });
    await expect.poll(() => sent).toEqual([0xff08]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('Chinese, digits, spaces, punctuation and emoji stay ordered while text is pending', async ({ page }) => {
  let release; const hold = new Promise(resolve => release = resolve);
  const app = await fixture({ rfb: true, inputHook: () => hold }), sent = keys(page);
  try {
    const frame = await login(page, app); await compose(frame, '你好');
    await expect.poll(() => app.inputCalls.length).toBe(1);
    await page.keyboard.type('123 '); await insert(frame, '，'); await compose(frame, '世界'); await insert(frame, '😀');
    await frame.locator('[data-touch-key="Enter"]').click(); expect(sent).toEqual([]); release();
    await expect.poll(() => app.inputCalls.map(value => value.text).join('')).toBe('你好，世界😀');
    await expect.poll(() => sent).toEqual([49, 50, 51, 32, 0xff0d]);
    await expect(frame.locator('#desktop-input')).toBeFocused();
  } finally { release(); await app.close(); }
});

test('touch assistant preserves local editing focus after paste and Enter without sending the next draft', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await openInput(page);
    const field = page.locator('#mobile-input'); await field.fill('第一段草稿'); await page.locator('#paste-button').click();
    await expect.poll(() => app.inputCalls.length).toBe(1); await expect(field).toBeFocused();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await page.locator('#input-dock [data-key="Enter"]').click();
    await expect.poll(() => app.inputCalls.length).toBe(2); await expect(field).toBeFocused();
    await page.keyboard.insertText('，继续写下一段');
    await expect(field).toHaveValue('第一段草稿，继续写下一段');
    expect(app.inputCalls[0].text).toBe('第一段草稿'); expect(app.inputCalls[1].key).toBe('Enter'); expect(app.inputCalls.length).toBe(2);
  } finally { await app.close(); }
});

test('touch text also uses the unified desktop stream without replacing its viewer', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    const frame = await login(page, app); await compose(frame, '统一通道输入');
    await expect.poll(() => app.inputCalls.map(value => value.text)).toEqual(['统一通道输入']);
    const downs = await frame.locator('#screen canvas').evaluate(canvas => {
      window.touchKeyEvents = []; canvas.addEventListener('keydown', event => window.touchKeyEvents.push(event.key)); return window.touchKeyEvents;
    });
    expect(downs).toEqual([]); await frame.locator('[data-touch-key="Enter"]').click();
    await expect.poll(() => frame.evaluate(() => window.touchKeyEvents)).toEqual(['Enter']);
    await expect(frame.locator('#desktop-input')).toBeFocused(); expect(app.vncConnections).toBe(1);
  } finally { await app.close(); }
});

test('touch keys wait for a preceding paste and remain in order', async ({ page }) => {
  let release; const hold = new Promise(resolve => release = resolve);
  const app = await fixture({ rfb: true, inputHook: () => hold }), sent = keys(page);
  try {
    const frame = await login(page, app); await compose(frame, '等待完成');
    await expect.poll(() => app.inputCalls.length).toBe(1);
    await frame.locator('[data-touch-key="Tab"]').click();
    await frame.locator('[data-touch-key="Backspace"]').click();
    expect(sent).toEqual([]); release();
    await expect.poll(() => sent).toEqual([0xff09, 0xff08]);
    await expect(frame.locator('#desktop-input')).toBeFocused();
    expect(app.inputCalls.length).toBe(1);
  } finally { release(); await app.close(); }
});

test('tools and reconnect cancel touch composition without sending it or reopening the keyboard', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    const frame = await login(page, app);
    await frame.locator('#desktop-input').dispatchEvent('compositionstart');
    await expect(frame.locator('[data-touch-key="Enter"]')).toBeDisabled();
    await openTools(page);
    await frame.locator('#desktop-input').dispatchEvent('compositionend', { data: '已取消' });
    await closePanels(page);
    await expect(frame.locator('#desktop-touch-panel')).toBeHidden();
    await frame.locator('#desktop-touch-keyboard').click();
    await frame.locator('#desktop-input').dispatchEvent('compositionstart');
    app.disconnectViewers();
    await expect(frame.locator('#desktop-touch-panel')).toBeHidden();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await frame.locator('#desktop-input').dispatchEvent('compositionend', { data: '不补发' });
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('long text opens the existing assistant and retains its draft without pasting', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('多行草稿\n继续编辑'); await closePanels(page);
    const frame = page.frames().find(value => value.url().includes('/desktop/index.html'));
    await frame.locator('#desktop-touch-keyboard').click();
    await frame.locator('.desktop-touch-heading [data-touch-action="assistant"]').click();
    await expect(page.locator('#input-dock')).toBeVisible(); await expect(page.locator('#mobile-input')).toBeFocused();
    await expect(page.locator('#mobile-input')).toHaveValue('多行草稿\n继续编辑');
    await expect(frame.locator('#desktop-touch-panel')).toBeHidden(); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('touch Ctrl C uses the existing confirmation and follows desktop focus instead of a stale assistant target', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    const catalog = await app.controls.manageTerminals({ action: 'create', name: '旧目标' });
    const terminal = catalog.terminals.find(value => value.id === 'aux1');
    const frame = await login(page, app); await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await app.controls.manageTerminals({ action: 'close', terminalId: terminal.id, terminalToken: terminal.token, confirm: true });
    await closePanels(page); await frame.locator('#desktop-touch-keyboard').click();
    await frame.locator('#desktop-touch-more').click(); await frame.locator('[data-touch-action="interrupt"]').click();
    await expect(page.locator('#action-confirmation')).toBeVisible(); expect(app.inputCalls).toEqual([]);
    const request = page.waitForRequest(value => new URL(value.url()).pathname === '/api/key');
    await page.locator('#accept-confirmation').click();
    expect((await request).postDataJSON()).toMatchObject({ key: 'Ctrl+C', target: 'focused' });
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'key', key: 'Ctrl+C' }]);
  } finally { await app.close(); }
});

test('phone and tablet toolbar follows the visible viewport without resizing the remote desktop', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true });
  try {
    await page.addInitScript(() => {
      if (window !== parent) return;
      const visible = new EventTarget(); Object.assign(visible, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0 });
      Object.defineProperty(window, 'visualViewport', { value: visible });
    });
    const frame = await login(page, app);
    const resizes = app.managementStats.viewportResizes;
    for (const [width, height, visibleHeight] of [[320, 900, 480], [390, 900, 480], [1024, 900, 480], [844, 390, 210]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(visibleHeight => {
        Object.assign(visualViewport, { width: innerWidth, height: visibleHeight, offsetTop: 0 });
        visualViewport.dispatchEvent(new Event('resize'));
      }, visibleHeight);
      await expect.poll(async () => {
        const box = await frame.locator('#desktop-touch-input').boundingBox();
        return !!box && box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= visibleHeight && box.y >= 0;
      }).toBe(true);
      expect(await frame.locator('.desktop-touch-keys').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(frame.locator('#desktop-input')).toBeFocused();
      if (test.info().project.name === 'mobile' && [320, 1024].includes(width)) await page.screenshot({ path: test.info().outputPath(`touch-keyboard-${width}.png`) });
    }
    await page.waitForTimeout(1500);
    expect(app.managementStats.viewportResizes).toBe(resizes); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('unknown touch paste discards queued Enter and never resends after reconnect', async ({ page }) => {
  const app = await fixture({ rfb: true }), sent = keys(page); let finish;
  try {
    const hold = new Promise(resolve => finish = resolve);
    await page.route('**/api/paste', async route => { await route.fetch(); await hold; await route.abort('failed'); });
    const frame = await login(page, app); await compose(frame, '只发一次');
    await expect.poll(() => app.inputCalls.length).toBe(1);
    await frame.locator('[data-touch-key="Enter"]').click(); finish();
    await expect(frame.locator('#desktop-input-status')).toContainText('结果未知');
    await expect(frame.locator('#desktop-touch-panel')).toBeHidden();
    await expect(frame.locator('#desktop-input')).not.toBeFocused();
    expect(sent).toEqual([]);
    app.disconnectViewers(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(app.inputCalls.length).toBe(1); expect(sent).toEqual([]);
  } finally { finish?.(); await app.close(); }
});
