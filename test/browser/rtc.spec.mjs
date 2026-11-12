import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
}

test('real WebRTC and noVNC connect over UDP without a WebSocket; takeover and reconnect never replay input', async ({ page, context }) => {
  const app = await fixture({ rfb: true, webrtc: true });
  let websocketCount = 0, inputs = 0;
  page.on('websocket', () => websocketCount++);
  page.on('request', request => { if (/\/api\/(paste|key|terminal)$/.test(request.url()) && request.method() === 'POST') inputs++; });
  try {
    await page.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeer = this; } };
    });
    await login(page, app);
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-transport')).toHaveText(/^WebRTC 加密直连(?:（局域网）)?$/);
    await expect(page.locator('#diag-resolution')).toHaveText('1600 × 1600');
    expect(websocketCount).toBe(0);
    const transport = await page.frames().find(frame => frame.url().includes('/desktop/index.html')).evaluate(async () => {
      const stats = await window.testPeer.getStats();
      return [...stats.values()].find(item => item.type === 'transport');
    });
    expect(transport.dtlsState).toBe('connected');
    expect(transport.dtlsCipher).toBeTruthy();
    expect(transport.selectedCandidatePairId).toBeTruthy();
    await page.getByRole('button', { name: '关闭连接状态' }).click();
    await openInput(page); await page.getByLabel('要粘贴到桌面的文字').fill('保持草稿，不要重放');
    const second = await context.newPage();
    await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
    await expect(page.locator('#takeover-button')).toBeVisible();
    expect(app.inputCalls).toEqual([]);
    expect(inputs).toBe(0);
    await second.close();
    await page.locator('#takeover-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
    await expect(page.getByLabel('要粘贴到桌面的文字')).toHaveValue('保持草稿，不要重放');
    expect(app.inputCalls).toEqual([]);
    expect(inputs).toBe(0);
  } finally { await app.close(); }
});

test('failed direct negotiation falls back to WebSocket without resubmitting login, claim or input', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true });
  const writes = { login: 0, claim: 0, input: 0, rtc: 0 };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) writes.login++;
    if (request.url().endsWith('/api/desktop/claim')) writes.claim++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) writes.input++;
    if (request.url().endsWith('/api/desktop/rtc')) writes.rtc++;
  });
  try {
    await page.route('**/api/desktop/rtc', route => route.fulfill({ status: 503, json: { error: '模拟 UDP 不可用' } }));
    await login(page, app);
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 中转');
    expect(writes).toEqual({ login: 1, claim: 1, input: 0, rtc: 1 });
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a mismatched DTLS fingerprint cannot open VNC and falls back to the authenticated WebSocket', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true });
  let vncBeforeFallback;
  // Observe the server event before the async WS authorization can open VNC.
  // Playwright's websocket notification may arrive after that connection.
  app.panel.server.on('upgrade', () => { vncBeforeFallback = app.vncConnections; });
  try {
    await page.route('**/api/desktop/rtc', route => {
      const body = route.request().postDataJSON();
      body.sdp = body.sdp.replace(/a=fingerprint:sha-256 [^\r\n]+/, 'a=fingerprint:sha-256 ' + Array(32).fill('00').join(':'));
      return route.continue({ postData: JSON.stringify(body) });
    });
    await login(page, app);
    expect(vncBeforeFallback).toBe(0);
    expect(app.vncConnections).toBe(1);
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 中转');
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
