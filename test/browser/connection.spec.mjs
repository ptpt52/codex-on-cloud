import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
function observeWrites(page) {
  const writes = { input: 0, claims: 0, logins: 0 };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) writes.input++;
    if (request.url().endsWith('/api/desktop/claim')) writes.claims++;
    if (request.url().endsWith('/api/login')) writes.logins++;
  });
  return writes;
}

test('healthy polling cannot hide a disconnected framebuffer and diagnostics show actual resolution', async ({ page }) => {
  const app = await fixture({ rfb: true });
  const writes = observeWrites(page);
  try {
    await login(page, app);
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-resolution')).toHaveText('1600 × 1600');
    await expect(page.locator('#diag-tunnel')).toHaveText('已连接 · 3 条连接');
    await expect(page.locator('#diag-families')).toHaveText('2 / 1');
    await page.getByRole('button', { name: '关闭连接状态' }).click();
    app.pauseViewers();
    await expect(page.locator('#connection-status')).toContainText('画面重连中');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    const polled = page.waitForResponse(response => response.url().endsWith('/api/state') && response.status() === 200);
    const state = await (await polled).json();
    expect(state.desktop.ready).toBe(true);
    await expect(page.locator('#connection-status')).toContainText('画面重连中');
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-panel')).toHaveText('可访问');
    await expect(page.locator('#diag-frame')).toHaveText('重连中');
    await expect(page.locator('#diag-resolution')).toContainText('上次连接');
    await page.getByRole('button', { name: '关闭连接状态' }).click();
    app.resumeViewers();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    expect(writes).toEqual({ input: 0, claims: 1, logins: 1 });
  } finally { await app.close(); }
});

test('network loss and recovery preserve the draft without reclaiming or replaying input', async ({ page, context }) => {
  const app = await fixture({ rfb: true });
  const writes = observeWrites(page);
  try {
    await login(page, app);
    await openInput(page); await page.getByLabel('要粘贴到桌面的文字').fill('网络恢复后不要自动提交');
    await context.setOffline(true);
    await expect(page.locator('#connection-status')).toContainText('等待网络');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await context.setOffline(false);
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    await expect(page.getByLabel('要粘贴到桌面的文字')).toHaveValue('网络恢复后不要自动提交');
    expect(writes).toEqual({ input: 0, claims: 1, logins: 1 });
  } finally { await context.setOffline(false); await app.close(); }
});

test('desktop readiness and an active picture are reported separately', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app);
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const state = await response.json();
      state.desktop.ready = false;
      await route.fulfill({ response, json: state });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connection-status')).toContainText('桌面未就绪');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-desktop')).toHaveText('未就绪');
    await expect(page.locator('#diag-frame')).toHaveText('已连接');
    await expect(page.locator('#diag-tunnel')).toHaveText('已连接 · 3 条连接');
    await page.route('**/api/diagnostics', route => route.fulfill({ json: { tunnel: { available: false } } }));
    await page.locator('#refresh-connection').click();
    await expect(page.locator('#diag-tunnel')).toHaveText('诊断不可用');
    await expect(page.locator('#diag-families')).toHaveText('—');
    await page.getByRole('button', { name: '关闭连接状态' }).click();
    await page.unroute('**/api/state');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
  } finally { await app.close(); }
});

test('expired login closes the viewer and asks for login without replaying requests', async ({ page }) => {
  const app = await fixture({ rfb: true, sessionMs: 2500 });
  const writes = observeWrites(page);
  try {
    await login(page, app);
    await expect(page.getByRole('heading', { name: '进入工作空间' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#login-error')).toContainText('登录已过期');
    await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    expect(writes).toEqual({ input: 0, claims: 1, logins: 1 });
  } finally { await app.close(); }
});

test('outer access expiry stops retries and offers a manual refresh', async ({ page }) => {
  const app = await fixture({ rfb: true });
  const writes = observeWrites(page);
  try {
    await login(page, app);
    await page.route('**/api/state', route => route.fulfill({ status: 302, headers: { location: '/access-login' } }));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connection-status')).toContainText('访问验证已过期');
    await expect(page.locator('#access-refresh-button')).toBeVisible();
    await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    expect(writes).toEqual({ input: 0, claims: 1, logins: 1 });
  } finally { await app.close(); }
});
