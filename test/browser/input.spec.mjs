import { openInput, openTools, closePanels } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}

test('input stays busy until the result and shows success without submitting Enter', async ({ page }) => {
  const hold = gate();
  const app = await fixture({ rfb: true, inputHook: async value => { if (value.action === 'paste') await hold.promise; } });
  try {
    await login(page, app);
    await openInput(page); await page.locator('#mobile-input').fill('中文输入保持草稿');
    await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'pending');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    expect(app.inputCalls).toEqual([{ action: 'paste', text: '中文输入保持草稿', target: 'terminal' }]);
    hold.release();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await expect(page.locator('#input-status')).toContainText('已粘贴');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    expect(app.inputCalls).toHaveLength(1);
    await expect(page.locator('#mobile-input')).toHaveValue('中文输入保持草稿');
  } finally { hold.release(); await app.close(); }
});

test('a lost response is unknown and neither reconnect nor refresh replays the accepted input', async ({ page }) => {
  const app = await fixture({ rfb: true });
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/key')) writes++; });
  try {
    await login(page, app);
    await page.route('**/api/key', async route => { await route.fetch(); await route.abort('failed'); });
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await expect(page.locator('#input-status')).toContainText('先查看桌面确认');
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]);
    app.disconnectViewers();
    await expect(page.locator('#connection-status')).toContainText('画面重连中');
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await page.reload();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(writes).toBe(1); expect(app.inputCalls).toHaveLength(1);
  } finally { await app.close(); }
});

test('rejected input and uncertain execution have distinct feedback', async ({ page }) => {
  const app = await fixture({ rfb: true, inputHook: () => { throw new Error('mock execution error'); } });
  try {
    await login(page, app);
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    expect(app.inputCalls).toHaveLength(1);
    await page.reload();
    await expect(page.locator('#input-status')).toContainText('上一项输入结果未知');
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.route('**/api/key', route => route.fulfill({ status: 409, json: { error: '当前繁忙，本次输入未发送', outcome: 'rejected' } }));
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'rejected');
    await expect(page.locator('#input-status')).toContainText('未发送');
    expect(app.inputCalls).toHaveLength(1);
  } finally { await app.close(); }
});

test('a stalled write times out once, preserves the draft and does not resend', async ({ page }) => {
  const app = await fixture({ rfb: true }), hold = gate();
  let writes = 0;
  try {
    await login(page, app);
    await page.route('**/api/paste', async route => { writes++; await hold.promise; await route.abort().catch(() => {}); });
    await openInput(page); await page.locator('#mobile-input').fill('超时后仍保留的草稿');
    await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown', { timeout: 10000 });
    await expect(page.locator('#mobile-input')).toHaveValue('超时后仍保留的草稿');
    expect(writes).toBe(1); expect(app.inputCalls).toHaveLength(0);
  } finally { hold.release(); await app.close(); }
});

test('closing settings during a font update keeps input blocked until maintenance finishes', async ({ page }) => {
  const hold = gate(), started = gate();
  const app = await fixture({ rfb: true, desktopHook: async (command, args) => {
    if (command === 'xdotool' && args[0] === 'windowclose') { started.release(); await hold.promise; }
  } });
  const frames = { keys: 0, pointers: 0 };
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (!Buffer.isBuffer(payload)) return;
    if (payload.length === 8 && payload[0] === 4) frames.keys++;
    if (payload.length === 6 && payload[0] === 5) frames.pointers++;
  }));
  try {
    await login(page, app);
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#apply-terminal-font')).toBeEnabled();
    await page.locator('#apply-terminal-font').click();
    await started.promise;
    await page.locator('#close-desktop-settings').click();
    await closePanels(page);
    await expect(page.locator('#connection-status')).toContainText('桌面操作进行中');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await expect(page.locator('#desktop-overlay')).toBeVisible();
    const before = { ...frames };
    await page.locator('#desktop-overlay').click();
    await page.locator('#desktop-overlay').press('Enter');
    expect(frames).toEqual(before); expect(app.inputCalls).toHaveLength(0);
    hold.release();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    expect(app.inputCalls).toHaveLength(0);
  } finally { hold.release(); await app.close(); }
});
