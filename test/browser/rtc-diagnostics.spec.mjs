import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

// Inject only the stalled phase. The page runs the actual transport deadline,
// cancellation and diagnostics code; other RTC suites exercise real UDP/DTLS.
for (const phase of ['signaling', 'ice', 'channel']) {
  test(`${phase} timeout identifies the failed phase and closes the peer without activating a desktop`, async ({ page, context }) => {
    const app = await fixture({ webrtc: true });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    try {
      await app.login(); await app.claim();
      const equals = app.cookie.indexOf('=');
      await context.addCookies([{ name: app.cookie.slice(0, equals), value: app.cookie.slice(equals + 1), url: app.config.origin }]);
      await page.goto(app.config.origin + '/healthz'); await page.clock.install();
      let requested = false;
      await page.route('**/api/desktop/rtc', async route => {
        requested = true;
        if (phase === 'signaling') await hold;
        await route.fulfill({ json: { type: 'answer', sdp: 'injected stalled phase' } }).catch(() => {});
      });
      await page.evaluate(async ({ viewer, phase }) => {
        const Native = RTCPeerConnection;
        window.RTCPeerConnection = class extends Native {
          constructor(...args) { super(...args); window.diagnosticPeer = this; }
          async setRemoteDescription() { window.answerApplied = true; }
          get iceConnectionState() { return phase === 'channel' ? 'connected' : 'checking'; }
        };
        window.rtcFailures = [];
        const { desktopTransport } = await import('/desktop/rtc.js');
        window.diagnosticTransport = await desktopTransport(viewer, () => {}, { probe: true, failed: reason => window.rtcFailures.push(reason) });
        window.diagnosticStart = window.diagnosticTransport.start().catch(() => {});
      }, { viewer: app.viewer, phase });
      await page.clock.runFor(1600);
      await expect.poll(() => requested).toBe(true);
      if (phase !== 'signaling') await expect.poll(() => page.evaluate(() => window.answerApplied)).toBe(true);
      await page.clock.runFor(12000);
      const reason = phase === 'signaling' ? 'signaling-timeout' : phase === 'ice' ? 'ice-timeout' : 'channel-timeout';
      await expect.poll(() => page.evaluate(() => window.rtcFailures)).toEqual([reason]);
      expect(await page.evaluate(() => window.diagnosticPeer.connectionState)).toBe('closed');
      expect(app.vncConnections).toBe(0); expect(app.terminalConnections).toBe(0); expect(app.inputCalls).toEqual([]);
    } finally { release(); await app.close(); }
  });
}

test('terminal fallback displays the UDP timeout phase in connection status and keeps one authenticated WSS without replay', async ({ page }) => {
  const app = await fixture({ webrtc: true }), writes = { login: 0, claim: 0, rtc: 0, ws: 0, input: 0 };
  page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/terminal/connect') writes.ws++; });
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/login') writes.login++;
    if (path === '/api/desktop/claim') writes.claim++;
    if (path === '/api/terminal/rtc') writes.rtc++;
    if (/^\/api\/(paste|key|terminal)$/.test(path)) writes.input++;
  });
  try {
    await page.addInitScript(() => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal' }));
      if (location.pathname !== '/terminal/index.html') return;
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        async setRemoteDescription() {}
        get iceConnectionState() { return 'checking'; }
      };
    });
    await page.route('**/api/terminal/rtc', route => route.fulfill({ json: { type: 'answer', sdp: 'injected stalled ICE' } }));
    await page.clock.install(); await page.goto(app.config.origin);
    await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await page.clock.runFor(1600); await expect.poll(() => writes.rtc).toBe(1); await page.clock.runFor(12000);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#connection-button').click();
    await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 文字终端');
    await expect(page.locator('#diag-direct-status')).toHaveText('直连 UDP 探测超时；请检查浏览器本地网络权限及 UDP 通道');
    expect(writes).toEqual({ login: 1, claim: 1, rtc: 1, ws: 1, input: 0 });
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.vncConnections).toBe(0);
  } finally { await app.close(); }
});
