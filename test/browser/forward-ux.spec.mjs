import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, discard } from './forward-support.mjs';

test('daily actions stay in the first viewport while installation and advanced information are collapsed', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await login(page, app); await open(page);
    await expect(page.locator('#forward-download-section')).not.toHaveAttribute('open', '');
    for (const id of ['forward-agent-bar', 'forward-agent-key-copy', 'forward-rule-add']) await expect(page.locator('#' + id)).toBeInViewport();
    expect(await page.locator('#forward-dialog').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await page.locator('#forward-rule-add').click();
    await expect(page.locator('#forward-rule-advanced')).not.toHaveAttribute('open', '');
    await expect(page.locator('#forward-create')).toHaveText('保存规则');
    await expect(page.locator('#forward-rule-effect')).toContainText('助手当前离线');
    await expect(page.locator('#forward-create')).toBeInViewport();
    await page.locator('#forward-direction').selectOption('reverse'); await page.locator('#forward-protocol').selectOption('serial');
    await expect(page.locator('#forward-create')).toBeInViewport();
    await expect(page.locator('#forward-rule-preview')).toContainText('节点主机 127.0.0.1:22001');
    await page.locator('#forward-serial-path').fill('COM8');
    await expect(page.locator('#forward-rule-preview')).toContainText('助手侧串口（助手1） COM8 @ 115200');
    await discard(page); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('Escape and close preserve dirty input until explicit discard without submitting a rule', async ({ page }) => {
  const app = await fixture({ rfb: true }); let writes = 0;
  try {
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/forward/agents/rule')) writes++; });
    await login(page, app); await open(page); await page.locator('#forward-rule-add').click();
    await page.locator('#forward-rule-name').fill('保留的草稿'); await page.keyboard.press('Escape');
    await expect(page.locator('#forward-agent-confirm')).toBeVisible(); await expect(page.locator('#forward-agent-confirm-cancel')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('#forward-agent-confirm')).not.toBeVisible();
    await expect(page.locator('#forward-rule-name')).toHaveValue('保留的草稿');
    await page.locator('#forward-rule-close').click(); await expect(page.locator('#forward-agent-confirm-accept')).toHaveText('放弃填写');
    await page.keyboard.press('Tab'); await expect(page.locator('#forward-agent-confirm-accept')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
    expect(writes).toBe(0); await expect(page.locator('#forward-agent-rules article')).toHaveCount(0);
    await page.locator('#forward-rule-add').click(); await expect(page.locator('#forward-rule-name')).toHaveValue('');
    await page.locator('#forward-direction').selectOption('reverse'); await page.locator('#forward-protocol').selectOption('serial'); await page.locator('#forward-direction').selectOption('forward');
    await page.keyboard.press('Escape'); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
  } finally { await app.close(); }
});

test('hiding the page clears the key but preserves input while takeover still clears the editor', async ({ page, context }) => {
  const app = await fixture({ rfb: true }); let writes = 0;
  try {
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/forward/agents/rule')) writes++; });
    await login(page, app); await open(page); const a = await choose(page, 1); await page.locator('#forward-rule-add').click();
    await page.locator('#forward-rule-name').fill('切换窗口保留');
    await page.evaluate(() => { window.auditHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.auditHidden }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#forward-agent-key')).toHaveValue(''); await expect(page.locator('#forward-rule-name')).toHaveValue('切换窗口保留');
    await page.evaluate(() => { window.auditHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#forward-agent-key')).toHaveValue(a.key); await expect(page.locator('#forward-rule-name')).toHaveValue('切换窗口保留');
    const other = await context.newPage(); await other.goto(app.config.origin); await expect(other.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#forward-rule-dialog')).not.toBeVisible(); await expect(page.locator('#forward-rule-name')).toHaveValue('');
    await expect(page.locator('#forward-agent-key')).toHaveValue(''); expect(writes).toBe(0); await other.close();
  } finally { await app.close(); }
});
