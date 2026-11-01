import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function loginRelay(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
  await page.getByRole('button', { name: '连接状态', exact: true }).click();
  await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 中转');
  await page.getByRole('button', { name: '关闭连接状态' }).click();
}
function writes(page) {
  const result = { login: 0, claim: 0, input: 0 };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) result.login++;
    if (request.url().endsWith('/api/desktop/claim')) result.claim++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) result.input++;
  }); return result;
}

test('background negotiation keeps relay alive until encrypted direct activation and preserves the draft and view', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, webrtc: true }), hold = gate(), answered = gate();
  const requests = writes(page); let offers = 0, closed = 0;
  page.on('websocket', socket => socket.on('close', () => closed++));
  await page.clock.install();
  await page.route('**/api/desktop/rtc', async route => {
    if (++offers === 1) return route.fulfill({ status: 503, json: { error: '首次直连不可用' } });
    const response = await route.fetch(); answered.release(); await hold.promise;
    await route.fulfill({ response });
  });
  try {
    await loginRelay(page, app);
    await page.locator('#mobile-input').fill('网络路径切换后保留草稿');
    await page.locator('#actual-size-button').click();
    await page.clock.fastForward(16000); await answered.promise;
    expect(closed).toBe(0); expect(app.vncConnections).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    hold.release();
    await expect.poll(() => closed, { timeout: 15000 }).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 15000 });
    await page.getByRole('button', { name: '连接状态', exact: true }).click();
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密直连');
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密直连');
    await expect(page.locator('#mobile-input')).toHaveValue('网络路径切换后保留草稿');
    await expect(page.locator('#actual-size-button')).toHaveAttribute('aria-pressed', 'true');
    expect(offers).toBe(2); expect(app.vncConnections).toBe(2);
    expect(requests).toEqual({ login: 1, claim: 1, input: 0 }); expect(app.inputCalls).toEqual([]);
  } finally { hold.release(); await app.close(); }
});

test('failed probes keep the relay and later network change promotes direct without replaying accepted input', async ({ page }) => {
  test.setTimeout(60000);
  const hold = gate(), started = gate();
  const app = await fixture({ rfb: true, webrtc: true, inputHook: async () => { started.release(); await hold.promise; } });
  const requests = writes(page); let offers = 0, available = false, closed = 0;
  page.on('websocket', socket => socket.on('close', () => closed++));
  await page.clock.install();
  await page.route('**/api/desktop/rtc', route => {
    offers++;
    return available ? route.continue() : route.fulfill({ status: 503, json: { error: '局域网暂不可达' } });
  });
  try {
    await loginRelay(page, app);
    await page.clock.fastForward(16000);
    await expect.poll(() => offers).toBe(2);
    expect(closed).toBe(0); expect(app.vncConnections).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.getByRole('button', { name: 'Enter ↵' }).click(); await started.promise;
    available = true;
    await page.frames().find(frame => frame.url().includes('/desktop/index.html')).evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    expect(closed).toBe(0); expect(app.inputCalls).toHaveLength(1);
    hold.release();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await page.frames().find(frame => frame.url().includes('/desktop/index.html')).evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => closed, { timeout: 15000 }).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]);
    expect(requests).toEqual({ login: 1, claim: 1, input: 1 });
  } finally { hold.release(); await app.close(); }
});

test('takeover cancels a pending background probe without disturbing the new viewer', async ({ page, context }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, webrtc: true }), hold = gate(), answered = gate();
  let offers = 0;
  await page.clock.install();
  await page.route('**/api/desktop/rtc', async route => {
    if (++offers === 1) return route.fulfill({ status: 503, json: { error: '首次直连不可用' } });
    const response = await route.fetch(); answered.release(); await hold.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await loginRelay(page, app); await page.clock.fastForward(16000); await answered.promise;
    expect(app.vncConnections).toBe(1);
    const second = await context.newPage(); await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
    hold.release();
    await expect(page.locator('#takeover-button')).toBeVisible();
    expect(app.vncConnections).toBe(2); expect(app.inputCalls).toEqual([]);
    await second.close();
  } finally { hold.release(); await app.close(); }
});

test('periodic probing continues after failure and upgrades later without any network event or refresh', async ({ page }) => {
  test.setTimeout(60000);
  // Keep this timer/connection test independent of large framebuffer delivery.
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }); let offers = 0, closed = 0;
  const requests = writes(page);
  page.on('websocket', socket => socket.on('close', () => closed++));
  await page.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeer = this; } };
  });
  await page.clock.install();
  await page.route('**/api/desktop/rtc', route => {
    return ++offers < 3 ? route.fulfill({ status: 503, json: { error: '前两次直连不可用' } }) : route.continue();
  });
  try {
    await loginRelay(page, app);
    await page.clock.fastForward(16000);
    await expect.poll(() => offers).toBe(2);
    await page.frames().find(frame => frame.url().includes('/desktop/index.html')).waitForFunction(() => window.testPeer?.connectionState === 'closed');
    expect(offers).toBe(2); expect(closed).toBe(0); expect(app.vncConnections).toBe(1);
    await page.clock.fastForward(31000);
    await expect.poll(() => closed, { timeout: 15000 }).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(offers).toBe(3); expect(app.vncConnections).toBe(2);
    expect(requests).toEqual({ login: 1, claim: 1, input: 0 }); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('holding a native key postpones probing until the release has reached the existing stream', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, webrtc: true }); let offers = 0, closed = 0, keys = 0;
  page.on('websocket', socket => {
    socket.on('close', () => closed++);
    socket.on('framesent', ({ payload }) => { if (Buffer.isBuffer(payload) && payload.length === 8 && payload[0] === 4) keys++; });
  });
  await page.clock.install();
  await page.route('**/api/desktop/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
  try {
    await loginRelay(page, app);
    await page.frameLocator('#desktop-frame').locator('#screen canvas').click({ position: { x: 100, y: 100 } });
    await page.keyboard.down('Shift');
    await page.clock.fastForward(16000); await page.waitForTimeout(300);
    expect(offers).toBe(1); expect(closed).toBe(0);
    await page.keyboard.up('Shift');
    await page.clock.fastForward(6000);
    await expect.poll(() => closed, { timeout: 15000 }).toBe(1);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(keys).toBe(2); expect(offers).toBe(2); expect(app.inputCalls).toEqual([]);
  } finally { await page.keyboard.up('Shift'); await app.close(); }
});
