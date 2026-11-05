import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';

test('login, Chinese input without automatic submit, files and logout work on a real page', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进入工作空间' })).toBeVisible();
  await page.screenshot({ path: `test-results/${info.project.name}-login.png`, fullPage: true });
  await page.getByLabel('密码', { exact: true }).fill('demo_password_for_tests');
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
  await expect(page.frameLocator('#desktop-frame').locator('#status')).toBeHidden();
  const text = '请分析这个项目\n保留中文和换行';
  let releasePaste;
  const pasteGate = new Promise(resolve => { releasePaste = resolve; });
  await page.route('**/api/paste', async route => { await pasteGate; await route.continue(); });
  await openInput(page); await page.getByLabel('要粘贴到桌面的文字').fill(text);
  const paste = page.waitForRequest(request => request.url().endsWith('/api/paste') && request.method() === 'POST');
  await page.getByRole('button', { name: '粘贴文字' }).click();
  expect((await paste).postDataJSON()).toEqual({ text, target: 'terminal' });
  await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
  releasePaste();
  await expect(page.getByRole('status').filter({ hasText: '已粘贴' })).toBeVisible();
  const enter = page.waitForRequest(request => request.url().endsWith('/api/key') && request.method() === 'POST');
  await openInput(page); await page.locator('[data-key="Enter"]').click();
  expect((await enter).postDataJSON()).toEqual({ key: 'Enter' });
  await page.screenshot({ path: `test-results/${info.project.name}-workspace.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '文件中转', exact: true }).click();
  await page.locator('#upload-input').setInputFiles({ name: '手机资料.txt', mimeType: 'text/plain', buffer: Buffer.from('中文内容') });
  await expect(page.locator('#upload-status')).toContainText('上传完成');
  await expect(page.locator('#file-list')).toContainText('手机资料.txt');
  const download = page.waitForEvent('download');
  await page.locator('#file-list').getByRole('link', { name: '下载' }).last().click();
  expect((await download).suggestedFilename()).toBe('手机资料.txt');
  await page.getByRole('button', { name: '关闭文件中转' }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.locator('#cancel-confirmation')).toBeFocused();
  await page.getByRole('button', { name: '确认退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '进入工作空间' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a second page takes over without the first page reconnecting automatically', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('demo_password_for_tests');
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  const oldFrame = new URL(await page.locator('#desktop-frame').getAttribute('src'), page.url()).searchParams.get('frame');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('#connection-status')).toContainText('桌面在线');
  await expect(page.getByRole('button', { name: '在这里继续使用' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '在这里继续使用' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await page.evaluate(frame => window.dispatchEvent(new MessageEvent('message', {
    origin: location.origin, source: document.getElementById('desktop-frame').contentWindow,
    data: { type: 'codex-desktop', state: 'disconnected', frame },
  })), oldFrame);
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await expect(second.getByRole('button', { name: '在这里继续使用' })).toBeVisible({ timeout: 10000 });
  await second.close();
});

test('a takeover replaces a pending poll and ignores its stale ownership response', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('demo_password_for_tests');
  await page.getByRole('button', { name: '连接工作空间' }).click();
  const canvas = page.frameLocator('#desktop-frame').locator('#screen canvas');
  await expect(canvas).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
  await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });

  let release, ready, delivered, captured = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { ready = resolve; });
  const staleDelivered = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/state', async route => {
    if (captured) return route.continue();
    captured = true;
    const response = await route.fetch();
    ready(await response.json());
    await gate;
    try { await route.fulfill({ response }); }
    finally { delivered(); }
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect((await pending).mine).toBe(false);
    await page.locator('#takeover-button').click();
    // The new viewer must connect even while the old snapshot is withheld.
    await expect(canvas).toBeVisible();
    release();
    await staleDelivered;
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state') && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect((await (await refreshed).json()).mine).toBe(true);
    await expect(canvas).toBeVisible();
    await expect(page.locator('#desktop-overlay')).toBeHidden();
  } finally {
    release();
    await second.close();
  }
});
