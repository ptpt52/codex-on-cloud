import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

// HTTP failure injection must reach Playwright rather than the offline worker.
test.use({ serviceWorkers: 'block' });
async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    window.streamSockets = []; const Native = WebSocket;
    window.streamHealthPings = 0;
    window.streamPeers = []; const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.streamPeers.push(this); }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        if (label === 'codex-health') { const send = channel.send.bind(channel); channel.send = bytes => { window.streamHealthPings++; send(bytes); }; }
        if (label === 'codex-terminal') { const send = channel.send.bind(channel); channel.send = bytes => {
          try { if (JSON.parse(new TextDecoder().decode(bytes.subarray(4))).type === 'health') window.streamHealthPings++; } catch {}
          send(bytes);
        }; }
        channel.addEventListener('message', event => {
          if (!event.isTrusted || !(event.data instanceof ArrayBuffer)) return;
          if (label === 'codex-health' && window.dropHealthPongs) event.stopImmediatePropagation();
          if (label === 'codex-stream' && window.dropDataPongs) {
            try { if (JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 4))).type === 'pong') event.stopImmediatePropagation(); } catch {}
          }
        });
        return channel;
      }
    };
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); if (new URL(this.url).pathname === '/session/connect') window.streamSockets.push(this); }
      addEventListener(type, callback, options) { return super.addEventListener(type, type === 'message' ? event => {
        if (event.isTrusted && window.streamAckDelay && JSON.parse(event.data).type === 'input-ack') { window.streamDelayedAcks = (window.streamDelayedAcks || 0) + 1; setTimeout(() => callback(new MessageEvent('message', { data: event.data })), window.streamAckDelay); return; }
        if (event.isTrusted && window.streamPongDelay && JSON.parse(event.data).type === 'pong') { setTimeout(() => callback(new MessageEvent('message', { data: event.data })), window.streamPongDelay); return; }
        callback(event);
      } : callback, options); }
      send(data) { const v = JSON.parse(data); if (this === window.dropStreamPing && v.type === 'ping') return; super.send(data); }
    };
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}

for (const seamless of [true, false]) test(`an offline hint preserves a working ${seamless ? 'unified' : 'legacy'} LAN peer and resumes with a fresh heartbeat`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless, fastConnect: true, webrtc: true });
  try {
    const frame = await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const before = await frame.evaluate(() => {
      window.retainedNetworkPeers = [...window.streamPeers];
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline'));
      return { peers: window.streamPeers.length, pings: window.streamHealthPings };
    });
    await page.waitForTimeout(2500);
    expect(await frame.evaluate(() => window.retainedNetworkPeers.every(peer => peer.connectionState === 'connected'))).toBe(true);
    expect(await frame.evaluate(() => window.streamPeers.length)).toBe(before.peers);
    expect(await frame.evaluate(() => window.streamHealthPings)).toBe(before.pings);
    await frame.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
    await expect.poll(() => frame.evaluate(() => window.streamHealthPings), { timeout: 5000 }).toBeGreaterThan(before.pings);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(await frame.evaluate(() => window.streamPeers.length)).toBe(before.peers);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a burst of small output chunks does not exhaust the input record limit while relay acknowledgments are in flight', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.streamAckDelay = 600; });
    for (let i = 0; i < 90; i++) app.terminalChildren[0].stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(`line ${i}\r\n`).toString('base64') }) + '\n');
    await page.waitForTimeout(1300);
    expect(await frame.evaluate(() => window.streamSockets.length)).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('continuous terminal output cannot starve a healthy direct handoff while slow relay acknowledgments drain', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true }); let output, release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/terminal/rtc', async route => { await gate; await route.continue(); });
    const frame = await login(page, app), child = app.terminalChildren[0];
    await frame.evaluate(() => { window.streamAckDelay = 2400; window.streamPongDelay = 700; });
    output = setInterval(() => child.stdout.write(JSON.stringify({ type: 'output', data: Buffer.from('background progress\r\n').toString('base64') }) + '\n'), 100);
    await expect.poll(() => frame.evaluate(() => window.streamDelayedAcks || 0)).toBeGreaterThan(0);
    release();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    expect(app.terminalConnections).toBe(1); expect(app.terminalChildren[0]).toBe(child);
    expect(await frame.evaluate(() => window.streamSockets.length)).toBe(1); expect(await frame.evaluate(() => window.streamPeers.length)).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { release(); clearInterval(output); await app.close(); }
});

test('independent RTC heartbeats survive blocked data-stream pongs without replacing its peer or terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true });
  try {
    const frame = await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await frame.evaluate(() => { window.dropDataPongs = true; });
    await expect.poll(() => frame.evaluate(() => window.streamHealthPings), { timeout: 10000 }).toBeGreaterThanOrEqual(5);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(await frame.evaluate(() => window.streamPeers.length)).toBe(1); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a failed independent heartbeat still falls back to the existing relay within a bounded window', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true });
  try {
    const frame = await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await frame.evaluate(() => { window.dropHealthPongs = true; });
    await expect(page.locator('#diag-transport')).toContainText('WebSocket', { timeout: 12000 });
    expect(await frame.evaluate(() => window.streamSockets.length)).toBe(1); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

for (const silent of [false, true]) test(`valid output ${silent ? 'cannot extend a missing heartbeat indefinitely' : 'admits one congestion grace for a delayed heartbeat'}`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true }); let output;
  try {
    const frame = await login(page, app);
    await frame.evaluate(silent => { if (silent) window.dropStreamPing = window.streamSockets[0]; else window.streamPongDelay = 3900; window.dispatchEvent(new Event('online')); }, silent);
    output = setInterval(() => { app.terminalChildren[0]?.stdout.write(JSON.stringify({ type: 'output', data: Buffer.from('progress\r\n').toString('base64') }) + '\n'); }, 250);
    if (silent) await expect.poll(() => frame.evaluate(() => window.streamSockets.length), { timeout: 16000 }).toBe(2);
    else { await page.waitForTimeout(6500); expect(await frame.evaluate(() => window.streamSockets.length)).toBe(1); }
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { clearInterval(output); await app.close(); }
});
test('network event storms cannot postpone a silent path deadline and recovery keeps the sole terminal PTY', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => { window.dropStreamPing = window.streamSockets[0]; window.dispatchEvent(new Event('online')); window.networkStorm = setInterval(() => window.dispatchEvent(new Event('online')), 100); });
    // Startup output may admit a congestion grace; events cannot renew it.
    try { await expect.poll(() => frame.evaluate(() => window.streamSockets.length), { timeout: 16000, intervals: [100] }).toBe(2); }
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
