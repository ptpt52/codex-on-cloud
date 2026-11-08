import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
// Keep injected HTTP refusals visible to Playwright in WebKit as well.
test.use({ serviceWorkers: 'block' });
async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal' }));
    window.networkSockets = []; const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); if (new URL(this.url).pathname !== '/session/connect') return;
        window.networkSockets.push(this);
        this.addEventListener('message', event => {
          if (!event.isTrusted || !window.pongDelay || JSON.parse(event.data).type !== 'pong') return;
          event.stopImmediatePropagation(); setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })), window.pongDelay);
        });
      }
      send(data) {
        if (typeof data === 'string' && window.dropNextPing && JSON.parse(data).type === 'ping') { window.dropNextPing = false; return; }
        super.send(data);
      }
    };
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
test('busy signaling retries promptly while preserving the relay and original terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true }); let offers = 0;
  await page.route('**/api/terminal/rtc', route => ++offers === 1 ? route.fulfill({ status: 429, json: { error: 'busy' } }) : route.continue());
  try {
    await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 10000 });
    expect(offers).toBe(2); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('permission refusal stops automatic probing even after repeated online events without disrupting relay viewing', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true }); let offers = 0;
  await page.route('**/api/terminal/rtc', route => { offers++; return route.fulfill({ status: 403, json: { error: 'denied' } }); });
  try {
    const frame = await login(page, app); await expect(page.locator('#diag-direct-status')).toContainText('权限');
    await frame.evaluate(() => { for (let i = 0; i < 50; i++) window.dispatchEvent(new Event('online')); });
    await page.waitForTimeout(1600); expect(offers).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('a single lost heartbeat is confirmed without reconnecting a responsive relay or its terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.dropNextPing = true; window.dispatchEvent(new Event('online')); });
    await page.waitForTimeout(3500);
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.networkSockets.length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('measured latency raises the bounded deadline so a slow following heartbeat keeps the original connection', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.pongDelay = 900; window.dispatchEvent(new Event('online')); });
    await expect.poll(async () => Number((await page.locator('#diag-latency').textContent()).replace(/[^\d]/g, ''))).toBeGreaterThanOrEqual(850);
    await frame.evaluate(() => { window.pongDelay = 2300; window.dispatchEvent(new Event('online')); });
    await expect.poll(async () => Number((await page.locator('#diag-latency').textContent()).replace(/[^\d]/g, '')), { timeout: 6000 }).toBeGreaterThanOrEqual(2200);
    expect(await frame.evaluate(() => window.networkSockets.length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('foreground recovery clears a heartbeat pause only after a fresh echo without reconnecting', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.dropNextPing = true; window.pongDelay = 10000; window.dispatchEvent(new Event('online')); });
    await expect(page.locator('#connection-status')).toContainText('正在优化连接');
    await frame.evaluate(() => {
      window.fakeHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fakeHidden });
      document.dispatchEvent(new Event('visibilitychange')); window.pongDelay = 0;
      window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await frame.evaluate(() => window.networkSockets.length)).toBe(1); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
