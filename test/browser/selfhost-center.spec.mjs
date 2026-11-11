import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfhostCenter } from '../../selfhost/center.mjs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}

test('central management page creates a one-time key and lists its fixed node path', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-ui-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpToken: 'frp_test_token_very_long_123' });
  center.server.listen(port, '127.0.0.1'); await once(center.server, 'listening');
  try {
    await context.addCookies([{ name: 'coc_session_center', value: 'legacy', url: origin }]);
    await page.goto(origin);
    await expect(page).toHaveURL(origin + '/');
    await page.locator('#admin-entry').click();
    await expect(page).toHaveURL(origin + '/admin/');
    await expect(page.locator('#login-view')).toBeVisible();
    await page.locator('#password').fill('center_password_very_long_123');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#center-view')).toBeVisible();
    const adminCookies = await context.cookies(origin + '/admin/');
    expect(adminCookies.some(cookie => cookie.name === 'coc_session_center')).toBe(false);
    expect(adminCookies.find(cookie => cookie.name === 'coc_session_center_admin')?.path).toBe('/admin/');
    expect((await context.cookies(origin + '/node/demo/')).some(cookie => cookie.name.startsWith('coc_session_center'))).toBe(false);
    await page.locator('#new-key').click();
    await page.locator('#key-name').fill('深圳测试机');
    await page.locator('#key-slug').fill('shenzhen-test');
    await page.locator('#create-key').click();
    await expect(page.locator('#secret-dialog')).toBeVisible();
    await expect(page.locator('#secret-value')).toHaveText(/^coc_[A-Za-z0-9_-]{43}$/);
    await page.locator('#secret-close').click();
    await expect(page.locator('#key-list')).toContainText('深圳测试机');
    await expect(page.locator('#key-list')).toContainText('/node/shenzhen-test/');
    await expect(page.locator('#online-count')).toHaveText('0');
  } finally { await center.close(); await rm(directory, { recursive: true, force: true }); }
});


test('anonymous homepage lists online nodes, refreshes without login and keeps node names as text', async ({ page, context }, testInfo) => {
  await page.clock.install();
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-home-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpToken: 'frp_test_token_very_long_123' });
  center.server.listen(port, '127.0.0.1'); await once(center.server, 'listening');
  try {
    const registry = center.registry, name = '<img src=x onerror=alert(1)> 深圳工作机';
    const key = await registry.createKey({ name, slug: 'shenzhen' });
    await registry.createKey({ name: '离线节点', slug: 'offline' });
    const joined = await registry.join({ version: 1, slug: key.slug, key: key.key, node: { id: 'a'.repeat(32), mode: 'terminal' } });
    const metas = { credential: joined.credential, slug: key.slug, nodeId: 'a'.repeat(32), mode: 'terminal' }, runId = 'run-ui';
    await registry.authorizeLogin({ metas, runId });
    await registry.authorizeProxy({ metas, runId, name: 'node-shenzhen', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/shenzhen/'] });
    const requests = [];
    page.on('request', request => { if (new URL(request.url()).origin === origin) requests.push(request); });
    await page.goto(origin);
    await expect(page.locator('#node-list .home-node')).toHaveCount(1);
    await expect(page.locator('#node-list strong')).toHaveText(name);
    await expect(page.locator('#node-list img')).toHaveCount(0);
    await expect(page.locator('#node-list a')).toHaveAttribute('href', '/node/shenzhen/');
    await expect(page.locator('#node-list')).toContainText('网页终端');
    await expect(page.locator('#node-count')).toHaveText('1 个在线');
    expect(requests.some(request => request.url().includes('/admin/'))).toBe(false);
    expect(requests.filter(request => request.url().endsWith('/api/public/nodes')).every(request => !request.headers().cookie)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await context.request.get(origin + '/admin/api/keys')).status()).toBe(401);
    await page.locator('#node-list a').focus();
    await page.locator('#refresh-nodes').evaluate(button => button.click());
    await expect(page.locator('#refresh-nodes')).toBeEnabled();
    await expect(page.locator('#node-list a')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('home-online.png'), fullPage: true });
    await registry.closeProxy({ metas, runId });
    await page.clock.fastForward(15001);
    await expect(page.locator('#home-empty')).toBeVisible();
    await expect(page.locator('#node-list .home-node')).toHaveCount(0);
    await expect(page.locator('#node-count')).toHaveText('0 个在线');
    await page.route('**/api/public/nodes', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    await page.locator('#refresh-nodes').click();
    await expect(page.locator('#home-status')).toContainText('暂不可用');
    await expect(page.locator('#home-empty')).toBeHidden();
    await expect(page.locator('#node-count')).toBeHidden();
    await page.unroute('**/api/public/nodes');
    await page.locator('#refresh-nodes').click();
    await expect(page.locator('#home-empty')).toBeVisible();
  } finally { await center.close(); await rm(directory, { recursive: true, force: true }); }
});
