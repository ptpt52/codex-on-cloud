import { openTools, openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#terminals-button')).toBeEnabled();
}
async function open(page) { await openTools(page); await page.locator('#terminals-button').click(); await expect(page.locator('#create-terminal')).toBeEnabled(); }
async function create(page, name) {
  await page.locator('#new-terminal-name').fill(name); await page.locator('#create-terminal').click();
  await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.locator('#accept-confirmation').click();
  await expect(page.locator('#terminals-status')).toContainText('已完成');
}
const row = (page, id) => page.locator(`[data-terminal="${id}"]`);

test('create, rename and switch independent terminals, route paste and Enter separately, and preserve selection without recreating tasks', async ({ page }, info) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('中文草稿保留');
    await open(page); await create(page, '运行测试');
    await expect(row(page, 'aux1')).toContainText('运行测试'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await row(page, 'aux1').getByRole('textbox').fill('测试和日志'); await row(page, 'aux1').getByRole('button', { name: '保存名称' }).click();
    await expect(row(page, 'aux1').locator('strong')).toHaveText('测试和日志');
    await page.screenshot({ path: `test-results/${info.project.name}-terminals.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await row(page, 'main').getByRole('button', { name: '打开 / 切换' }).click();
    await page.keyboard.press('Enter'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await row(page, 'main').getByRole('button', { name: '打开 / 切换' }).click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await page.locator('#close-terminals').click(); await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('中文草稿保留');
    await expect(page.locator('#paste-target')).toBeDisabled(); await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toEqual([{ action: 'paste', text: '中文草稿保留', target: 'terminal', terminalId: 'aux1', terminalToken: '%1:4100' }]);
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.inputCalls.length).toBe(2);
    expect(app.inputCalls[1]).toEqual({ action: 'key', key: 'Enter', terminalId: 'aux1', terminalToken: '%1:4100' });
    await openInput(page); await page.locator('#input-terminal').selectOption(''); await openInput(page); await page.locator('[data-key="ArrowUp"]').click();
    await expect.poll(() => app.inputCalls.length).toBe(3); expect(app.inputCalls.at(-1)).toEqual({ action: 'key', key: 'ArrowUp' });
    app.disconnectViewers(); await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    await expect(page.locator('#mobile-input')).toHaveValue('中文草稿保留');
    await page.reload(); await expect(page.locator('#terminals-button')).toBeEnabled();
    await expect(page.locator('#input-terminal option')).toHaveCount(3); await expect(page.locator('#input-terminal')).toHaveValue('');
    expect((await app.controls.listTerminals()).terminals).toHaveLength(2); expect(app.inputCalls.length).toBe(3); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('cancelled creation and lost accepted replies never retry; stale target tokens are rejected and capacity is bounded', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }); let creates = 0;
  try {
    await login(page, app); await open(page);
    await page.locator('#new-terminal-name').fill('先取消'); await page.locator('#create-terminal').click(); await page.keyboard.press('Enter');
    expect((await app.controls.listTerminals()).terminals.length).toBe(1);
    await page.route('**/api/terminals', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'create') { creates++; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await page.locator('#create-terminal').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminals-status')).toContainText('结果未知');
    await page.locator('#refresh-terminals').click(); await expect(row(page, 'aux1')).toBeVisible(); expect(creates).toBe(1);
    await page.unroute('**/api/terminals');
    await page.route('**/api/terminals', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), result = await response.json(); result.terminals[1].token = '%999:9999'; await route.fulfill({ response, json: result });
    });
    await page.locator('#refresh-terminals').click(); await expect(page.locator('#terminals-status')).toContainText('共 2');
    await page.locator('#close-terminals').click(); await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'rejected'); expect(app.inputCalls).toEqual([]);
    await page.unroute('**/api/terminals'); await open(page);
    await create(page, '第二个'); await create(page, '第三个');
    await expect(page.locator('#create-terminal')).toBeDisabled(); await expect(page.locator('.terminal-row')).toHaveCount(4);
    expect((await app.controls.get()).session).toBeNull(); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('pending terminal creation and shortcut target changes are cancelled on takeover or selection changes', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await openInput(page); await page.locator('#input-terminal').selectOption('main');
    await openInput(page); await page.locator('[data-key="Ctrl+C"]').click(); await expect(page.locator('#action-confirmation')).toBeVisible();
    await page.locator('#input-terminal').evaluate(select => { select.value = ''; select.dispatchEvent(new Event('change')); });
    await expect(page.locator('#action-confirmation')).toBeHidden(); await page.locator('#accept-confirmation').evaluate(button => button.click()); expect(app.inputCalls).toEqual([]);
    await open(page); await page.locator('#new-terminal-name').fill('旧页面操作'); await page.locator('#create-terminal').click();
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('桌面在线');
      await expect(page.locator('#action-confirmation')).toBeHidden({ timeout: 10000 }); await page.locator('#accept-confirmation').evaluate(button => button.click());
      expect((await app.controls.listTerminals()).terminals).toHaveLength(1); expect(app.inputCalls).toEqual([]);
    } finally { await second.close(); }
  } finally { await app.close(); }
});

test('selected terminal metadata crosses encrypted direct control and a lost result never resends over HTTP', async ({ page }) => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, inputHook: async () => { entered(); await hold; } }); let http = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/key')) http++; });
  try {
    await login(page, app); await page.locator('#connection-button').click(); await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密直连'); await page.locator('#close-connection').click();
    await open(page); await create(page, '直连终端'); await page.locator('#close-terminals').click();
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await started;
    app.disconnectViewers(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown'); release();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter', terminalId: 'aux1', terminalToken: '%1:4100' }]); expect(http).toBe(0);
  } finally { release(); await app.close(); }
});
