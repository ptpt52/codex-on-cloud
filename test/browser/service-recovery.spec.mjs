import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test('service recovery diagnostics are read-only, update on refresh and do not resend an existing draft', async ({ page }) => {
  let restarts = 2;
  const app = await fixture({ rfb: true, serviceDiagnostics: async () => ({ available: true, panel: { state: 'active', restarts, limited: false }, manager: { state: 'active' }, actions: { state: 'inactive' } }) });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('保留，不自动发送');
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-recovery')).toHaveText('已自动恢复 · 2 次'); await expect(page.locator('#diag-services')).toContainText('桌面执行：未就绪');
    await expect(page.locator('#diag-files')).toHaveText('服务状态未知 · 接口正常');
    restarts = 3; await page.locator('#refresh-connection').click(); await expect(page.locator('#diag-recovery')).toHaveText('已自动恢复 · 3 次');
    await page.locator('#close-connection').click(); await expect(page.locator('#mobile-input')).toHaveValue('保留，不自动发送'); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['desktop', 'terminal']) test(`${mode} file diagnostics distinguish missing, stopped and unready helpers without changing tasks`, async ({ page }) => {
  const running = { state: 'active', restarts: 0, limited: false };
  const normal = { available: true, panel: running, manager: running, [mode === 'terminal' ? 'terminal' : 'actions']: running, files: running };
  let services = normal, ready = true, legacy = false;
  const app = await fixture({ mode, rfb: true, serviceDiagnostics: async () => services });
  try {
    await page.route('**/api/diagnostics', async route => {
      const response = await route.fetch(), json = await response.json();
      if (legacy) delete json.files; else json.files = { ready };
      await route.fulfill({ response, json });
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-files')).toHaveText('服务运行中 · 接口正常');
    await expect(page.locator('#diag-services').locator('..').locator('dt')).toHaveText(mode === 'terminal' ? '终端后台' : '输入与桌面执行');
    for (const item of [
      { file: { state: 'failed', restarts: 3, limited: true }, ready: false, text: '自动恢复已停止 · 接口未就绪' },
      { file: { state: 'failed', restarts: 1, limited: false }, ready: false, text: '服务失败 · 接口未就绪' },
      { file: { state: 'missing', restarts: 0, limited: false }, ready: true, text: '服务未安装 · 接口正常' },
      { file: running, ready: false, text: '服务运行中 · 接口未就绪' },
      { unavailable: true, ready: true, text: '服务状态未知 · 接口正常' },
      { legacy: true, text: '服务状态未知 · 接口状态未知' },
    ]) {
      services = item.unavailable ? { available: false } : { ...normal, files: item.file };
      ready = item.ready; legacy = !!item.legacy;
      await page.locator('#refresh-connection').click(); await expect(page.locator('#diag-files')).toHaveText(item.text);
    }
    await page.unroute('**/api/diagnostics');
    await page.route('**/api/diagnostics', route => route.fulfill({ status: 503, json: { error: '诊断暂时不可用' } }));
    await page.locator('#refresh-connection').click(); await expect(page.locator('#diag-files')).toHaveText('状态未知');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a delayed recovery cannot take over another page and preserves the unsent draft', async ({ page }) => {
  const app = await fixture({ rfb: true }), conditional = [];
  page.on('request', request => { if (request.url().endsWith('/api/desktop/claim') && request.postDataJSON()?.ifFree) conditional.push(request.postDataJSON()); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await page.locator('#toggle-input-button').click(); await page.locator('#mobile-input').fill('恢复不得抢占另一页面');
    const other = '22222222-2222-4222-8222-222222222222'; await app.login(); await app.claim(other);
    await page.route('**/api/state', async route => { const response = await route.fetch(), state = await response.json(); await route.fulfill({ response, json: { ...state, mine: false, claimable: true } }); });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => conditional.length).toBe(1);
    expect((await (await app.request('/api/state', { headers: { 'x-viewer-id': other } })).json()).mine).toBe(true);
    expect(app.inputCalls).toEqual([]); await expect(page.locator('#mobile-input')).toHaveValue('恢复不得抢占另一页面');
  } finally { await app.close(); }
});
