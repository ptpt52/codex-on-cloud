import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
async function login(page, app) { await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('终端在线'); }

test('a stalled directory read times out and can be refreshed without replaying uploads', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let release, stall = true;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    app.files.set('kept.txt', Buffer.from('kept')); await login(page, app); await page.clock.install();
    await page.route('**/api/files', async route => { if (stall) { await gate; await route.fulfill({ json: { files: [] } }).catch(() => {}); } else await route.continue(); });
    await page.locator('#files-button').click(); await expect(page.locator('#file-list-status')).toContainText('正在读取');
    await page.clock.fastForward(8001); await expect(page.locator('#file-list-status')).toContainText('读取文件列表超时'); await expect(page.locator('#files-button')).toBeEnabled();
    stall = false; await page.locator('#refresh-files').click(); await expect(page.locator('#file-list')).toContainText('kept.txt');
    expect(app.received.filter(req => req.method === 'PUT')).toHaveLength(0); expect(app.inputCalls).toEqual([]);
  } finally { release(); await app.close(); }
});

test('closing the directory cancels its read and allows immediate reopening', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let release, stall = true;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    app.files.set('kept.txt', Buffer.from('kept')); await login(page, app);
    await page.route('**/api/files', async route => { if (stall) { await gate; await route.abort().catch(() => {}); } else await route.continue(); });
    await page.locator('#files-button').click(); await expect(page.locator('#file-list-status')).toContainText('正在读取');
    await page.locator('#close-files').click(); await expect(page.locator('#files-button')).toBeEnabled({ timeout: 1500 });
    stall = false; await page.locator('#files-button').click(); await expect(page.locator('#file-list')).toContainText('kept.txt');
  } finally { release(); await app.close(); }
});

test('existing long names work while unsupported names visibly disable their actions', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }), name = '中'.repeat(81) + '.txt';
  try {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.filePathCopied = text; } } }));
    app.files.set(name, Buffer.from('kept')); app.files.set('bad-\nname', Buffer.from('unsafe')); app.files.set('undecodable-\udcff', Buffer.from('unsafe'));
    await login(page, app); await page.locator('#files-button').click();
    const normal = page.locator('.file-row').filter({ hasText: name });
    await expect(normal.locator('[data-file-copy]')).toBeEnabled(); await normal.locator('[data-file-copy]').click();
    await expect.poll(() => page.evaluate(() => window.filePathCopied)).toContain('/' + name);
    for (const prefix of ['bad-', 'undecodable-']) {
      const row = page.locator('.file-row').filter({ hasText: prefix });
      await expect(row).toContainText('请在节点主机改名');
      await expect(row.locator('a')).toHaveAttribute('aria-disabled', 'true');
      await expect(row.locator('a')).not.toHaveAttribute('href');
      await expect(row.locator('[data-file-copy]')).toBeDisabled();
      await expect(row.locator('[data-file-insert]')).toBeDisabled();
    }
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
