import { test, expect } from '@playwright/test';
import { gatewayHTTPFixture } from '../gateway-http-fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
async function control(page, h) {
  if (!page.url().includes('/__nodes/')) await page.goto(h.origin + '/__nodes/');
  await expect.poll(async () => await page.locator('#login').isVisible() || await page.locator('#workspace').isVisible()).toBe(true);
  if (await page.locator('#login').isVisible()) { await page.locator('#password').fill(h.password); await page.locator('#login-submit').click(); }
  await expect(page.locator('#workspace')).toBeVisible();
}
async function choose(page, node) {
  await page.locator(`[data-node-id="${node.gatewayEntry.id}"] [data-action="select"]`).click(); await expect(page.locator('#confirmation')).toBeVisible();
  await expect(page.locator('#cancel')).toBeFocused(); await page.locator('#accept').click();
}
async function nodeLogin(page, app) {
  await expect(page.locator('#login-view')).toBeVisible(); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
async function leaveNode(page) { if (await page.locator('#files-dialog').isVisible()) await page.locator('#close-files').click(); await closePanels(page); await openTools(page); await page.locator('#gateway-switch-button').click(); await expect(page).toHaveURL(/\/__nodes\//); }

test('web selection keeps one URL while independent logins and same-pane drafts survive A to B to A', async ({ page, context }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2);
  try {
    await control(page, h); await expect(page.locator('#nodes .node-row')).toHaveCount(2); await choose(page, a); await nodeLogin(page, a);
    await expect(page.locator('#portal-settings-button, #servers-button, #portal-settings-dialog, #servers-dialog')).toHaveCount(0);
    await openInput(page); await page.locator('#mobile-input').fill('节点 A 的草稿'); await leaveNode(page);
    await control(page, h); await choose(page, b); await nodeLogin(page, b); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('节点 B 的草稿'); await leaveNode(page); await control(page, h); await choose(page, a);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('节点 A 的草稿');
    const cookies = await context.cookies(h.origin); expect(cookies.filter(cookie => cookie.name.startsWith('coc_session_'))).toHaveLength(2);
    expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]); expect(a.managementStats.restarts + b.managementStats.restarts).toBe(0);
  } finally { await h.close(); }
});

test('an unavailable active node leaves the independent selector reachable and an unavailable target cannot replace it', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    a.backendOnline = false; await page.goto(h.origin); await expect(page).toHaveURL(/\/__nodes\//); await control(page, h);
    b.backendOnline = false; await choose(page, b); await expect(page.locator('#status')).toContainText('未就绪');
    expect(h.storage.value.activeId).toBe(a.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
    b.backendOnline = true; await choose(page, b); await nodeLogin(page, b); expect(h.storage.value.activeId).toBe(b.gatewayEntry.id);
  } finally { await h.close(); }
});

test('file bytes stream to the selected node and a stale download cannot read another node with a valid login', async ({ page, context }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    await page.goto(h.origin); await nodeLogin(page, a); await page.locator('#files-button').click();
    await page.locator('#upload-input').setInputFiles({ name: 'node.txt', mimeType: 'text/plain', buffer: Buffer.from('content A') }); await expect(page.locator('#upload-status')).toContainText('上传完成：node.txt');
    const oldLink = await page.locator('#file-list a').getAttribute('href'); const first = await context.request.get(h.origin + oldLink); expect(first.status()).toBe(200); expect(await first.text()).toBe('content A');
    await leaveNode(page); await control(page, h); await choose(page, b); await nodeLogin(page, b); await page.locator('#files-button').click();
    await page.locator('#upload-input').setInputFiles({ name: 'node.txt', mimeType: 'text/plain', buffer: Buffer.from('content B') }); await expect(page.locator('#upload-status')).toContainText('上传完成：node.txt');
    const fresh = await context.request.get(h.origin + await page.locator('#file-list a').getAttribute('href')); expect(await fresh.text()).toBe('content B');
    const stale = await context.request.get(h.origin + oldLink); expect(stale.status()).toBe(409); expect(await stale.json()).toMatchObject({ code: 'node_changed', outcome: 'rejected' });
    expect(a.files.get('node.txt').toString()).toBe('content A'); expect(b.files.get('node.txt').toString()).toBe('content B');
  } finally { await h.close(); }
});

test('a lost switch acknowledgement is read back without resubmission or automatic navigation', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id); let writes = 0;
  try {
    await control(page, h);
    await page.route('**/__nodes/api/switch', async route => { writes++; await route.fetch(); await route.abort('failed'); });
    await choose(page, b); await expect(page.locator('#status')).toContainText('已核对入口是'); await expect(page).toHaveURL(/\/__nodes\//);
    expect(writes).toBe(1); expect(h.storage.value.activeId).toBe(b.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
    await page.locator('#enter').click(); await nodeLogin(page, b); expect(writes).toBe(1);
  } finally { await h.close(); }
});

test('cancel preserves the default node and reusable enrollment codes can be created and revoked from the web', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    await control(page, h);
    await page.locator(`[data-node-id="${b.gatewayEntry.id}"] [data-action="select"]`).click(); await page.locator('#cancel').click();
    await expect(page.locator('#confirmation')).not.toBeVisible(); expect(h.storage.value.activeId).toBe(a.gatewayEntry.id);
    await page.locator('#enrollment summary').click(); await page.locator('#code-name').fill('动态设备'); await page.locator('#create-code').click();
    await expect(page.locator('#code-value')).toHaveValue(/^cog1\./);
    const row = page.locator('#codes li').filter({ hasText: '动态设备' }); await expect(row).toBeVisible();
    await row.getByRole('button', { name: '撤销' }).click(); await expect(row).toHaveCount(0);
    expect(h.storage.value.activeId).toBe(a.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
  } finally { await h.close(); }
});

test('terminal and file WebRTC remain direct through the fixed gateway without HTTP upload bodies', async ({ page }) => {
  const h = await gatewayHTTPFixture({ webrtc: true }), a = await h.add(1); await h.select(a.gatewayEntry.id); let bodies = 0;
  try {
    await page.route('**/api/files/**', route => { bodies++; return route.abort(); }); await page.goto(h.origin); await nodeLogin(page, a);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#files-button').click(); await expect(page.locator('#file-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#upload-input').setInputFiles({ name: 'direct.txt', mimeType: 'text/plain', buffer: Buffer.from('direct through gateway') }); await expect(page.locator('#upload-status')).toContainText('上传完成：direct.txt');
    expect(a.files.get('direct.txt').toString()).toBe('direct through gateway'); expect(bodies).toBe(0); expect(a.terminalInputs).toEqual([]);
  } finally { await h.close(); }
});
