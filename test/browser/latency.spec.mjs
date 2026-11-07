import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });

async function instrument(page, mode = 'terminal') {
  await page.addInitScript(({ mode }) => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, zoom: 'width', collapsed: true, terminalInputCollapsed: true }));
    window.latencyPeers = []; window.latencySockets = [];
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname !== '/session/connect') return;
        window.latencySockets.push(this);
        this.addEventListener('message', event => {
          if (!event.isTrusted || JSON.parse(event.data).type !== 'pong') return;
          event.stopImmediatePropagation();
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })), 200);
        });
      }
    };
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); if (window.latencyPeers.length < 16) window.latencyPeers.push(this); }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        if (['codex-stream', 'codex-health'].includes(label)) channel.addEventListener('message', event => {
          if (!event.isTrusted || !(event.data instanceof ArrayBuffer)) return;
          let pong = label === 'codex-health';
          if (!pong) {
            try { pong = JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 4))).type === 'pong'; } catch {}
          }
          if (!pong) return;
          event.stopImmediatePropagation();
          setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: event.data })), 600);
        });
        return channel;
      }
    };
  }, { mode });
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('在线');
}
async function measured(page, minimum) {
  await expect(page.locator('#diag-latency')).toHaveText(/^\d+ ms$/, { timeout: 7000 });
  await expect.poll(async () => Number.parseInt(await page.locator('#diag-latency').textContent()), { timeout: 7000 }).toBeGreaterThanOrEqual(minimum);
}

for (const mode of ['desktop', 'terminal']) test(`${mode} relay displays application heartbeat RTT and clears it while backgrounded`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  let healthRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/healthz') healthRequests++; });
  try {
    await instrument(page, mode); await login(page, app);
    await measured(page, 180);
    await expect(page.locator('#diag-latency').locator('..').locator('dt')).toHaveText('往返时间');
    await expect(page.locator('#diag-transport')).toContainText('WebSocket');
    const frame = page.frames().find(value => value.url().includes(mode === 'terminal' ? '/terminal/index.html' : '/desktop/index.html'));
    expect(await frame.evaluate(() => window.latencySockets.length)).toBe(1);
    expect(healthRequests).toBe(0); // Existing stream pings supply the sample.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await frame.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#diag-latency')).toHaveText('—');
    await frame.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await measured(page, 180);
    expect(await frame.evaluate(() => window.latencySockets.length)).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('direct to relay switches display the selected path RTT instead of retained ICE or old path samples', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, webrtc: true });
  try {
    await instrument(page); await login(page, app);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await measured(page, 550);
    const frame = page.frames().find(value => value.url().includes('/terminal/index.html'));
    await frame.evaluate(() => window.latencyPeers.at(-1).close());
    await expect(page.locator('#diag-transport')).toContainText('WebSocket', { timeout: 7000 });
    await measured(page, 180);
    await expect.poll(async () => Number.parseInt(await page.locator('#diag-latency').textContent())).toBeLessThan(550);
    expect(await frame.evaluate(() => window.latencySockets.length)).toBe(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('temporary account measures HTTPS then independent direct RTT without claiming a desktop', async ({ page }) => {
  const app = await fixture({ webrtc: true }), desktopRequests = [];
  let directAllowed = false, healthRequests = 0;
  try {
    await app.login(); await app.claim();
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
    await instrument(page);
    await page.route('**/api/service/rtc', route => directAllowed ? route.continue() : route.fulfill({ status: 503, json: { error: 'injected' } }));
    await page.route('**/healthz', async route => { healthRequests++; await new Promise(resolve => setTimeout(resolve, 150)); await route.continue(); });
    page.on('request', request => { if (/\/api\/(desktop\/claim|desktop\/rtc|terminal\/rtc)$/.test(new URL(request.url()).pathname)) desktopRequests.push(request.url()); });
    await page.goto(app.config.origin); await page.locator('#username').fill('visitor'); await page.locator('#password').fill('temporary-test-password'); await page.locator('#login-button').click();
    await expect(page.locator('#user-label')).toContainText('临时访问');
    await measured(page, 140); await expect(page.locator('#diag-latency')).toHaveAttribute('title', /HTTPS/);
    expect(healthRequests).toBe(1);
    directAllowed = true; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await measured(page, 550); await expect(page.locator('#diag-latency')).toHaveAttribute('title', /数据通道/);
    const before = healthRequests;
    await page.waitForTimeout(3300); expect(healthRequests).toBe(before);
    directAllowed = false; await page.evaluate(() => window.latencyPeers.at(-1).close());
    await expect(page.locator('#diag-transport')).toContainText('HTTPS', { timeout: 7000 });
    await measured(page, 140); await expect(page.locator('#diag-latency')).toHaveAttribute('title', /HTTPS/);
    expect(desktopRequests).toEqual([]); expect(app.vncConnections).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('legacy desktop relay displays uncached HTTPS request RTT without a new desktop connection', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.route('**/healthz', async route => { await new Promise(resolve => setTimeout(resolve, 150)); await route.continue(); });
    await login(page, app); await measured(page, 140);
    await expect(page.locator('#diag-latency')).toHaveAttribute('title', /HTTPS/);
    expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
