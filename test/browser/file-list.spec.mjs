import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
async function login(page, app) { await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('终端在线'); }

test('desktop file transfer stays in the visual viewport with a reachable close control', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    app.files.set('handoff.txt', Buffer.from('sample'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const viewport = new EventTarget();
      Object.assign(viewport, { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
      Object.defineProperty(window, 'visualViewport', { value: viewport });
    });
    await page.goto(app.config.origin);
    await page.locator('#password').fill(app.config.password);
    await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#files-button').click();
    await expect(page.locator('#file-list')).toContainText('handoff.txt');
    await page.evaluate(() => {
      Object.assign(visualViewport, { width: 254, height: 400, offsetLeft: 12, offsetTop: 40 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    const dialog = page.locator('#files-dialog'), close = page.locator('#close-files');
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 12 && box.x + box.width <= 266 && box.y >= 40 && box.y + box.height <= 440;
    }).toBe(true);
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(close).toBeInViewport();
    const closeBox = await close.boundingBox();
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(440);
    await close.click();
    await expect(dialog).toBeHidden();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('an invalid file drop reports the error inside the open transfer dialog', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await login(page, app);
    const dialog = page.locator('#files-dialog');
    await page.locator('#files-button').click();
    await dialog.evaluate(el => {
      const files = [new File(['a'], 'first.txt'), new File(['b'], 'second.txt')];
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, items: files } });
      el.dispatchEvent(event);
    });
    const status = page.locator('#upload-status');
    await expect(status).toContainText('每次请拖入一个文件');
    await expect(status).toBeInViewport();
    await expect(dialog).toBeVisible();
    expect(app.received.filter(value => value.method === 'PUT')).toEqual([]);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('each download link announces its file name', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    for (const name of ['交接文件.txt', '另一份文件.txt']) app.files.set(name, Buffer.from('sample'));
    await login(page, app); await page.locator('#files-button').click();
    const list = page.locator('#file-list');
    for (const name of ['交接文件.txt', '另一份文件.txt']) {
      const link = list.getByRole('link', { name: `下载 ${name}`, exact: true });
      await expect(link).toHaveText('下载');
      await expect(link).toHaveAttribute('download', name);
    }
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a stalled directory read times out and can be refreshed without replaying uploads', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let release, stall = true;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    app.files.set('kept.txt', Buffer.from('kept')); await login(page, app); await page.clock.install();
    await page.route(/\/api\/files(?:\?.*)?$/, async route => { if (stall) { await gate; await route.fulfill({ json: { files: [] } }).catch(() => {}); } else await route.continue(); });
    await page.locator('#files-button').click(); await expect(page.locator('#file-list-status')).toContainText('正在读取');
    await page.clock.fastForward(8001); await expect(page.locator('#file-list-status')).toContainText('读取文件列表超时'); await expect(page.locator('#files-button')).toBeEnabled();
    const refresh = page.locator('#refresh-files');
    stall = false; await refresh.press('Enter'); await expect(page.locator('#file-list')).toContainText('kept.txt');
    await expect(refresh).toBeEnabled(); await expect(refresh).toBeFocused();
    expect(app.received.filter(req => req.method === 'PUT')).toHaveLength(0); expect(app.inputCalls).toEqual([]);
  } finally { release(); await app.close(); }
});

test('closing the directory cancels its read and allows immediate reopening', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let release, stall = true;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    app.files.set('kept.txt', Buffer.from('kept')); await login(page, app);
    await page.route(/\/api\/files(?:\?.*)?$/, async route => { if (stall) { await gate; await route.abort().catch(() => {}); } else await route.continue(); });
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
      await expect(row.locator('[data-file-delete]')).toBeDisabled();
    }
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('administrator deletion defaults to cancel, checks the selected version and refreshes confirmed success', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }), name = "资料 '$(never).txt";
  try {
    app.files.set(name, Buffer.from('original')); app.files.set('keep.txt', Buffer.from('keep'));
    await login(page, app); await page.locator('#files-button').click();
    const remove = page.getByRole('button', { name: `删除 ${name}`, exact: true }), dialog = page.locator('#file-delete-dialog');
    await remove.press('Enter'); await expect(dialog).toBeVisible(); await expect(page.locator('#file-delete-name')).toHaveText(name);
    await expect(page.locator('#file-delete-cancel')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    await remove.press('Enter'); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(app.received.filter(req => req.method === 'DELETE')).toHaveLength(0);
    await remove.click(); app.files.set(name, Buffer.from('newer'));
    await page.locator('#file-delete-confirm').click(); await expect(page.locator('#upload-status')).toContainText('文件已变化');
    expect(app.files.get(name).toString()).toBe('newer');
    await page.locator('#refresh-files').click(); await remove.click(); await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#upload-status')).toContainText(`已删除：${name}`);
    await expect(remove).toHaveCount(0); expect(app.files.get('keep.txt').toString()).toBe('keep');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a lost deletion reply is not replayed and the file list can be checked manually', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let calls = 0;
  try {
    app.files.set('delete.txt', Buffer.from('delete')); await login(page, app);
    await page.route('**/api/files/delete', async route => { calls++; await route.fetch(); await route.abort(); });
    await page.locator('#files-button').click(); await page.getByRole('button', { name: '删除 delete.txt', exact: true }).click();
    await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#upload-status')).toContainText('删除结果未确认'); expect(calls).toBe(1); expect(app.files.has('delete.txt')).toBe(false);
    await page.locator('#refresh-files').click(); await expect(page.locator('#file-list')).toContainText('还没有中转文件');
    expect(calls).toBe(1); expect(app.received.filter(req => req.method === 'DELETE')).toHaveLength(1);
  } finally { await app.close(); }
});

test('an uncertain service deletion stays unknown without retrying through HTTPS', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', webrtc: true }); let deletes = 0, publicDeletes = 0;
  app.files.set('uncertain.txt', Buffer.from('file'));
  const helper = http.createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    if (req.method === 'DELETE') {
      deletes++; app.files.delete('uncertain.txt'); res.writeHead(503);
      return res.end(JSON.stringify({ error: '保存状态无法确认' }));
    }
    res.end(JSON.stringify({ deleteProtocol: 1, files: [...app.files].map(([name, bytes]) => ({ name, size: bytes.length, modified: 1, version: 'a'.repeat(64) })) }));
  });
  helper.listen(0, '127.0.0.1'); await once(helper, 'listening'); app.config.fileAgentUrl = 'http://127.0.0.1:' + helper.address().port;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/files/delete')) publicDeletes++; });
  try {
    await login(page, app); await page.locator('#files-button').click();
    await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /, { timeout: 15000 });
    await page.getByRole('button', { name: '删除 uncertain.txt', exact: true }).click(); await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#upload-status')).toContainText('删除结果未确认');
    expect(deletes).toBe(1); expect(publicDeletes).toBe(0); expect(app.files.has('uncertain.txt')).toBe(false);
    await page.locator('#refresh-files').click(); await expect(page.locator('#file-list')).toContainText('还没有中转文件');
    expect(deletes).toBe(1); expect(publicDeletes).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); await new Promise(resolve => { helper.close(resolve); helper.closeAllConnections(); }); }
});

test('deletion confirmation expires or cancels offline, and older helpers cannot enable deletion', async ({ page, context }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    app.files.set('keep.txt', Buffer.from('keep')); await login(page, app); await page.clock.install();
    await page.locator('#files-button').click(); const remove = page.getByRole('button', { name: '删除 keep.txt', exact: true });
    await remove.click(); await page.clock.fastForward(120001); await expect(page.locator('#file-delete-dialog')).toBeHidden();
    await remove.click(); await context.setOffline(true); await expect(page.locator('#file-delete-dialog')).toBeHidden();
    await context.setOffline(false); await page.locator('#refresh-files').click();
    await page.route(/\/api\/files(?:\?.*)?$/, async route => { const response = await route.fetch(), body = await response.json(); delete body.deleteProtocol; await route.fulfill({ json: body }); });
    await page.locator('#refresh-files').click(); await expect(remove).toBeDisabled(); await expect(remove).toHaveAttribute('title', /更新/);
    expect(app.received.filter(req => req.method === 'DELETE')).toHaveLength(0); expect(app.files.has('keep.txt')).toBe(true);
  } finally { await context.setOffline(false); await app.close(); }
});

test('temporary file sharing hides deletion controls', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await app.login(); await app.claim(); await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password' } });
    app.files.set('shared.txt', Buffer.from('shared'));
    await page.goto(app.config.origin); await page.locator('#username').fill('visitor'); await page.locator('#password').fill('temporary-test-password'); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('临时访问'); await page.locator('#files-button').click();
    await expect(page.locator('#file-list')).toContainText('shared.txt'); await expect(page.locator('[data-file-delete]')).toBeHidden();
    expect(app.received.filter(req => req.method === 'DELETE')).toHaveLength(0);
  } finally { await app.close(); }
});
