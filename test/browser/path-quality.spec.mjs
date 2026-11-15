import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });

async function setup(page, profile) {
  await page.addInitScript(profile => {
    if (window === parent) {
      window.pathProfile = profile; window.pathEvents = [];
      addEventListener('message', event => { if (event.origin === location.origin && event.data?.type === 'codex-network-event' && window.pathEvents.length < 200) window.pathEvents.push(event.data.event); });
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', networkDebug: true }));
    }
    window.pathPeers = []; window.pathSockets = [];
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); if (new URL(this.url).pathname !== '/session/connect') return; window.pathSockets.push(this); this.heldAcks = [];
        this.addEventListener('message', event => {
          if (!event.isTrusted) return;
          const value = JSON.parse(event.data);
          if (value.type === 'input-ack' && parent.pathProfile.holdAcks && this.heldAcks.length < 64) { event.stopImmediatePropagation(); this.heldAcks.push(event.data); return; }
          if (value.type !== 'pong') return;
          event.stopImmediatePropagation(); setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })), parent.pathProfile.relay);
        });
      }
    };
    const PC = RTCPeerConnection;
    window.RTCPeerConnection = class extends PC {
      constructor(...args) { super(...args); window.pathPeers.push(this); }
      async getStats(...args) {
        if (parent.pathProfile.stallStats) return new Promise(() => {});
        const stats = await super.getStats(...args); return parent.pathProfile.turn ? new Map([...stats].map(([id, row]) => [id, /^(?:local|remote)-candidate$/.test(row.type) ? { ...row, candidateType: 'relay' } : row])) : stats;
      }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        if (label === 'codex-stream') {
          const buffered = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount').get;
          Object.defineProperty(channel, 'bufferedAmount', { get: () => parent.pathProfile.directBuffered ?? buffered.call(channel) });
        }
        if (['codex-stream', 'codex-health'].includes(label)) channel.addEventListener('message', event => {
          if (!event.isTrusted || !(event.data instanceof ArrayBuffer)) return;
          let pong = label === 'codex-health';
          try { pong ||= JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 4))).type === 'pong'; } catch {}
          if (!pong) return;
          event.stopImmediatePropagation(); setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: event.data })), parent.pathProfile.direct);
        });
        return channel;
      }
    };
  }, profile);
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}

test('unresolved RTC statistics cannot indefinitely block a healthy direct candidate or service link', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await setup(page, { relay: 350, direct: 1, turn: false, stallStats: true }); const frame = await login(page, app);
    await expect.poll(() => frame.evaluate(() => window.pathPeers.some(peer => peer.connectionState === 'connected'))).toBe(true);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 10000 });
    await page.locator('#files-button').click(); await page.locator('#close-files').click();
    await page.locator('#connection-button').click();
    await expect(page.locator('#connection-trace-current')).toContainText('文件与映射服务：已连接 · WebRTC');
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('an unconfirmed input explains the blocked promotion, then acknowledgment releases it without replaying input', async ({ page }, testInfo) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await setup(page, { relay: 20, direct: 250, turn: false }); const frame = await login(page, app);
    await expect(page.locator('#diag-direct-status')).toContainText('保留当前延迟更低');
    await page.evaluate(() => { window.pathProfile.holdAcks = true; });
    await frame.locator('.xterm-helper-textarea').press('x');
    await expect.poll(() => app.terminalInputs.map(value => value.text).join('')).toBe('x');
    // Apple's retained editing context correctly blocks handoff while the
    // textarea has focus. End that edit so this case isolates the missing ACK.
    await frame.locator('.xterm-helper-textarea').evaluate(field => field.blur());
    await expect.poll(() => frame.evaluate(() => window.pathSockets.some(socket => socket.heldAcks.length > 0))).toBe(true);
    // WebKit may report an unknown route, which requires a clear latency
    // improvement. Slow the old path so ACK admission, rather than smoothed
    // quality measurements near that threshold, determines this assertion.
    await page.evaluate(() => { window.pathProfile.direct = 1; window.pathProfile.relay = 300; });
    await expect.poll(() => page.evaluate(() => window.pathEvents.some(event => event.type === 'probe-waiting' && event.reason === 'input-unconfirmed' && event.pendingInputs > 0)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#diag-transport')).toContainText('WebSocket');
    await page.evaluate(() => { window.pathProfile.holdAcks = false; });
    await frame.evaluate(() => { for (const socket of window.pathSockets) for (const data of socket.heldAcks.splice(0)) socket.dispatchEvent(new MessageEvent('message', { data })); });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 10000 });
    expect(app.terminalInputs.map(value => value.text).join('')).toBe('x'); expect(app.terminalConnections).toBe(1);
  } catch (error) {
    await testInfo.attach('network-events', { body: JSON.stringify(await page.evaluate(() => window.pathEvents)), contentType: 'application/json' });
    throw error;
  } finally { await app.close(); }
});

for (const turn of [false, true, 'unknown']) test(`${turn === 'unknown' ? 'unknown-route' : turn ? 'TURN' : 'direct'} candidate keeps faster WSS, then reuses the same peer when quality improves`, async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true }); let offers = 0;
  page.on('request', request => { if (request.url().endsWith('/api/terminal/rtc')) offers++; });
  try {
    await setup(page, { relay: 50, direct: turn ? 50 : 250, turn: turn === true, stallStats: turn === 'unknown' }); const frame = await login(page, app);
    await expect.poll(() => frame.evaluate(() => window.pathPeers.some(peer => peer.connectionState === 'connected'))).toBe(true);
    await expect(page.locator('#diag-direct-status')).toContainText('保留当前延迟更低');
    await expect(page.locator('#diag-transport')).toContainText('WebSocket');
    const src = await page.locator('#desktop-frame').getAttribute('src');
    await page.evaluate(() => { window.pathProfile.direct = 1; });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 18000 });
    expect(offers).toBe(1); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a persistently slower active RTC returns to retained WSS after cooldown without replacing its terminal', async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await setup(page, { relay: 20, direct: 1, turn: false }); const frame = await login(page, app);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    // With a healthy active direct path, quality comparisons concern the
    // standby relay. They must not label that slower candidate as direct.
    await expect.poll(() => page.evaluate(() => window.pathEvents.some(event => event.type === 'probe-waiting' && event.reason === 'quality' && event.path === 'relay'))).toBe(true);
    await page.evaluate(() => { window.pathProfile.direct = 300; });
    // Advance the route cooldown only; real timers, ICE and streams keep running.
    await frame.evaluate(() => { const now = performance.now.bind(performance); performance.now = () => now() + 31000; });
    await expect(page.locator('#diag-transport')).toContainText('WebSocket', { timeout: 18000 });
    expect(await frame.evaluate(() => window.pathSockets.length)).toBe(1);
    expect(await frame.evaluate(() => window.pathPeers.filter(peer => peer.connectionState === 'connected').length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a sustained stream send queue can prefer healthy WSS despite fast independent RTC heartbeats', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await setup(page, { relay: 30, direct: 1, turn: false }); const frame = await login(page, app);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    await page.evaluate(() => { window.pathProfile.directBuffered = 32768; });
    await expect(page.locator('#diag-transport')).toContainText('WebSocket', { timeout: 42000 });
    await page.locator('#connection-button').click();
    await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('通道排队或确认变慢');
    expect(await frame.evaluate(() => window.pathSockets.length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
