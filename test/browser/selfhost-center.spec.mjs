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
