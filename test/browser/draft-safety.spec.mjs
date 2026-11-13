import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
const nodeId = 'a'.repeat(32);
async function setup(page, denied = true) {
  await page.addInitScript(denied => {
    if (window !== parent) return;
    window.denyDrafts = denied;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage && String(key).startsWith('codex-cloud.terminals.v1') && window.denyDrafts) throw new DOMException('quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } });
  }, denied);
  const app = await fixture({ mode: 'terminal', sharedEntry: true, nodeId, gatewayNode: { name: 'draft-test' } });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线'); await openInput(page);
  await page.locator('#mobile-input').fill('中文草稿\n不能丢失');
  return app;
}
const unloadBlocked = page => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });

test('persisted drafts show their save state and need no additional leave guard', async ({ page }) => {
  const app = await setup(page, false);
  try {
    await expect(page.locator('#draft-save-state')).toContainText('已保存在'); expect(await unloadBlocked(page)).toBe(false);
    await page.locator('#draft-backup-button').click(); await expect(page.locator('#draft-leave-title')).toHaveText('备份本节点草稿');
    await expect(page.locator('#confirm-draft-leave')).toBeHidden(); await page.locator('#cancel-draft-leave').click();
    await page.locator('#copy-draft').click();
    expect(await page.locator('#mobile-input').evaluate(field => [field.selectionStart, field.selectionEnd])).toEqual([0, '中文草稿\n不能丢失'.length]);
    await page.locator('#logout-button').click(); await expect(page.locator('#action-confirmation')).toBeVisible();
    await expect(page.locator('#draft-leave-dialog')).toBeHidden();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('failed draft persistence offers copy and bounded export before logout, with no automatic input or leave', async ({ page }, info) => {
  const app = await setup(page); let logouts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/logout') logouts++; });
  try {
    await expect(page.locator('#draft-save-state')).toContainText('仅在当前页面'); expect(await unloadBlocked(page)).toBe(true);
    await page.locator('#logout-button').click(); await expect(page.locator('#draft-leave-dialog')).toBeVisible();
    await expect(page.locator('#cancel-draft-leave')).toBeFocused(); expect(logouts).toBe(0);
    await page.screenshot({ path: info.outputPath('draft-protection.png') });
    await page.locator('#copy-leave-draft').click(); await expect(page.locator('#draft-leave-preview')).toHaveValue('中文草稿\n不能丢失');
    expect(await page.locator('#draft-leave-preview').evaluate(field => [field.selectionStart, field.selectionEnd])).toEqual([0, '中文草稿\n不能丢失'.length]);
    const downloadEvent = page.waitForEvent('download'); await page.locator('#export-leave-drafts').click();
    const download = await downloadEvent, stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks)); expect(data.nodeId).toBe(nodeId); expect(data.drafts.some(draft => draft.text === '中文草稿\n不能丢失')).toBe(true);
    expect(Object.keys(data).sort()).toEqual(['drafts', 'nodeId', 'selection', 'version']);
    await expect(page.locator('#draft-leave-dialog')).toBeVisible(); expect(logouts).toBe(0);
    await page.keyboard.press('Escape'); await expect(page.locator('#draft-leave-dialog')).toBeHidden();
    await expect(page.locator('#mobile-input')).toHaveValue('中文草稿\n不能丢失');
    await page.locator('#logout-button').click(); await page.locator('#confirm-draft-leave').click();
    await expect(page.locator('#login-view')).toBeVisible(); expect(logouts).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('node navigation stays put until unsaved drafts are explicitly acknowledged, without a second unload prompt', async ({ page }) => {
  const app = await setup(page); const prompts = [];
  page.on('dialog', async dialog => { prompts.push(dialog.type()); await dialog.dismiss(); });
  try {
    await page.route('**/__nodes/', route => route.fulfill({ contentType: 'text/html', body: '<title>node chooser</title><p>节点选择</p>' }));
    const url = page.url(); await closePanels(page); await openTools(page); await page.locator('#gateway-switch-button').click();
    await expect(page.locator('#draft-leave-dialog')).toBeVisible(); expect(page.url()).toBe(url);
    await page.locator('#cancel-draft-leave').click(); expect(page.url()).toBe(url);
    await page.locator('#gateway-switch-button').click(); await page.locator('#confirm-draft-leave').click();
    await expect(page).toHaveURL(/\/__nodes\/$/); expect(prompts).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('successful draft persistence after a quota recovery removes the leave warning', async ({ page }) => {
  const app = await setup(page);
  try {
    expect(await unloadBlocked(page)).toBe(true);
    await page.evaluate(() => { window.denyDrafts = false; }); await page.locator('#mobile-input').fill('空间恢复后的草稿');
    await expect(page.locator('#draft-save-state')).toContainText('已保存在'); expect(await unloadBlocked(page)).toBe(false);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('codex-cloud.terminals.v1.' + 'a'.repeat(32))).drafts.some(draft => draft.text === '空间恢复后的草稿'))).toBe(true);
  } finally { await app.close(); }
});

test('desktop Chrome reload uses the native beforeunload prompt and keeps the draft when canceled', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium' || info.project.use.isMobile, 'Native reload prompt checked in desktop Chrome; station guards are covered across engines and touch layouts');
  const app = await setup(page);
  try {
    // Use the normal browser reload path and keep its dialog listener installed
    // throughout cancellation, without a second navigation command.
    const prompt = new Promise(resolve => page.on('dialog', async dialog => { const type = dialog.type(); await dialog.dismiss(); resolve(type); }));
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    expect(await prompt).toBe('beforeunload');
    await expect(page.locator('#mobile-input')).toHaveValue('中文草稿\n不能丢失');
    await expect(page.locator('#workspace-view')).toBeVisible(); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
