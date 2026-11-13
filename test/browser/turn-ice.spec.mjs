import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });

test('a stalled TURN refresh cannot interrupt state polling or input on an established direct viewer', async ({ page }) => {
  let stalled = false, requests = 0;
  const central = http.createServer((_req, res) => {
    requests++; if (stalled) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ expiresAt: Date.now() + 60000, ttlMs: 60000, iceServers: [{ urls: ['stun:127.0.0.1:3478'] }] }));
  });
  central.listen(0, '127.0.0.1'); await once(central, 'listening');
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true,
    selfhostNode: { slug: 'node-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'b'.repeat(43), turnEndpoint: `http://127.0.0.1:${central.address().port}/api/turn-credentials` } });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 }); await expect(page.locator('#paste-button')).toBeEnabled();
    const connections = app.vncConnections, before = requests; stalled = true;
    await expect.poll(() => requests).toBeGreaterThan(before);
    // Cross the five-second credential request deadline and another poll.
    await page.waitForTimeout(6500);
    await expect(page.locator('#diag-panel')).toContainText('可访问'); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(requests).toBe(before + 1); expect(app.vncConnections).toBe(connections); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); central.closeAllConnections(); await new Promise(resolve => central.close(resolve)); }
});

test('authenticated browser receives and uses short-lived TURN ICE servers', async ({ page }) => {
  const expiresAt = Date.now() + 3600000;
  const iceServers = [
    { urls: ['stun:127.0.0.1:3478'] },
    { urls: ['turn:127.0.0.1:3478?transport=udp', 'turns:127.0.0.1:5349?transport=tcp'], username: `${Math.floor(expiresAt / 1000)}:node-a`, credential: 'short-lived-password' },
  ];
  const central = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ expiresAt, ttlMs: 3600000, iceServers })); });
  central.listen(0, '127.0.0.1'); await once(central, 'listening');
  const endpoint = `http://127.0.0.1:${central.address().port}/api/turn-credentials`;
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true,
    selfhostNode: { slug: 'node-a', nodeId: 'a'.repeat(32), credential: 'cocn_' + 'b'.repeat(43), turnEndpoint: endpoint } });
  await page.addInitScript(() => {
    if (window === window.top) window.__iceConfigs = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(config) { super(config); window.top.__iceConfigs?.push(config?.iceServers || []); } };
  });
  try {
    await page.goto(app.config.origin);
    await page.locator('#password').fill(app.config.password);
    await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect.poll(() => page.evaluate(() => window.__iceConfigs.some(list => list.some(server => [server.urls].flat().some(url => url.startsWith('turn:')))))).toBe(true);
    const used = await page.evaluate(() => window.__iceConfigs.find(list => list.some(server => [server.urls].flat().some(url => url.startsWith('turn:')))));
    expect(used).toEqual(iceServers);
  } finally {
    await app.close(); await new Promise(resolve => { central.close(resolve); central.closeAllConnections(); });
  }
});
