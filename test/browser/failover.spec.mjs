import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function instrument(page) {
  await page.addInitScript(() => {
    window.healthTest = { sent: 0, replies: 0, drop: false };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.testPeer = this; }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        if (args[0] === 'codex-health') {
          const send = channel.send.bind(channel);
          channel.send = bytes => { window.healthTest.sent++; if (!window.healthTest.drop) send(bytes); };
          channel.addEventListener('message', () => window.healthTest.replies++);
        }
        return channel;
      }
    };
  });
}
async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
  const frame = page.frames().find(frame => frame.url().includes('/desktop/index.html'));
  await frame.waitForFunction(() => window.testPeer?.connectionState === 'connected');
  return frame;
}
function writes(page) {
  const counts = { login: 0, claim: 0, input: 0, rtc: 0, ws: 0 };
  page.on('websocket', () => counts.ws++);
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) counts.login++;
    if (request.url().endsWith('/api/desktop/claim')) counts.claim++;
    if (request.url().endsWith('/api/desktop/rtc')) counts.rtc++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) counts.input++;
  });
  return counts;
}
async function relay(page) {
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
  await page.getByRole('button', { name: '连接状态', exact: true }).click();
  await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 中转');
  await page.getByRole('button', { name: '关闭连接状态' }).click();
}

test('silent LAN loss after network change promptly starts relay and preserves tall desktop position and draft', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, rfbSize: { width: 1600, height: 3200 }, viewport: true, webrtc: true });
  const counts = writes(page);
  try {
    await instrument(page); const frame = await login(page, app);
    await page.locator('#mobile-input').fill('切到移动网络后保留草稿');
    const top = await frame.evaluate(() => {
      const viewport = document.getElementById('viewport');
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      return viewport.scrollTop;
    });
    expect(top).toBeGreaterThan(100);
    await expect.poll(() => frame.evaluate(() => window.healthTest.replies)).toBeGreaterThan(0);
    const started = Date.now();
    await frame.evaluate(() => { window.healthTest.drop = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => counts.ws, { timeout: 3500 }).toBe(1);
    expect(Date.now() - started).toBeLessThan(3500);
    await relay(page);
    await expect.poll(() => frame.evaluate(() => document.getElementById('viewport').scrollTop)).toBeGreaterThan(top - 3);
    expect(await frame.evaluate(() => document.getElementById('viewport').scrollTop)).toBeLessThan(top + 3);
    await expect(page.locator('#mobile-input')).toHaveValue('切到移动网络后保留草稿');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, rtc: 1, ws: 1 });
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    await frame.evaluate(() => { window.healthTest.drop = false; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => app.vncConnections, { timeout: 15000 }).toBe(3);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密直连');
    await expect.poll(() => frame.evaluate(() => document.getElementById('viewport').scrollTop)).toBeGreaterThan(top - 3);
    expect(await frame.evaluate(() => document.getElementById('viewport').scrollTop)).toBeLessThan(top + 3);
    await expect(page.locator('#mobile-input')).toHaveValue('切到移动网络后保留草稿');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, rtc: 2, ws: 1 });
  } finally { await app.close(); }
});

test('periodic heartbeats detect a blackhole without browser network or RTC failure events', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }), counts = writes(page);
  try {
    await instrument(page); const frame = await login(page, app);
    await expect.poll(() => frame.evaluate(() => window.healthTest.replies)).toBeGreaterThan(0);
    const started = Date.now();
    await frame.evaluate(() => { window.healthTest.drop = true; });
    await expect.poll(() => counts.ws, { timeout: 6000, intervals: [100] }).toBe(1);
    expect(Date.now() - started).toBeLessThan(6000);
    await relay(page);
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, rtc: 1, ws: 1 });
  } finally { await app.close(); }
});

test('network checks coexist with pending input; lost replies remain unknown without replay', async ({ page }) => {
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, inputHook: async () => { entered(); await hold; } });
  const counts = writes(page);
  try {
    await instrument(page); const frame = await login(page, app);
    await page.getByRole('button', { name: 'Enter ↵' }).click(); await started;
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => frame.evaluate(() => window.healthTest.replies)).toBeGreaterThan(0);
    expect(counts.ws).toBe(0); expect(app.inputCalls).toHaveLength(1);
    await frame.evaluate(() => { window.healthTest.drop = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => counts.ws, { timeout: 3500 }).toBe(1);
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    release(); await relay(page);
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]); expect(counts.input).toBe(0); expect(counts.rtc).toBe(1);
  } finally { release(); await app.close(); }
});

test('healthy network changes retain LAN; hidden and offline pages pause checks then verify afresh', async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }), counts = writes(page);
  try {
    await instrument(page); const frame = await login(page, app);
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => frame.evaluate(() => window.healthTest.replies)).toBeGreaterThan(0);
    expect(app.vncConnections).toBe(1); expect(counts.ws).toBe(0);
    await frame.evaluate(() => {
      window.fakeHidden = false; window.fakeOnline = true;
      Object.defineProperty(document, 'hidden', { get: () => window.fakeHidden, configurable: true });
      Object.defineProperty(navigator, 'onLine', { get: () => window.fakeOnline, configurable: true });
      window.healthTest.drop = true; window.dispatchEvent(new Event('online'));
    });
    await expect.poll(() => frame.evaluate(() => window.healthTest.sent)).toBeGreaterThan(1);
    await frame.evaluate(() => { window.fakeHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    const sent = await frame.evaluate(() => window.healthTest.sent);
    await page.waitForTimeout(2300); expect(counts.ws).toBe(0);
    expect(await frame.evaluate(() => window.healthTest.sent)).toBe(sent);
    await frame.evaluate(() => { window.fakeHidden = false; window.fakeOnline = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('offline')); });
    await page.waitForTimeout(2300); expect(counts.ws).toBe(0);
    expect(await frame.evaluate(() => window.healthTest.sent)).toBe(sent);
    await frame.evaluate(() => { window.fakeOnline = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => counts.ws, { timeout: 3500 }).toBe(1);
    await relay(page); expect(counts.rtc).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('takeover cancels a pending health check and the old viewer cannot reconnect or reclaim', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }), counts = writes(page);
  try {
    await instrument(page); const frame = await login(page, app);
    await frame.evaluate(() => { window.healthTest.drop = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => frame.evaluate(() => window.healthTest.sent)).toBeGreaterThan(0);
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin);
      await expect(second.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
      await expect(page.locator('#takeover-button')).toBeVisible();
      const attempts = { ...counts };
      await page.waitForTimeout(2500);
      expect(counts).toEqual(attempts); expect(counts.claim).toBe(1); expect(counts.login).toBe(1);
      expect(app.vncConnections).toBe(2); expect(app.inputCalls).toEqual([]);
    } finally { await second.close(); }
  } finally { await app.close(); }
});

test('the new video protocol waits for the attached noVNC client before connecting the VNC upstream', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true });
  try {
    await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...args) {
        const channel = create.apply(this, args);
        if (args[0] === 'codex-vnc') {
          window.videoProtocol = channel.protocol;
          const send = channel.send.bind(channel);
          let held = false;
          channel.send = bytes => {
            if (!held && bytes.byteLength === 1 && new Uint8Array(bytes.buffer || bytes)[0] === 0) {
              held = true;
              window.releaseVideo = () => send(bytes);
            } else send(bytes);
          };
        }
        return channel;
      };
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect.poll(() => page.frames().some(frame => frame.url().includes('/desktop/index.html'))).toBe(true);
    const frame = page.frames().find(frame => frame.url().includes('/desktop/index.html'));
    await frame.waitForFunction(() => !!window.releaseVideo);
    expect(await frame.evaluate(() => window.videoProtocol)).toBe('rfb-ready-v1');
    await page.waitForTimeout(300); expect(app.vncConnections).toBe(0);
    await frame.evaluate(() => window.releaseVideo());
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('malformed video readiness cannot reach VNC and safely falls back to the authenticated relay', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true });
  let beforeFallback;
  app.panel.server.on('upgrade', () => { beforeFallback = app.vncConnections; });
  try {
    await instrument(page);
    await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...args) {
        const channel = create.apply(this, args), send = channel.send.bind(channel);
        if (args[0] === 'codex-vnc') channel.send = bytes => send(bytes.byteLength === 1 ? new Uint8Array([0, 1]) : bytes);
        return channel;
      };
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await relay(page);
    expect(beforeFallback).toBe(0); expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
