import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    window.streamSockets = []; const Native = WebSocket;
    window.streamPeers = []; const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.streamPeers.push(this); } };
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); if (new URL(this.url).pathname === '/session/connect') window.streamSockets.push(this); }
      send(data) { const v = JSON.parse(data); if (this === window.dropStreamPing && v.type === 'ping') return; super.send(data); }
    };
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
test('network event storms cannot postpone a silent path deadline and recovery keeps the sole terminal PTY', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.dropStreamPing = window.streamSockets[0]; window.dispatchEvent(new Event('online')); window.networkStorm = setInterval(() => window.dispatchEvent(new Event('online')), 100); });
    try { await expect.poll(() => frame.evaluate(() => window.streamSockets.length), { timeout: 4500, intervals: [100] }).toBe(2); }
    finally { await frame.evaluate(() => clearInterval(window.networkStorm)); }
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('network change expedites a failed candidate while preserving relay, without resetting the next deadline', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true }); let offers = 0;
  try {
    await page.route('**/api/terminal/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '暂不可达' } }) : route.continue());
    const frame = await login(page, app); await expect.poll(() => offers).toBe(1);
    await page.locator('#connection-button').click(); await expect(page.locator('#diag-direct-status')).toContainText('暂不可达'); await page.locator('#close-connection').click();
    await frame.evaluate(() => { window.dispatchEvent(new Event('online')); window.networkStorm = setInterval(() => window.dispatchEvent(new Event('online')), 100); });
    try {
      await expect.poll(() => offers, { timeout: 4500, intervals: [100] }).toBe(2);
      await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 8000 });
    } finally { await frame.evaluate(() => clearInterval(window.networkStorm)); }
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('returning to a reachable network probes and promotes before the old thirty second route cooldown', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true }); let offers = 0;
  page.on('request', request => { if (request.url().endsWith('/api/terminal/rtc')) offers++; });
  try {
    const frame = await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    await frame.evaluate(() => window.streamPeers[0].close());
    await expect(page.locator('#diag-transport')).not.toContainText('WebRTC');
    const before = offers;
    await frame.evaluate(() => { window.dispatchEvent(new Event('online')); window.networkStorm = setInterval(() => window.dispatchEvent(new Event('online')), 100); });
    try {
      await expect.poll(() => offers, { timeout: 4500 }).toBe(before + 1);
      await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 9000 });
    } finally { await frame.evaluate(() => clearInterval(window.networkStorm)); }
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
