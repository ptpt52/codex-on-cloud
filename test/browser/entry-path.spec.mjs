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

test('a selfhost node manages fixed helper keys and forward/reverse rules through its own entry path', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', nodeId: 'b'.repeat(32), entryBasePath: '/node/pairing/', seamless: true, forwardPorts: '*' });
  const requests=[]; page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/api/forward/agents/rule'))requests.push(request);});
  try {
    await page.goto(app.config.origin+'/node/pairing/');await page.locator('#password').fill(app.config.password);await page.locator('#login-button').click();await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#forward-button').click();await expect(page.locator('#forward-agent-key')).not.toHaveValue('');const grant=JSON.parse(Buffer.from((await page.locator('#forward-agent-key').inputValue()).slice(6),'base64url'));expect(grant.server).toBe(app.config.origin+'/node/pairing/');
    for(const direction of ['forward','reverse']){await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-name').fill(direction);await page.locator('#forward-direction').selectOption(direction);await page.locator('#forward-create').click();await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();}
    await expect(page.locator('#forward-agent-rules article')).toHaveCount(2);expect(requests.map(r=>new URL(r.url()).pathname)).toEqual(['/node/pairing/api/forward/agents/rule','/node/pairing/api/forward/agents/rule']);expect(app.inputCalls).toEqual([]);
  } finally {await app.close();}
});
