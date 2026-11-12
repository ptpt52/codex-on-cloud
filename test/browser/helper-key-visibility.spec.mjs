import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose } from './forward-support.mjs';

const guestPassword = 'test-only-helper-key-visitor';
test('late key copy failures never select a different helper key or replace a newer copy result', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await open(page);
    await page.evaluate(() => {
      window.keyCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return new Promise((resolve, reject) => window.keyCopies.push({ resolve, reject })); } } });
    });
    await page.locator('#forward-agent-key-copy').click(); await choose(page, 2);
    await page.evaluate(() => window.keyCopies[0].reject(Error('synthetic stale key copy failure')));
    await expect(page.locator('#forward-agent-status')).not.toContainText('手动复制');
    await expect(page.locator('#forward-agent-key')).not.toBeFocused();
    await page.locator('#forward-agent-key-copy').click(); await choose(page, 1); await choose(page, 2);
    await page.evaluate(() => window.keyCopies[1].reject(Error('synthetic replaced key copy failure')));
    await expect(page.locator('#forward-agent-status')).not.toContainText('手动复制');
    await page.locator('#forward-agent-key-copy').click(); await page.locator('#forward-agent-key-copy').click();
    await page.evaluate(() => window.keyCopies[3].resolve());
    await expect(page.locator('#forward-agent-status')).toContainText('key 已复制');
    await page.evaluate(() => window.keyCopies[2].reject(Error('synthetic older key copy failure')));
    await expect(page.locator('#forward-agent-status')).toContainText('key 已复制');
    await page.locator('#forward-agent-key-copy').click();
    await page.evaluate(() => window.keyCopies[4].reject(Error('synthetic current key copy failure')));
    await expect(page.locator('#forward-agent-status')).toContainText('手动复制已选中的 key');
    await expect(page.locator('#forward-agent-key')).toBeFocused();
    expect(await page.locator('#forward-agent-key').evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length)).toBe(true);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

async function guestLogin(page, app) {
  await page.goto(app.config.origin + app.config.entryBasePath);
  await page.locator('#username').fill('visitor'); await page.locator('#password').fill(guestPassword); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('临时访问');
}

test('each helper controls guest key visibility; administrator regenerates and guest refresh only reads', async ({ page, browser }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }); let guestContext;
  try {
    await app.login(); await app.claim();
    expect((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: guestPassword } })).status).toBe(200);
    await login(page, app); await open(page);
    await expect(page.locator('#forward-agent-rekey')).toHaveText('重新生成 key'); await expect(page.locator('#forward-agent-key-refresh')).toBeHidden();
    await expect(page.locator('#forward-agent-temporary-key-visible')).not.toBeChecked();
    const second = await choose(page, 2); await page.locator('#forward-agent-temporary-key-visible').check();
    await expect(page.locator('#forward-agent-status')).toContainText('临时账号现在可查看');
    const seventh = await choose(page, 7); await expect(page.locator('#forward-agent-temporary-key-visible')).not.toBeChecked();
    await page.locator('#forward-agent-temporary-key-visible').check(); await expect(page.locator('#forward-agent-status')).toContainText('临时账号现在可查看');
    await choose(page, 2); await expect(page.locator('#forward-agent-temporary-key-visible')).toBeChecked();
    guestContext = await browser.newContext({ viewport: page.viewportSize() }); const guest = await guestContext.newPage();
    await guestLogin(guest, app); await open(guest);
    await expect(guest.locator('#forward-agent-heading')).toHaveText('助手2'); await expect(guest.locator('#forward-agent-key')).toHaveValue(second.key);
    await expect(guest.locator('#forward-agent-tab-1')).toBeHidden(); await expect(guest.locator('#forward-agent-tab-3')).toBeHidden();
    for (const id of ['forward-agent-rekey', 'forward-agent-key-visibility', 'forward-rules-heading', 'forward-agent-rules', 'forward-agent-inventory', 'forward-diagnostics-copy']) await expect(guest.locator('#' + id)).toBeHidden();
    await expect(guest.locator('#forward-agent-key-refresh')).toBeVisible();
    const mutations = []; guest.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/forward/agents/')) mutations.push(request.url()); });
    await guest.locator('#forward-agent-key-refresh').click(); await expect(guest.locator('#forward-agent-key')).toHaveValue(second.key); expect(mutations).toEqual([]);
    await guest.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedHelperKey = value; } } }));
    await guest.locator('#forward-agent-key-copy').click(); expect(await guest.evaluate(() => window.copiedHelperKey)).toBe(second.key);
    await guest.locator('#forward-agent-tab-2').focus(); await guest.keyboard.press('ArrowRight');
    await expect(guest.locator('#forward-agent-heading')).toHaveText('助手7'); await expect(guest.locator('#forward-agent-key')).toHaveValue(seventh.key);
    await guest.keyboard.press('ArrowRight'); await expect(guest.locator('#forward-agent-heading')).toHaveText('助手2');
    await page.locator('#forward-agent-rekey').click(); await expect(page.locator('#forward-agent-confirm-title')).toHaveText('重新生成助手2的 key');
    await page.locator('#forward-agent-confirm-accept').click(); await expect(page.locator('#forward-agent-key')).not.toHaveValue(second.key); await expect(page.locator('#forward-agent-key')).not.toHaveValue('');
    const regenerated = await page.locator('#forward-agent-key').inputValue();
    await guest.locator('#forward-agent-key-refresh').click(); await expect(guest.locator('#forward-agent-key')).toHaveValue(regenerated); expect(mutations).toEqual([]);
    await page.locator('#forward-agent-temporary-key-visible').uncheck(); await expect(page.locator('#forward-agent-status')).toContainText('已关闭临时账号');
    await guest.locator('#forward-refresh').click(); await expect(guest.locator('#forward-agent-heading')).toHaveText('助手7'); await expect(guest.locator('#forward-agent-key')).toHaveValue(seventh.key); await expect(guest.locator('#forward-agent-tab-2')).toBeHidden();
    await choose(page, 7); await page.locator('#forward-agent-temporary-key-visible').uncheck(); await expect(page.locator('#forward-agent-status')).toContainText('已关闭临时账号');
    await guest.locator('#forward-refresh').click(); await expect(guest.locator('#forward-agent-section')).toBeHidden(); await expect(guest.locator('#forward-agent-key')).toHaveValue('');
    await expect(guest.locator('#forward-permission')).toContainText('管理员尚未开放');
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await guestContext?.close(); await app.close(); }
});

test('an uncertain visibility save is not replayed and retains the last verified setting until a fresh read', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await open(page); let writes = 0;
    await page.route('**/api/forward/agents/visibility', async route => { writes++; await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"visible":' }); });
    await page.locator('#forward-agent-temporary-key-visible').check();
    await expect(page.locator('#forward-agent-status')).toContainText('未确认');
    await expect(page.locator('#forward-agent-temporary-key-visible')).toBeChecked();
    await page.locator('#forward-close').click(); await open(page); await expect(page.locator('#forward-agent-temporary-key-visible')).toBeChecked(); expect(writes).toBe(1);
  } finally { await app.close(); }
});

test('guest tabs put only the overflowing shared helpers in the dropdown', async ({ page }) => {
  const app = await fixture(), allowedSlots = [2, 4, 5, 6, 7, 8];
  try {
    await app.login(); await app.claim();
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: guestPassword } });
    const { agents } = await (await app.request('/api/forward/agents')).json();
    for (const agent of agents.filter(a => allowedSlots.includes(a.slot))) expect((await app.request('/api/forward/agents/visibility', { method: 'POST', body: { id: agent.id, revision: agent.visibilityRevision, visible: true } })).status).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 }); await guestLogin(page, app); await open(page);
    await expect(page.locator('#forward-agent-overflow')).toBeVisible();
    const slots = await page.locator('#forward-agent-tabs button').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => Number(n.dataset.slot)));
    expect(slots.length).toBeGreaterThan(0); expect(slots.length).toBeLessThan(allowedSlots.length); expect(slots).toEqual(allowedSlots.slice(0, slots.length));
    const overflow = await page.locator('#forward-agent-overflow option').evaluateAll(nodes => nodes.filter(n => n.value).map(n => Number(n.value))); expect(overflow).toEqual(allowedSlots.slice(slots.length));
    const last = await choose(page, 8); expect(last.agent).toBe(agents[7].id); await expect(page.locator('#forward-agent-overflow')).toHaveValue('8');
    await page.setViewportSize({ width: 1440, height: 1000 }); await expect(page.locator('#forward-agent-overflow')).toBeHidden(); await expect(page.locator('#forward-agent-tab-8')).toHaveAttribute('aria-selected', 'true');
    for (const slot of [1, 3]) await expect(page.locator('#forward-agent-tab-' + slot)).toBeHidden();
  } finally { await app.close(); }
});
