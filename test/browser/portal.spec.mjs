import { test, expect } from '@playwright/test';
import { portalFixture } from '../portal-fixture.mjs';

async function portalLogin(page, portal) { await page.goto(portal.origin); await expect(page.locator('#portal-login')).toBeVisible(); await page.locator('#portal-password').fill(portal.password); await page.locator('#portal-login-form button').click(); await expect(page.locator('#portal-workspace')).toBeVisible(); }
const card = (page, name) => page.locator('.node-card').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('portal manages nodes dynamically, confirms removals, exports metadata and reuses long-lived authorization codes', async ({ page, context }, info) => {
  const portal = await portalFixture({ listen: true }); let other;
  try {
    await portalLogin(page, portal); await page.locator('#portal-add').click();
    await page.locator('#node-id').fill('home'); await page.locator('#node-name').fill('home'); await page.locator('#node-origin').fill('https://home-codex.example.com'); await page.locator('#node-enabled').check(); await page.locator('#node-save').click();
    await expect(card(page, 'home').getByRole('link')).toHaveAttribute('href', 'https://home-codex.example.com/');
    other = await context.newPage(); await other.goto(portal.origin); await expect(card(other, 'home')).toBeVisible(); await other.locator('#portal-add').click();
    await other.locator('#node-id').fill('work'); await other.locator('#node-name').fill('work'); await other.locator('#node-origin').fill('https://work-codex.example.com'); await other.locator('#node-save').click(); await expect(card(other, 'work')).toContainText('入口未启用');
    await page.locator('#portal-refresh').click(); await expect(card(page, 'work')).toBeVisible(); await card(page, 'work').getByRole('button', { name: '删除', exact: true }).click(); await expect(page.locator('#delete-cancel')).toBeFocused(); await page.keyboard.press('Enter'); await expect(card(page, 'work')).toBeVisible();
    await page.locator('#portal-enroll').click(); await page.locator('#authorization-code-name').fill('home 和 work 共用'); await page.locator('#authorization-code-form button').click();
    await expect(page.locator('#enrollment-code')).toHaveValue(/^coc1\./); const authorizationCode = await page.locator('#enrollment-code').inputValue();
    await expect(page.locator('#portal-code')).toContainText('长期有效'); await page.locator('#code-close').click(); await expect(page.locator('#enrollment-code')).toHaveValue('');
    await expect(page.locator('#authorization-code-list')).toContainText('home 和 work 共用'); await page.locator('#codes-close').click();
    const download = page.waitForEvent('download'); await page.locator('#portal-export').click(); const file = await download; expect(file.suggestedFilename()).toBe('codex-servers.json');
    const stream = await file.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk); const exported = Buffer.concat(chunks).toString(); expect(JSON.parse(exported).nodes.length).toBe(2); expect(exported).not.toContain(authorizationCode); expect(exported).not.toMatch(/csrf|password|nodeSecret/);
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${info.project.name}-portal.png` });
    await card(page, 'work').getByRole('button', { name: '删除', exact: true }).click(); await page.locator('#delete-accept').click(); await expect(card(page, 'work')).toHaveCount(0);
    await page.reload(); await expect(card(page, 'home')).toBeVisible(); await expect(card(page, 'work')).toHaveCount(0);
    await page.locator('#portal-enroll').click(); await page.getByRole('button', { name: '删除授权码', exact: true }).click();
    await expect(page.locator('#delete-title')).toHaveText('删除授权码？'); await expect(page.locator('#delete-effect')).toContainText('已注册节点保持接入');
    await page.keyboard.press('Enter'); await expect(page.locator('#authorization-code-list')).toContainText('home 和 work 共用');
    await page.getByRole('button', { name: '删除授权码', exact: true }).click(); await page.getByRole('button', { name: '确认删除授权码', exact: true }).click();
    await expect(page.locator('#authorization-code-list')).toBeEmpty();
  } finally { await other?.close(); await portal.close(); }
});

test('closing code management cancels a late reply without reopening or retaining the shared code', async ({ page }) => {
  const portal = await portalFixture({ listen: true }); let release;
  try {
    await portalLogin(page, portal); await page.locator('#portal-enroll').click();
    let received; const pending = new Promise(resolve => { received = resolve; });
    await page.route('**/api/authorization-codes', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); received();
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ response }).catch(() => {});
    });
    await page.locator('#authorization-code-name').fill('取消中的授权码');
    await page.locator('#authorization-code-form button').click(); await pending;
    await page.keyboard.press('Escape'); await expect(page.locator('#portal-codes')).not.toBeVisible();
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#portal-code')).not.toBeVisible(); await expect(page.locator('#enrollment-code')).toHaveValue('');
    await page.locator('#portal-enroll').click(); await expect(page.locator('#authorization-code-list')).toContainText('取消中的授权码');
    await expect(page.locator('#portal-code')).not.toBeVisible();
  } finally { release?.(); await portal.close(); }
});
