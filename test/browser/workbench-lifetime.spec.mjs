import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click();
}
async function restoreCachedPage(page) {
  const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
  const transition = (target, type) => target.evaluate(type => dispatchEvent(new PageTransitionEvent(type, { persisted: true })), type);
  await transition(frame, 'pagehide');
  await transition(page, 'pagehide');
  await transition(page, 'pageshow');
  await transition(frame, 'pageshow');
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
test('a previous path copy cannot unlock or replace a newer copy after reopening files', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await page.addInitScript(() => {
      window.pathCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((resolve, reject) => window.pathCopies.push({ resolve, reject })) } });
    });
    app.files.set('first.txt', Buffer.from('one')); app.files.set('second.txt', Buffer.from('two'));
    await login(page, app); await page.getByRole('button', { name: '复制 first.txt 的服务器路径' }).click();
    await expect.poll(() => page.evaluate(() => window.pathCopies.length)).toBe(1);
    await page.locator('#close-files').click(); await page.locator('#files-button').click();
    const next = page.getByRole('button', { name: '复制 second.txt 的服务器路径' }); await expect(next).toBeEnabled(); await next.press('Enter');
    await expect.poll(() => page.evaluate(() => window.pathCopies.length)).toBe(2);
    await page.evaluate(() => window.pathCopies[0].reject(Error('old denied')));
    await expect(next).toBeDisabled(); await expect(next).toBeFocused(); await expect(page.locator('#file-path-fallback')).toBeHidden();
    await next.press('Enter'); expect(await page.evaluate(() => window.pathCopies.length)).toBe(2);
    await page.evaluate(() => window.pathCopies[1].resolve()); await expect(next).toBeEnabled();
    await expect(next).toBeFocused(); await expect(page.locator('#file-list-status')).toContainText('已复制'); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
test('leaving during an upload never replays it and its late response cannot release a newer transfer', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let writes = 0;
  try {
    await login(page, app);
    page.on('request', request => { if (request.method() === 'PUT') writes++; });
    await page.evaluate(() => {
      const original = fetch; window.uploadResponses = [];
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (args[1]?.method === 'PUT') await new Promise(resolve => window.uploadResponses.push(resolve));
        return response;
      };
    });
    await page.locator('#upload-input').setInputFiles({ name: 'first.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('one') });
    await expect.poll(() => page.evaluate(() => window.uploadResponses.length)).toBe(1);
    await restoreCachedPage(page);
    await expect(page.locator('#upload-status')).toContainText('结果未确认'); await expect(page.locator('#upload-input')).toBeEnabled();
    await expect(page.locator('#upload-input')).toHaveValue('');
    await page.locator('#upload-input').setInputFiles({ name: 'second.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('two') });
    await expect.poll(() => page.evaluate(() => window.uploadResponses.length)).toBe(2);
    await page.evaluate(() => window.uploadResponses[0]()); await expect(page.locator('#upload-input')).toBeDisabled();
    await expect(page.locator('#upload-status')).not.toContainText('上传完成');
    await page.evaluate(() => window.uploadResponses[1]()); await expect(page.locator('#upload-status')).toContainText('上传完成：second.bin');
    await expect(page.locator('#upload-input')).toBeEnabled(); expect(writes).toBe(2);
    expect(app.files.get('first.bin').toString()).toBe('one'); expect(app.files.get('second.bin').toString()).toBe('two'); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

for (const operation of ['upload', 'delete']) test(`cached return preserves a confirmed ${operation} when the list refresh is still pending`, async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  const deleting = operation === 'delete', name = 'confirmed.txt';
  const expected = `${deleting ? '已删除' : '上传完成'}：${name}`;
  let release, refreshing = false;
  const holdRefresh = new Promise(resolve => { release = resolve; });
  if (deleting) app.files.set(name, Buffer.from('original'));
  try {
    await login(page, app);
    await page.route(/\/api\/files\?page=/, async route => {
      if (app.files.has(name) !== deleting) { refreshing = true; await holdRefresh; }
      await route.continue().catch(() => {});
    });
    if (deleting) {
      await page.getByRole('button', { name: `删除 ${name}`, exact: true }).click();
      await page.locator('#file-delete-confirm').click();
    } else {
      await page.locator('#upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('uploaded') });
    }
    const status = page.locator('#upload-status');
    await expect(status).toHaveText(expected);
    await expect.poll(() => refreshing).toBe(true);
    await expect(page.locator('#upload-input')).toBeDisabled();

    await restoreCachedPage(page);
    release();
    await expect(page.locator('#upload-input')).toBeEnabled();
    await expect(status).toHaveText(expected);
    expect(app.received.filter(request => request.method === (deleting ? 'DELETE' : 'PUT') && request.url === `/files/${name}`)).toHaveLength(1);
    expect(app.files.has(name)).toBe(!deleting);
  } finally { release(); await app.close(); }
});

test('leaving an upload confirmation reports cancellation before sending any file content', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  app.files.set('conflict.txt', Buffer.from('original'));
  try {
    await login(page, app);
    await page.locator('#upload-input').setInputFiles({ name: 'conflict.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
    await expect(page.locator('#file-conflict-dialog')).toBeVisible();
    await restoreCachedPage(page);
    await expect(page.locator('#file-conflict-dialog')).toBeHidden();
    await expect(page.locator('#upload-status')).toContainText('已取消');
    await expect(page.locator('#upload-input')).toBeEnabled();
    expect(app.received.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(app.files.get('conflict.txt').toString()).toBe('original');
  } finally { await app.close(); }
});

test('signing out clears the previous session’s file rows and result', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await login(page, app);
    await page.locator('#upload-input').setInputFiles({ name: 'previous.txt', mimeType: 'text/plain', buffer: Buffer.from('content') });
    await expect(page.locator('#upload-status')).toHaveText('上传完成：previous.txt');
    await expect(page.getByRole('link', { name: '下载 previous.txt' })).toBeVisible();
    await page.locator('#close-files').click();
    await page.locator('#logout-button').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#file-list .file-row')).toHaveCount(0);
    await expect(page.locator('#upload-status')).toHaveText('');
    expect(app.files.get('previous.txt').toString()).toBe('content');
  } finally { await app.close(); }
});
