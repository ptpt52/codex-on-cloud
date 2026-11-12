import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, discard } from './forward-support.mjs';

test('Web and HTTPS port presets work in both directions, preserve manual ports on edit and stay out of serial rules', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  try {
    await login(page, app); await open(page);
    for (const [direction, port] of [['forward', '80'], ['reverse', '443']]) {
      const name = direction === 'forward' ? 'Web 服务' : 'HTTPS 服务';
      await page.locator('#forward-rule-add').click(); await page.locator('#forward-rule-name').fill(name);
      await page.locator('#forward-direction').selectOption(direction);
      const local = await page.locator('#forward-local').inputValue();
      await page.locator('#forward-port-preset').selectOption(port);
      await expect(page.locator('#forward-target')).toHaveValue(port); await expect(page.locator('#forward-local')).toHaveValue(local);
      await expect(page.locator('#forward-rule-preview')).toContainText('127.0.0.1:' + port);
      if (direction === 'reverse') await expect(page.locator('#forward-protocol')).toHaveValue('tcp');
      await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
      const row = page.locator('#forward-agent-rules article').filter({ hasText: name });
      await row.getByRole('button', { name: '编辑规则', exact: true }).click();
      await expect(page.locator('#forward-port-preset')).toHaveValue(port); await expect(page.locator('#forward-target')).toHaveValue(port);
      await page.locator('#forward-port-preset').selectOption(''); await expect(page.locator('#forward-target')).toBeFocused();
      const custom = direction === 'forward' ? '8080' : '8443';
      await page.locator('#forward-target').fill(custom); await expect(page.locator('#forward-port-preset')).toHaveValue('');
      await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
      await row.getByRole('button', { name: '编辑规则', exact: true }).click();
      await expect(page.locator('#forward-target')).toHaveValue(custom); await expect(page.locator('#forward-port-preset')).toHaveValue('');
      if (direction === 'reverse') {
        await page.locator('#forward-protocol').selectOption('serial');
        await expect(page.locator('#forward-port-preset')).toBeHidden(); await expect(page.locator('#forward-port-preset')).toBeDisabled();
        await page.locator('#forward-protocol').selectOption('tcp'); await expect(page.locator('#forward-target')).toHaveValue(custom);
      }
      await discard(page);
    }
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

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
