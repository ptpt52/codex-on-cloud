import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });

test('a node entry boots, authenticates and starts its terminal without escaping its path', async ({ page, context }) => {
  const nodeId = 'a'.repeat(32), app = await fixture({ mode: 'terminal', nodeId, entryBasePath: '/node/a/', seamless: true });
  const origin = app.config.origin, escaped = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname !== '/node/a' && !url.pathname.startsWith('/node/a/')) escaped.push(url.pathname);
  });
  try {
    await page.goto(origin + '/node/a/');
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#username')).toHaveValue('admin@node-a');
    expect(await page.locator('script[type="importmap"]').textContent()).toContain('/node/a/app.js?ui=');
    await page.locator('#password').fill(app.config.password);
    await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#desktop-frame')).toHaveAttribute('src', /^\/node\/a\/terminal\/index\.html\?/);
    const cookies = await context.cookies(origin + '/node/a/');
    expect(cookies.find(cookie => cookie.name === 'coc_session_' + nodeId)?.path).toBe('/node/a/');
    expect(escaped).toEqual([]);
  } finally { await app.close(); }
});
