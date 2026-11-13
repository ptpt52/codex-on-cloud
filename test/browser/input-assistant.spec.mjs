import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.locator('#password').fill(app.config.password);
  await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await page.locator('#toggle-input-button').click();
  await expect(page.locator('#mobile-input')).toBeFocused();
}

test('IME composition sends nothing, paste and Enter remain separate, and oversized UTF-8 stays local', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    const field = page.locator('#mobile-input');
    await field.fill('中文输入\n不会自动执行');
    await field.dispatchEvent('compositionstart', { data: '中文' });
    await expect(page.locator('#paste-button')).toBeDisabled();
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await field.press('Enter');
    expect(app.inputCalls).toEqual([]);
    await field.dispatchEvent('compositionend', { data: '中文' });
    await expect(page.locator('#paste-button')).toBeEnabled();
    await field.fill('中文输入\n不会自动执行');
    await page.locator('#paste-button').click();
    await expect.poll(() => app.inputCalls).toEqual([{ action: 'paste', text: '中文输入\n不会自动执行', target: 'terminal' }]);
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await page.locator('[data-key="Enter"]').click();
    await expect.poll(() => app.inputCalls.length).toBe(2);
    expect(app.inputCalls[1]).toEqual({ action: 'key', key: 'Enter' });
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await field.fill('中'.repeat(11000));
    await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toContainText('32 KiB');
    expect(app.inputCalls).toHaveLength(2);
  } finally { await app.close(); }
});

test('send and receive directions preserve the draft and clear remote text when leaving the preview', async ({ page }) => {
  const app = await fixture({ rfb: true });
  app.clipboardText.clipboard = '只在点击读取后可见的远程文字';
  try {
    await login(page, app);
    const frameURL = await page.locator('#desktop-frame').getAttribute('src');
    const sendBox = await page.locator('#input-dock').boundingBox();
    await page.locator('#mobile-input').fill('尚未发送的草稿');
    await page.locator('#clipboard-button').click();
    await expect(page.locator('#clipboard-dialog')).toBeVisible();
    expect(await page.locator('#input-dock').boundingBox()).toEqual(sendBox);
    await expect(page.locator('#assistant-send-panel')).toBeHidden();
    await expect(page.locator('[data-key="Enter"]')).toBeHidden();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect(app.clipboardReads).toEqual([]);
    await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    await page.locator('#assistant-send-button').click();
    await expect(page.locator('#clipboard-dialog')).toBeHidden();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#mobile-input')).toHaveValue('尚未发送的草稿');
    await expect(page.locator('#mobile-input')).toBeFocused();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(frameURL);
    expect(app.inputCalls).toEqual([]);
    await page.locator('#close-input-button').click();
    await page.reload();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#toggle-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('尚未发送的草稿');
    expect(app.clipboardReads).toEqual(['clipboard']);
  } finally { await app.close(); }
});

test('switching direction cancels a pending preview without a late read, draft loss or input replay', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, clipboardHook: async () => hold }); app.clipboardText.clipboard = '迟到的远程文字';
  try {
    await login(page, app); await page.locator('#mobile-input').fill('保留草稿');
    await page.locator('#clipboard-button').click(); await page.locator('#read-clipboard').click();
    await expect.poll(() => app.clipboardReads.length).toBe(1);
    await page.locator('#assistant-send-button').click(); release();
    await expect(page.locator('#mobile-input')).toHaveValue('保留草稿');
    await page.locator('#clipboard-button').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#copy-clipboard')).toBeDisabled();
    expect(app.clipboardReads).toEqual(['clipboard']); expect(app.inputCalls).toEqual([]);
  } finally { release(); await app.close(); }
});

test('a simulated visual keyboard keeps paste and Enter visible without resizing or restarting the desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // This exercises visualViewport geometry; a real OS keyboard needs device QA.
  await page.addInitScript(() => {
    const viewport = new EventTarget(); viewport.height = innerHeight; viewport.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  });
  const app = await fixture({ rfb: true, viewport: true, rfbSize: { width: 1600, height: 3200 } });
  try {
    await login(page, app);
    await page.locator('#mobile-input').fill('模拟键盘出现时保留中文草稿');
    await page.evaluate(() => { visualViewport.height = 320; visualViewport.dispatchEvent(new Event('resize')); });
    await expect(page.locator('html')).toHaveClass(/workspace-keyboard-open/);
    for (const selector of ['#input-dock', '#paste-button', '[data-key="Enter"]', '#draft-backup-button']) {
      await expect.poll(async () => {
        const rect = await page.locator(selector).boundingBox();
        return !!rect && rect.y >= 0 && rect.y + rect.height <= 320;
      }).toBe(true);
    }
    await page.locator('#paste-button').click();
    await expect.poll(() => app.inputCalls.length).toBe(1);
    expect(app.inputCalls[0].text).toBe('模拟键盘出现时保留中文草稿');
    expect(app.managementStats.viewportResizes).toBe(0);
    expect(app.managementStats.restarts).toBe(0);
    await page.evaluate(() => { visualViewport.height = innerHeight; visualViewport.dispatchEvent(new Event('resize')); });
    await expect(page.locator('html')).not.toHaveClass(/workspace-keyboard-open/);
  } finally { await app.close(); }
});
