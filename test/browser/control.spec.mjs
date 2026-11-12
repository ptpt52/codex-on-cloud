import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
  await page.getByRole('button', { name: '连接状态', exact: true }).click();
  await expect(page.locator('#diag-input-transport')).toHaveText(/^WebRTC 加密直连(?:（局域网）)?$/);
  await page.getByRole('button', { name: '关闭连接状态' }).click();
}

test('direct paste, separate Enter and maximum escaped clipboard use encrypted control without HTTP writes', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true }); let http = 0;
  app.clipboardText.clipboard = '\x01'.repeat(32768);
  await page.route(/\/api\/(paste|key|clipboard\/read)$/, route => { http++; return route.abort(); });
  try {
    await login(page, app);
    const text = '中文\n$(literal) `literal` ' + '中'.repeat(10000);
    await openInput(page); await page.locator('#mobile-input').fill(text); await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toEqual([{ action: 'paste', text, target: 'terminal' }]);
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toHaveLength(2); expect(app.inputCalls[1]).toEqual({ action: 'key', key: 'Enter' });
    await openInput(page); await page.locator('#clipboard-button').click(); await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    expect(app.clipboardReads).toEqual(['clipboard']); expect(http).toBe(0);
    await page.locator('#close-clipboard').click();
    await expect(page.locator('#mobile-input')).toHaveValue(text);
  } finally { await app.close(); }
});

test('lost direct input result stays unknown without HTTP resend or reconnect replay', async ({ page }) => {
  let release, started;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const app = await fixture({ rfb: true, webrtc: true, inputHook: async () => { started(); await hold; } }); let http = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(paste|key)$/.test(request.url())) http++; });
  try {
    await login(page, app);
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await entered;
    app.disconnectViewers();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    release();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]); expect(http).toBe(0);
  } finally { release(); await app.close(); }
});

test('takeover discards a pending direct clipboard result and never reads it again automatically', async ({ page, context }) => {
  let release, started;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const app = await fixture({ rfb: true, webrtc: true, clipboardHook: async () => { started(); await hold; } });
  app.clipboardText.clipboard = '旧页面不应看到这段文字';
  try {
    await login(page, app);
    await openInput(page); await page.locator('#clipboard-button').click(); await page.locator('#read-clipboard').click(); await entered;
    const second = await context.newPage(); await second.goto(app.config.origin);
    await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 15000 });
    release();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    expect(app.clipboardReads).toEqual(['clipboard']); expect(app.inputCalls).toEqual([]);
    await second.close();
  } finally { release(); await app.close(); }
});
