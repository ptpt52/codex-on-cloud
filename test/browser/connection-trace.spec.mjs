import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
async function login(page, app) {
  await page.addInitScript(() => {
    if (window !== parent) return;
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal' }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('manual copy test'); } } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
test('connection timeline measures relay and direct stages, sanitizes events and offers bounded manual copying', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('中转认证完成');
    for (const text of ['收集地址', '交换连接信息', '建立加密通道', 'ms', '数据通道已启用']) await expect(page.locator('#connection-trace-list')).toContainText(text);
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await frame.evaluate(() => {
      const current = new URLSearchParams(location.search).get('frame');
      parent.postMessage({ type: 'codex-network-event', frame: 'stale', event: { type: 'input-pressure' } }, location.origin);
      parent.postMessage({ type: 'codex-network-event', frame: current, event: { type: 'retry', path: 'direct', waitMs: 500, text: 'PRIVATE_TEXT_SENTINEL', address: 'PRIVATE_ADDRESS_SENTINEL', reason: 'PRIVATE_REASON_SENTINEL' } }, location.origin);
    });
    await expect(page.locator('#connection-trace-list')).toContainText('500 ms 后');
    await expect(page.locator('#connection-trace-list')).not.toContainText('输入队列达到上限');
    await page.locator('#copy-connection-trace').click(); await expect(page.locator('#connection-trace-copy')).toBeVisible();
    const copied = await page.locator('#connection-trace-copy').inputValue();
    expect(copied).not.toContain('PRIVATE_'); expect(new TextEncoder().encode(copied).length).toBeLessThanOrEqual(16384);
    expect(JSON.parse(copied).events.length).toBeLessThanOrEqual(50);
    await page.locator('#clear-connection-trace').click(); await expect(page.locator('#connection-trace-list > li')).toHaveCount(0);
    await expect(page.locator('#connection-trace-copy')).toBeHidden();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
