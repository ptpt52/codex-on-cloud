import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
async function open(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click();
}
const select = (page, name = '资料.txt') => page.locator('#upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('new content') });
const writes = app => app.received.filter(r => r.method === 'PUT' && r.url.startsWith('/files/'));

test('files provide full paths with manual copy fallback and add a quoted path to the existing draft without sending', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  const name = "资料 '$(never)`never`.txt", fullPath = '/test-workspace/transfer/' + name;
  app.files.set(name, Buffer.from('content'));
  await page.addInitScript(() => { window.copiedPaths = []; window.rejectPathCopy = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.rejectPathCopy) throw Error('denied'); window.copiedPaths.push(text); } } });
  });
  try {
    await open(page, app); await page.locator('#close-files').click();
    await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('请读取这个文件');
    await page.locator('#close-input-button').click();
    const frameURL = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#files-button').click();
    const row = page.locator('.file-row').filter({ hasText: name });
    await row.getByRole('button', { name: /复制.*服务器路径/ }).click();
    expect(await page.evaluate(() => window.copiedPaths)).toEqual([fullPath]);
    await page.evaluate(() => { window.rejectPathCopy = true; });
    await row.getByRole('button', { name: /复制.*服务器路径/ }).click();
    await expect(page.locator('#file-path-preview')).toHaveValue(fullPath);
    expect(await page.locator('#file-path-preview').evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, fullPath.length]);
    await row.getByRole('button', { name: /加入输入草稿/ }).click();
    await expect(page.locator('#files-dialog')).toBeHidden();
    await expect(page.locator('#mobile-input')).toHaveValue("请读取这个文件\n'/test-workspace/transfer/资料 '\\''$(never)`never`.txt'");
    await expect(page.locator('#mobile-input')).toBeFocused();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(frameURL);
    expect(app.inputCalls).toEqual([]); expect(writes(app)).toHaveLength(0); expect(app.managementStats.restarts).toBe(0);
    await page.locator('#mobile-input').fill('x'.repeat(32768));
    await page.locator('#files-button').click();
    await row.getByRole('button', { name: /加入输入草稿/ }).click();
    await expect(page.locator('#toast')).toContainText('超过 32 KiB');
    await expect(page.locator('#files-dialog')).toBeVisible();
    await expect(page.locator('#mobile-input')).toHaveValue('x'.repeat(32768));
    await expect(page.locator('#open-transfer-directory')).toBeHidden();
  } finally { await app.close(); }
});

test('dropping files uses the same single-file upload and explicit conflict confirmation', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('资料.txt', Buffer.from('original'));
  const drop = names => page.locator('#upload-zone').evaluate((zone, names) => {
    const dataTransfer = new DataTransfer(); for (const name of names) dataTransfer.items.add(new File(['dropped content'], name, { type: 'text/plain' }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, names);
  try {
    await open(page, app);
    const chooser = page.waitForEvent('filechooser'); await page.locator('#upload-zone').press('Enter');
    await (await chooser).setFiles([]);
    await drop(['one.txt', 'two.txt']);
    await expect(page.locator('#toast')).toContainText('每次请拖入一个文件'); expect(writes(app)).toHaveLength(0);
    await drop(['资料.txt']); await expect(page.locator('#file-conflict-dialog')).toBeVisible();
    expect(writes(app)).toHaveLength(0); expect(app.files.get('资料.txt').toString()).toBe('original');
    await page.locator('#file-conflict-rename').click();
    await expect(page.locator('#upload-status')).toContainText('上传完成：资料 (2).txt');
    expect(app.files.get('资料.txt').toString()).toBe('original'); expect(app.files.get('资料 (2).txt').toString()).toBe('dropped content');
    expect(writes(app)).toHaveLength(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a delayed copy failure cannot restore a path preview after closing and reopening files', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('old.txt', Buffer.from('content'));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: () => new Promise((_resolve, reject) => { window.rejectFileCopy = () => reject(Error('denied')); }),
  } }));
  try {
    await open(page, app); await page.getByRole('button', { name: '复制 old.txt 的服务器路径' }).click();
    await expect.poll(() => page.evaluate(() => typeof window.rejectFileCopy)).toBe('function');
    await page.locator('#close-files').click(); await page.locator('#files-button').click();
    await page.evaluate(() => window.rejectFileCopy());
    await expect(page.getByRole('button', { name: '复制 old.txt 的服务器路径' })).toBeEnabled();
    await expect(page.locator('#file-path-fallback')).toBeHidden();
    await expect(page.locator('#file-path-preview')).toHaveValue('');
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop transfer directory opens through one fixed authorized action and keeps the viewer and tasks', async ({ page }) => {
  const app = await fixture({ rfb: true }); const actions = [];
  page.on('request', request => { if (request.url().endsWith('/api/desktop/transfer-directory')) actions.push(request.postDataJSON()); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    const frameURL = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#files-button').click(); await page.locator('#open-transfer-directory').click();
    await expect(page.locator('#files-dialog')).toBeHidden();
    expect(app.managementStats.folderOpens).toBe(1); expect(actions).toEqual([{}]);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(frameURL);
  } finally { await app.close(); }
});

test('same-name upload defaults to cancel and offers accessible rename and versioned replacement', async ({ page }, info) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('资料.txt', Buffer.from('original'));
  try {
    await open(page, app); await select(page);
    const dialog = page.locator('#file-conflict-dialog'); await expect(dialog).toBeVisible();
    await expect(page.locator('#file-conflict-cancel')).toBeFocused();
    expect(writes(app)).toHaveLength(0);
    await page.keyboard.press('Enter'); await expect(dialog).toBeHidden(); await expect(page.locator('#upload-status')).toContainText('已取消');
    expect(app.files.get('资料.txt').toString()).toBe('original'); expect(writes(app)).toHaveLength(0);
    await select(page); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await expect(page.locator('#upload-input')).toBeEnabled(); await select(page); await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 320, height: 740 });
    for (const id of ['cancel', 'rename', 'replace']) {
      const box = await page.locator('#file-conflict-' + id).boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    await page.screenshot({ path: `test-results/${info.project.name}-file-conflict.png` });
    await page.locator('#file-conflict-rename').click(); await expect(page.locator('#upload-status')).toContainText('上传完成：资料 (2).txt');
    expect(app.files.get('资料.txt').toString()).toBe('original'); expect(app.files.get('资料 (2).txt').toString()).toBe('new content');
    await select(page); await expect(dialog).toBeVisible(); await page.locator('#file-conflict-replace').click();
    await expect(page.locator('#upload-status')).toContainText('上传完成：资料.txt'); expect(app.files.get('资料.txt').toString()).toBe('new content');
    expect(writes(app)).toHaveLength(2); expect(writes(app)[1].headers['if-match']).toMatch(/^"[a-f0-9]{64}"$/);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a file changed during confirmation is preserved and replacement is not retried', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('资料.txt', Buffer.from('original'));
  try {
    await open(page, app); await select(page); await expect(page.locator('#file-conflict-dialog')).toBeVisible();
    app.files.set('资料.txt', Buffer.from('updated by another client'));
    await page.locator('#file-conflict-replace').click(); await expect(page.locator('#upload-status')).toContainText('原文件已变化');
    await expect(page.locator('#upload-input')).toBeEnabled(); expect(app.files.get('资料.txt').toString()).toBe('updated by another client'); expect(writes(app)).toHaveLength(0);
    await page.waitForTimeout(500); expect(writes(app)).toHaveLength(0);
  } finally { await app.close(); }
});

test('new-file race and old file service both fail safely without overwriting', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await open(page, app);
    await page.route('**/api/files/*', async route => { if (route.request().method() === 'PUT') app.files.set('资料.txt', Buffer.from('created after listing')); await route.continue(); });
    await select(page); await expect(page.locator('#upload-status')).toContainText('已有同名文件'); expect(app.files.get('资料.txt').toString()).toBe('created after listing'); expect(writes(app)).toHaveLength(0);
    await page.route('**/api/files', route => route.fulfill({ json: { files: [] } }));
    await select(page, 'old-helper.txt'); await expect(page.locator('#upload-status')).toContainText('文件服务需要更新'); expect(writes(app)).toHaveLength(0);
  } finally { await app.close(); }
});

test('offline cancels a pending upload decision and reconnect sends no upload', async ({ page, context }) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('资料.txt', Buffer.from('original'));
  try {
    await open(page, app); await select(page); await expect(page.locator('#file-conflict-dialog')).toBeVisible();
    await context.setOffline(true); await expect(page.locator('#file-conflict-dialog')).toBeHidden(); await expect(page.locator('#upload-status')).toContainText('已取消');
    await context.setOffline(false); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(writes(app)).toHaveLength(0); expect(app.files.get('资料.txt').toString()).toBe('original');
  } finally { await context.setOffline(false); await app.close(); }
});

test('lost HTTP completion never replays a committed upload', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let puts = 0;
  try {
    await open(page, app);
    page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/files/')) puts++; });
    // Keep the browser's File body intact. WebKit cannot expose File bytes to
    // route.fetch(); discard only the application's completion instead.
    await page.evaluate(() => { const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args); if (args[1]?.method === 'PUT' && String(args[0]).startsWith('/api/files/')) throw new TypeError('injected completion loss'); return response; }; });
    await select(page); await expect(page.locator('#upload-status')).toContainText('不会自动重试'); await expect(page.locator('#upload-input')).toBeEnabled();
    await page.waitForTimeout(500); expect(puts).toBe(1); expect(writes(app)).toHaveLength(1); expect(app.files.get('资料.txt').toString()).toBe('new content');
  } finally { await app.close(); }
});

test('expired confirmation cancels without sending file bytes', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); app.files.set('资料.txt', Buffer.from('original'));
  try {
    await open(page, app); await page.clock.install(); await select(page); await expect(page.locator('#file-conflict-dialog')).toBeVisible();
    await page.clock.fastForward(120001); await expect(page.locator('#file-conflict-dialog')).toBeHidden(); await expect(page.locator('#upload-status')).toContainText('确认已过期');
    expect(writes(app)).toHaveLength(0); expect(app.files.get('资料.txt').toString()).toBe('original');
  } finally { await app.close(); }
});

test('incomplete successful upload completion remains unknown and never retries', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await open(page, app);
    await page.evaluate(() => { const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args); if (args[1]?.method === 'PUT' && String(args[0]).startsWith('/api/files/')) { await response.arrayBuffer(); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); } return response; }; });
    await select(page); await expect(page.locator('#upload-status')).toContainText('完成信息不完整，结果未知'); await expect(page.locator('#upload-status')).not.toContainText('上传完成：');
    await expect(page.locator('#upload-input')).toBeEnabled(); await page.waitForTimeout(500);
    expect(writes(app)).toHaveLength(1); expect(app.files.get('资料.txt').toString()).toBe('new content');
  } finally { await app.close(); }
});

test('a successful upload with a failed list refresh still reports completion', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await open(page, app);
    await page.route('**/api/files', route => app.files.has('资料.txt') ? route.fulfill({ status: 503, json: { error: 'list unavailable' } }) : route.continue());
    await select(page); await expect(page.locator('#upload-status')).toContainText('上传完成：资料.txt；列表刷新失败');
    expect(writes(app)).toHaveLength(1); expect(app.files.get('资料.txt').toString()).toBe('new content');
  } finally { await app.close(); }
});

test('stalled post-upload refresh obeys the overall deadline and releases the file input', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let refreshStarted = false, release;
  const waiting = new Promise(resolve => { release = resolve; });
  try {
    await open(page, app); await page.clock.install();
    await page.route('**/api/files', async route => { if (app.files.has('资料.txt')) { refreshStarted = true; await waiting; } await route.continue().catch(() => {}); });
    await select(page); await expect(page.locator('#upload-status')).toContainText('上传完成'); await expect.poll(() => refreshStarted).toBe(true);
    await page.clock.fastForward(300001); await expect(page.locator('#upload-status')).toContainText('上传完成：资料.txt；列表刷新失败'); await expect(page.locator('#upload-input')).toBeEnabled();
    expect(writes(app)).toHaveLength(1); expect(app.files.get('资料.txt').toString()).toBe('new content');
  } finally { release(); await app.close(); }
});
