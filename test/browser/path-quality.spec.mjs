import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });

async function setup(page, profile) {
  await page.addInitScript(profile => {
    if (window === parent) { window.pathProfile = profile; localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal' })); }
    window.pathPeers = []; window.pathSockets = [];
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); if (new URL(this.url).pathname !== '/session/connect') return; window.pathSockets.push(this);
        this.addEventListener('message', event => {
          if (!event.isTrusted || JSON.parse(event.data).type !== 'pong') return;
          event.stopImmediatePropagation(); setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })), parent.pathProfile.relay);
        });
      }
    };
    const PC = RTCPeerConnection;
    window.RTCPeerConnection = class extends PC {
      constructor(...args) { super(...args); window.pathPeers.push(this); }
      async getStats(...args) { const stats = await super.getStats(...args); return parent.pathProfile.turn ? new Map([...stats].map(([id, row]) => [id, /^(?:local|remote)-candidate$/.test(row.type) ? { ...row, candidateType: 'relay' } : row])) : stats; }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
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

for (const turn of [false, true]) test(`${turn ? 'TURN' : 'direct'} candidate keeps faster WSS, then reuses the same peer when quality improves`, async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true }); let offers = 0;
  page.on('request', request => { if (request.url().endsWith('/api/terminal/rtc')) offers++; });
  try {
    await setup(page, { relay: 50, direct: turn ? 50 : 250, turn }); const frame = await login(page, app);
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
    await page.evaluate(() => { window.pathProfile.direct = 300; });
    // Advance the route cooldown only; real timers, ICE and streams keep running.
    await frame.evaluate(() => { const now = performance.now.bind(performance); performance.now = () => now() + 31000; });
    await expect(page.locator('#diag-transport')).toContainText('WebSocket', { timeout: 18000 });
    expect(await frame.evaluate(() => window.pathSockets.length)).toBe(1);
    expect(await frame.evaluate(() => window.pathPeers.filter(peer => peer.connectionState === 'connected').length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
