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

test('a selfhost node displays forward and reverse pairing codes without losing its entry path', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', nodeId: 'b'.repeat(32), entryBasePath: '/node/pairing/', seamless: true, forwardPorts: '*' });
  const requests = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/forward')) requests.push(request); });
  try {
    await page.goto(app.config.origin + '/node/pairing/');
    await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#forward-button').click(); await expect(page.locator('#forward-create')).toBeEnabled();
    await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    await expect(page.locator('#forward-pair')).toBeVisible();
    await expect(page.locator('#forward-status')).toContainText('两分钟内有效');
    await page.locator('#forward-direction').selectOption('reverse');
    await page.locator('#forward-device-name').fill('本地 SSH');
    await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    await expect(page.locator('#forward-list .forward-row')).toHaveCount(2);
    expect(requests.map(request => new URL(request.url()).pathname)).toEqual(['/node/pairing/api/forward', '/node/pairing/api/forward']);
    expect(requests[0].postDataJSON().direction).toBeUndefined();
    expect(requests[1].postDataJSON().direction).toBe('reverse');
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
