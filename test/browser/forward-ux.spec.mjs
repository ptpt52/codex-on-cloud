import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, discard } from './forward-support.mjs';

test('one connection type selector preserves Web and HTTPS semantics on custom ports in both directions', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  try {
    await login(page, app); await open(page);
    await expect(page.locator('#forward-port-preset')).toHaveCount(0);
    for (const [direction, protocol, port] of [['forward', 'http', '80'], ['reverse', 'https', '443']]) {
      const name = direction === 'forward' ? 'Web 服务' : 'HTTPS 服务';
      await page.locator('#forward-rule-add').click(); await page.locator('#forward-rule-name').fill(name);
      await page.locator('#forward-direction').selectOption(direction);
      const local = await page.locator('#forward-local').inputValue();
      await page.locator('#forward-protocol').selectOption(protocol);
      await expect(page.locator('#forward-target')).toHaveValue(port); await expect(page.locator('#forward-local')).toHaveValue(local);
      await expect(page.locator('#forward-rule-preview')).toContainText('127.0.0.1:' + port);
      await expect(page.locator('#forward-protocol')).toHaveValue(protocol);
      if (direction === 'forward') await expect(page.locator('#forward-protocol option[value="serial"]')).toHaveJSProperty('disabled', true);
      await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
      const row = page.locator('#forward-agent-rules article').filter({ hasText: name });
      await row.getByRole('button', { name: '编辑规则', exact: true }).click();
      await expect(page.locator('#forward-direction')).toHaveValue(direction);
      await expect(page.locator('#forward-protocol')).toHaveValue(protocol); await expect(page.locator('#forward-target')).toHaveValue(port);
      const custom = direction === 'forward' ? '8080' : '8443';
      await page.locator('#forward-target').fill(custom); await expect(page.locator('#forward-protocol')).toHaveValue(protocol);
      await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
      await row.getByRole('button', { name: '编辑规则', exact: true }).click();
      await expect(page.locator('#forward-target')).toHaveValue(custom); await expect(page.locator('#forward-protocol')).toHaveValue(protocol);
      if (direction === 'reverse') {
        await page.locator('#forward-protocol').selectOption('serial');
        await expect(page.locator('#forward-target')).toBeHidden(); await expect(page.locator('#forward-target')).toBeDisabled();
        await page.locator('#forward-protocol').selectOption('tcp'); await expect(page.locator('#forward-target')).toHaveValue(custom);
      }
      await discard(page);
    }
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('new rules choose unused scoped listeners and editable names while manual choices and saved edits stay intact', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  const start = () => page.locator('#forward-rule-add').click();
  const save = async () => { await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible(); };
  try {
    await login(page, app); await open(page);
    await start(); await expect(page.locator('#forward-local')).toHaveValue('22001');
    await expect(page.locator('#forward-rule-name')).toHaveValue('助手1 SSH 22001'); await save();
    await start(); await expect(page.locator('#forward-local')).toHaveValue('22002');
    await page.locator('#forward-direction').selectOption('forward'); await expect(page.locator('#forward-local')).toHaveValue('2222');
    await expect(page.locator('#forward-rule-name')).toHaveValue('助手1 SSH 2222'); await save();
    await choose(page, 2); await start(); await expect(page.locator('#forward-local')).toHaveValue('22002');
    await expect(page.locator('#forward-rule-name')).toHaveValue('助手2 SSH 22002'); await save();
    await start(); await expect(page.locator('#forward-local')).toHaveValue('22003');
    await page.locator('#forward-direction').selectOption('forward'); await expect(page.locator('#forward-local')).toHaveValue('2222'); await save();
    await choose(page, 1);
    const first = page.locator('#forward-agent-rules article').filter({ hasText: '助手1 SSH 22001' });
    await first.getByRole('button', { name: '停用规则', exact: true }).click(); await page.locator('#forward-agent-confirm-accept').click();
    await expect(first).toContainText('已停用');
    await start(); await expect(page.locator('#forward-local')).toHaveValue('22003');
    await page.locator('#forward-local').fill('34567'); await expect(page.locator('#forward-rule-name')).toHaveValue('助手1 SSH 34567');
    await page.locator('#forward-rule-name').fill('我的规则'); await page.locator('#forward-protocol').selectOption('https');
    await expect(page.locator('#forward-target')).toHaveValue('443'); await page.locator('#forward-target').fill('8443');
    await page.locator('#forward-direction').selectOption('forward'); await page.locator('#forward-direction').selectOption('reverse');
    await expect(page.locator('#forward-local')).toHaveValue('34567'); await expect(page.locator('#forward-rule-name')).toHaveValue('我的规则');
    await save();
    const custom = page.locator('#forward-agent-rules article').filter({ hasText: '我的规则' });
    await custom.getByRole('button', { name: '编辑规则', exact: true }).click();
    await expect(page.locator('#forward-local')).toHaveValue('34567'); await expect(page.locator('#forward-rule-name')).toHaveValue('我的规则');
    await expect(page.locator('#forward-protocol')).toHaveValue('https'); await expect(page.locator('#forward-target')).toHaveValue('8443');
    await discard(page); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a lost save reply preserves the submitted automatic port and name instead of preparing a second rule', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let saves = 0;
  try {
    await page.route('**/api/forward/agents/rule', async route => { saves++; await route.fetch(); await route.abort(); });
    await login(page, app); await open(page); await page.locator('#forward-rule-add').click();
    const port = await page.locator('#forward-local').inputValue(), name = await page.locator('#forward-rule-name').inputValue();
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-error')).toContainText('结果未确认');
    await expect(page.locator('#forward-agent-rules article')).toHaveCount(1);
    await expect(page.locator('#forward-local')).toHaveValue(port); await expect(page.locator('#forward-rule-name')).toHaveValue(name);
    expect(saves).toBe(1); await discard(page);
  } finally { await app.close(); }
});

test('automatic listeners skip node management ports delivered by the actual policy API', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  app.config.tunnelMetricsPort = 22001;
  try {
    await login(page, app); await open(page); await page.locator('#forward-rule-add').click();
    await expect(page.locator('#forward-create')).toBeEnabled();
    await expect(page.locator('#forward-local')).toHaveValue('22002');
    await expect(page.locator('#forward-rule-name')).toHaveValue('助手1 SSH 22002');
    await discard(page); expect(app.inputCalls).toEqual([]);
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
    await expect(page.locator('#forward-direction')).toHaveValue('reverse');
    await expect(page.locator('#forward-direction option').first()).toHaveAttribute('value', 'reverse');
    await expect(page.locator('#forward-local')).toHaveValue('22001');
    await expect(page.locator('#forward-target-label')).toHaveText('目标 IP（助手侧）');
    await page.locator('#forward-direction').selectOption('forward'); await expect(page.locator('#forward-local')).toHaveValue('2222');
    await page.locator('#forward-direction').selectOption('reverse'); await expect(page.locator('#forward-local')).toHaveValue('22001');
    await page.locator('#forward-local').fill('34567'); await page.locator('#forward-direction').selectOption('forward');
    await expect(page.locator('#forward-local')).toHaveValue('34567');
    await page.locator('#forward-direction').selectOption('reverse'); await expect(page.locator('#forward-local')).toHaveValue('34567');
    await page.locator('#forward-local').fill('22001');
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
    await page.locator('#forward-rule-add').click(); await expect(page.locator('#forward-rule-name')).toHaveValue('助手1 SSH 22001');
    await page.locator('#forward-direction').selectOption('forward'); await page.locator('#forward-direction').selectOption('reverse');
    await page.locator('#forward-protocol').selectOption('serial'); await page.locator('#forward-protocol').selectOption('ssh');
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
