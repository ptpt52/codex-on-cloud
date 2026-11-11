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
    await expect(page.locator('#center-view')).toBeHidden();
    await page.locator('#password').fill('center_password_very_long_123');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#center-view')).toBeVisible();
    await expect(page.locator('#login-view')).toBeHidden();
    await page.reload();
    await expect(page.locator('#center-view')).toBeVisible();
    await expect(page.locator('#login-view')).toBeHidden();
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
    await page.locator('#logout').click();
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#center-view')).toBeHidden();
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

async function adminFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-admin-regression-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const center = await createSelfhostCenter({ origin, dataDir: join(directory, 'center'), password: 'center_password_very_long_123', publicHost: 'desk.example.test', frpToken: 'frp_test_token_very_long_123' });
  center.server.listen(port, '127.0.0.1'); await once(center.server, 'listening');
  return { center, origin, close: async () => { await center.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function loginAdmin(page, origin) {
  await page.goto(origin + '/admin/'); await expect(page.locator('#login-view')).toBeVisible();
  await page.locator('#password').fill('center_password_very_long_123'); await page.locator('#login-form button[type="submit"]').click(); await expect(page.locator('#center-view')).toBeVisible();
}
async function more(page, id, action) {
  const row = page.locator(`[data-id="${id}"]`); await row.locator('summary').click(); await row.locator(`[data-action="${action}"]`).click();
}

test('cancel never submits and a finite authorization requires a future date', async ({ page }) => {
  const h = await adminFixture(); let creates = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/admin/api/keys')) creates++; });
  try {
    await loginAdmin(page, h.origin);
    await page.locator('#new-key').click(); await page.locator('#key-dialog [data-close]').last().click(); await expect(page.locator('#key-dialog')).toBeHidden();
    await page.locator('#new-key').click(); await page.locator('#key-name').fill('不可误建'); await page.locator('#key-slug').fill('cancelled');
    await page.locator('#key-dialog [aria-label="关闭"]').click(); await expect(page.locator('#key-dialog')).toBeHidden(); expect(creates).toBe(0);
    await page.locator('#new-key').click(); await page.locator('#key-name').fill('有限节点'); await page.locator('#key-slug').fill('finite'); await page.locator('#key-never-expires').uncheck();
    await expect(page.locator('#key-expiry')).toHaveAttribute('required', ''); await page.locator('#create-key').click();
    await expect(page.locator('#key-dialog')).toBeVisible(); await expect(page.locator('#key-form-error')).toContainText('未来到期时间'); expect(creates).toBe(0); expect((await h.center.registry.list()).length).toBe(0);
    await page.locator('#key-expiry').fill('2001-01-01T01:00'); await page.locator('#create-key').click(); expect(creates).toBe(0);
    // Switching back to unlimited explicitly disables the finite field.
    await page.locator('#key-never-expires').check(); await page.locator('#create-key').click(); await expect(page.locator('#secret-dialog')).toBeVisible();
    expect(creates).toBe(1); expect((await h.center.registry.list())[0].expiresAt).toBe(null);
  } finally { await h.close(); }
});

test('authenticated startup errors stay visible and a failed logout preserves the session with a retry message', async ({ page }) => {
  const h = await adminFixture(); let logouts = 0;
  try {
    await loginAdmin(page, h.origin);
    await page.route('**/admin/api/overview', route => route.fulfill({ status: 503, json: { error: '状态服务暂不可用' } })); await page.reload();
    await expect(page.locator('#state-view')).toBeVisible(); await expect(page.locator('#state-message')).toContainText('状态服务暂不可用'); await expect(page.locator('#retry')).toBeVisible(); await expect(page.locator('#login-view')).toBeHidden();
    await page.unroute('**/admin/api/overview'); await page.locator('#retry').click(); await expect(page.locator('#center-view')).toBeVisible();
    await page.route('**/admin/api/logout', route => { logouts++; return route.fulfill({ status: 503, json: { error: '退出失败' } }); }); await page.locator('#logout').click();
    await expect(page.locator('#list-message')).toContainText('退出未完成'); await expect(page.locator('#center-view')).toBeVisible(); await expect(page.locator('#login-view')).toBeHidden(); expect(logouts).toBe(1);
    await page.unroute('**/admin/api/logout'); await page.locator('#logout').click(); await expect(page.locator('#login-view')).toBeVisible(); await expect(page.locator('#center-view')).toBeHidden();
  } finally { await h.close(); }
});

test('node lifecycle supports rename, expiry, revocation and reauthorization at the same path with secret-free commands', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const h = await adminFixture(), old = await h.center.registry.createKey({ name: '原节点', slug: 'node-a' });
  try {
    await loginAdmin(page, h.origin); await more(page, old.id, 'edit'); await page.locator('#edit-name').fill('修改后的节点');
    await page.locator('#edit-validity').selectOption('finite'); const future = new Date(Date.now() + 86400000); const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.locator('#edit-expiry').fill(local); await page.locator('#edit-form button[type="submit"]').click();
    await expect(page.locator('#edit-dialog')).toBeHidden(); const row = page.locator(`[data-id="${old.id}"]`); await expect(row).toContainText('修改后的节点'); expect((await h.center.registry.list())[0].expiresAt).toBeGreaterThan(Date.now());
    await more(page, old.id, 'revoke'); await expect(page.locator('#confirm-target')).toHaveText('修改后的节点 · /node/node-a/'); await expect(page.locator('#confirm-message')).toContainText('任务继续运行');
    await page.locator('#confirm-dialog [data-close]').click(); expect((await h.center.registry.list())[0].revokedAt).toBe(null);
    await more(page, old.id, 'revoke'); await page.locator('#confirm-action').click(); await expect(page.locator('#confirm-dialog')).toBeHidden(); await expect(row).toBeHidden();
    await page.locator('#filter').selectOption('history'); await expect(row).toBeVisible(); await expect(row).toContainText('已撤销');
    await more(page, old.id, 'reissue'); await expect(page.locator('#key-warning')).toContainText('旧 key 和节点凭据失效'); await expect(page.locator('#key-slug')).toHaveJSProperty('readOnly', true);
    await page.locator('#create-key').click(); await expect(page.locator('#secret-dialog')).toBeVisible();
    const nextKey = await page.locator('#secret-value').textContent(); expect(nextKey).not.toBe(old.key);
    await expect(page.locator('#secret-context')).toHaveText('修改后的节点 · /node/node-a/'); const command = await page.locator('#join-command').inputValue();
    expect(command).toBe(`npm run server:join -- --server ${h.origin} --slug node-a --reauthorize`); expect(command).not.toContain(nextKey);
    await page.screenshot({ path: testInfo.outputPath('reauthorize-handoff.png'), fullPage: true, mask: [page.locator('#secret-value')] });
    await page.locator('#secret-close').click(); await expect(page.locator('#secret-value')).toHaveText(''); await expect(page.locator('#join-command')).toHaveValue('');
    const input = { version: 1, slug: old.slug, node: { id: 'a'.repeat(32), mode: 'terminal' } };
    await expect(h.center.registry.join({ ...input, key: old.key })).rejects.toThrow('授权 key 无效');
    const joined = await h.center.registry.join({ ...input, key: nextKey }); const metas = { credential: joined.credential, slug: old.slug, nodeId: input.node.id };
    await h.center.registry.authorizeLogin({ metas, runId: 'r' }); await h.center.registry.authorizeProxy({ metas, runId: 'r', name: 'node-node-a', type: 'http', customDomains: ['desk.example.test'], locations: ['/node/node-a/'] });
    await page.locator('#filter').selectOption('all'); await page.locator('#refresh').click(); await expect(page.locator('#online-count')).toHaveText('1'); await expect(row.locator('.node-enter')).toHaveAttribute('href', '/node/node-a/'); await expect(row.locator('.node-enter')).toHaveAttribute('aria-disabled', 'false');
    expect((await h.center.registry.list()).length).toBe(1);
    await more(page, old.id, 'disconnect'); await expect(page.locator('#confirm-target')).toContainText('/node/node-a/'); await expect(page.locator('#confirm-message')).toContainText('可能自动重连'); await page.locator('#confirm-dialog [data-close]').click();
  } finally { await h.close(); }
});

test('polling preserves focus, pauses in dialogs and offers searchable responsive nodes', async ({ page }, testInfo) => {
  await page.clock.install(); const h = await adminFixture(); let overviews = 0;
  const first = await h.center.registry.createKey({ name: '平板工作机', slug: 'tablet-work' }); await h.center.registry.createKey({ name: '离线测试机', slug: 'offline' });
  page.on('request', r => { if (r.url().endsWith('/admin/api/overview')) overviews++; });
  try {
    await loginAdmin(page, h.origin); const row = page.locator(`[data-id="${first.id}"]`); const copy = row.getByRole('button', { name: '复制地址' }); await copy.focus();
    const before = overviews; await page.clock.fastForward(5001); await expect.poll(() => overviews).toBe(before + 1); await expect(page.locator('#refresh')).toBeEnabled(); await expect(copy).toBeFocused();
    await more(page, first.id, 'edit'); const paused = overviews; await page.clock.fastForward(20000); expect(overviews).toBe(paused); await page.locator('#edit-dialog [data-close]').last().click();
    await row.locator('summary').click(); await expect(row.locator('details')).toHaveAttribute('open', ''); await page.keyboard.press('Escape'); await expect(row.locator('details')).not.toHaveAttribute('open', ''); await expect(row.locator('summary')).toBeFocused();
    await row.locator('summary').click(); await page.locator('#search').click(); await expect(row.locator('details')).not.toHaveAttribute('open', '');
    await page.locator('#search').fill('tablet-work'); await expect(page.locator('.node-row:visible')).toHaveCount(1); await page.locator('#search').fill('不存在'); await expect(page.locator('#no-results')).toBeVisible(); await page.locator('#clear-filters').click(); await expect(page.locator('.node-row:visible')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await row.boundingBox(); const actionBox = await copy.boundingBox(); expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(box.x + box.width); expect(actionBox.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('admin-node-list.png'), fullPage: true });
    await page.route('**/admin/api/overview', route => route.fulfill({ status: 503, json: { error: '暂不可用' } })); await page.locator('#refresh').click(); await expect(page.locator('#list-message')).toContainText('上次数据'); await expect(page.locator('#new-key')).toBeDisabled();
    await page.unroute('**/admin/api/overview'); await page.locator('#refresh').click(); await expect(page.locator('#new-key')).toBeEnabled(); await expect(page.locator('#list-message')).toHaveText('');
  } finally { await h.close(); }
});

test('uncertain create result is shown inside the dialog and is reconciled without replay', async ({ page }) => {
  await page.clock.install(); const h = await adminFixture(); let writes = 0;
  try {
    await loginAdmin(page, h.origin);
    await page.route('**/admin/api/keys', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++; await h.center.registry.createKey(route.request().postDataJSON()); return route.fulfill({ status: 503, json: { error: '响应丢失' } });
    });
    await page.locator('#new-key').click(); await page.locator('#key-name').fill('已创建但响应丢失'); await page.locator('#key-slug').fill('uncertain'); await page.locator('#create-key').click();
    await expect(page.locator('#key-form-error')).toContainText('操作结果未确认'); await expect(page.locator('#key-dialog .reconcile')).toBeVisible(); await page.clock.fastForward(20000); expect(writes).toBe(1);
    await page.locator('#key-dialog .reconcile').click(); await expect(page.locator('#key-dialog')).toBeHidden(); await expect(page.locator('#key-list')).toContainText('已创建但响应丢失'); expect(writes).toBe(1);
    // A separate failed revoke remains actionable in its own modal, not behind it.
    const key = (await h.center.registry.list())[0]; await page.route('**/admin/api/keys/' + key.id, route => route.fulfill({ status: 409, json: { error: '节点信息已变化' } }));
    await more(page, key.id, 'revoke'); await page.locator('#confirm-action').click(); await expect(page.locator('#confirm-error')).toHaveText('节点信息已变化'); await expect(page.locator('#confirm-dialog')).toBeVisible(); await expect(page.locator('#confirm-dialog .reconcile')).toBeVisible();
  } finally { await h.close(); }
});

test('menus stay inside narrow viewports and modal flows return focus to a visible control', async ({ page }, testInfo) => {
  const h = await adminFixture(), key = await h.center.registry.createKey({ name: '焦点测试节点', slug: 'focus-node' });
  try {
    await loginAdmin(page, h.origin);
    const row = page.locator(`[data-id="${key.id}"]`), summary = row.locator('summary');
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 850 }); await summary.click();
      const menu = row.locator('.node-menu'); await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const button of await menu.locator('button:visible').all()) {
        const box = await button.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.height).toBeGreaterThanOrEqual(44);
      }
      if ([320, 1024].includes(width)) await page.screenshot({ path: testInfo.outputPath(`menu-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape'); await expect(summary).toBeFocused();
    }
    await more(page, key.id, 'edit'); await page.locator('#edit-dialog [data-close]').last().click(); await expect(summary).toBeFocused();
    await more(page, key.id, 'edit'); await page.locator('#edit-name').fill('已保存的名称'); await page.locator('#edit-form button[type=submit]').click();
    await expect(row).toContainText('已保存的名称'); await expect(summary).toBeFocused();
    await more(page, key.id, 'details'); await page.locator('#details-dialog [data-close]').last().click(); await expect(summary).toBeFocused();
    await more(page, key.id, 'revoke'); await page.locator('#confirm-dialog [data-close]').click(); await expect(summary).toBeFocused();
    await more(page, key.id, 'reissue'); await page.locator('#key-dialog [data-close]').last().click(); await expect(summary).toBeFocused();
    await page.locator('#new-key').click(); await page.locator('#key-name').fill('新建后的焦点'); await page.locator('#key-slug').fill('created-focus'); await page.locator('#create-key').click();
    await expect(page.locator('#secret-dialog')).toBeVisible(); await expect(page.locator('#refresh')).toBeEnabled(); await expect(page.locator('#secret-close')).toBeFocused();
    await page.locator('#secret-close').click(); await expect(page.locator('#new-key')).toBeFocused();
    await more(page, key.id, 'revoke'); await page.locator('#confirm-action').click(); await expect(row).toBeHidden(); await expect(page.locator('#filter')).toBeFocused();
  } finally { await h.close(); }
});

test('public homepage accepts and displays more than sixty-four online nodes', async ({ page }) => {
  const h = await adminFixture();
  const nodes = Array.from({ length: 66 }, (_, index) => ({ name: '在线节点 ' + index, path: '/node/node-' + index + '/', mode: 'terminal' }));
  try {
    await page.route('**/api/public/nodes', route => route.fulfill({ json: { nodes } }));
    await page.goto(h.origin); await expect(page.locator('#node-list .home-node')).toHaveCount(66); await expect(page.locator('#node-count')).toHaveText('66 个在线');
    await expect(page.locator('#home-empty')).toBeHidden();
    await loginAdmin(page, h.origin); await expect(page.locator('.summary')).toContainText('节点数量不限');
  } finally { await h.close(); }
});
