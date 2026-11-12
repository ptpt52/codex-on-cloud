import { openInput, openTools } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function instrument(page, holdReady = false) {
  await page.addInitScript(({ holdReady }) => {
    if (location.pathname !== '/terminal/index.html') return;
    const Native = window.WebSocket;
    window.terminalHealthTest = { sent: 0, replies: [], held: [], opened: 0, socket: null, dropSocket: null, holdSocket: null, stallClose: false, closeCalls: 0, holdReady, startup: [] };
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname !== '/terminal/connect') return;
        const state = window.terminalHealthTest; state.socket = this; state.opened++;
        this.addEventListener('message', event => {
          if (state.holdReady) { event.stopImmediatePropagation(); if (state.startup.length < 16) state.startup.push(event.data); return; }
          const value = JSON.parse(event.data);
          if (value.type === 'health') { state.replies.push(value.nonce); if (state.replies.length > 32) state.replies.shift(); }
        });
      }
      send(data) {
        const state = window.terminalHealthTest;
        let value; try { value = JSON.parse(data); } catch {}
        if (new URL(this.url).pathname === '/terminal/connect' && value?.type === 'health') {
          state.sent++;
          if (this === state.dropSocket) return;
          if (this === state.holdSocket) { if (state.held.length < 16) state.held.push({ socket: this, data }); return; }
        }
        super.send(data);
      }
      close(...args) {
        const state = window.terminalHealthTest;
        if (state.stallClose && this === state.dropSocket && this.readyState === Native.OPEN) { state.closeCalls++; return; }
        super.close(...args);
      }
    };
    window.releaseTerminalHealth = () => { const record = window.terminalHealthTest.held.shift(); if (record?.socket.readyState === Native.OPEN) Native.prototype.send.call(record.socket, record.data); };
    window.releaseTerminalReady = () => {
      const state = window.terminalHealthTest; state.holdReady = false;
      for (const data of state.startup.splice(0)) state.socket.dispatchEvent(new MessageEvent('message', { data }));
    };
  }, { holdReady });
}
function writes(page) {
  const counts = { login: 0, claim: 0, input: 0 };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) counts.login++;
    if (request.url().endsWith('/api/desktop/claim')) counts.claim++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) counts.input++;
  });
  return counts;
}
async function login(page, app, target = 'main') {
  await instrument(page);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#terminal-mode')).toBeEnabled();
  await openInput(page);
  if (target !== 'main') { await openInput(page); await page.locator('#input-terminal').selectOption(target); }
  await page.locator('#mobile-input').fill('网络恢复后仍保留这段草稿');
  await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click(); await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
async function online(page) { await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 15000 }); }

test('periodic probes replace a silently lost OPEN socket without waiting for close and preserve the selected terminal, font and draft', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }), counts = writes(page);
  try {
    await app.controls.manageTerminals({ action: 'create', name: '保留任务', view: 'terminal' });
    const before = (await app.controls.listTerminals()).terminals.map(({ id, token }) => ({ id, token }));
    const frame = await login(page, app, 'aux1'); await openTools(page); await page.locator('#terminal-font-up').click(); await openTools(page); await page.locator('#terminal-font-up').click();
    expect(await frame.evaluate(() => { const state = window.terminalHealthTest; state.dropSocket = state.socket; state.stallClose = true; return state.socket.readyState; })).toBe(1);
    // Detection can consume a 3s schedule plus a 6s probe and 2s confirmation
    // before the replacement connection starts. Keep that product budget plus
    // transport setup separate from this browser's scheduling latency.
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.opened), { timeout: 15000, intervals: [100] }).toBe(2);
    await online(page);
    expect(await frame.evaluate(() => window.terminalHealthTest.closeCalls)).toBeGreaterThan(0);
    await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#terminal-font-label')).toHaveText(page.viewportSize().width <= 700 ? '12' : '17');
    await expect(page.locator('#mobile-input')).toHaveValue('网络恢复后仍保留这段草稿');
    expect((await app.controls.listTerminals()).terminals.map(({ id, token }) => ({ id, token }))).toEqual(before);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0); expect(counts).toEqual({ login: 1, claim: 1, input: 0 });
  } finally { await app.close(); }
});

test('repeated network change events cannot postpone the new probe deadline', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => {
      const state = window.terminalHealthTest; state.dropSocket = state.socket; state.stallClose = true;
      const changed = () => navigator.connection ? navigator.connection.dispatchEvent(new Event('change')) : window.dispatchEvent(new Event('online'));
      changed(); window.networkStorm = setInterval(changed, 100);
    });
    try { await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.opened), { timeout: 7000, intervals: [100] }).toBe(2); }
    finally { await frame.evaluate(() => clearInterval(window.networkStorm)); }
    await online(page); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('network event bursts preserve a new connection while its terminal handshake is pending', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await instrument(page, true);
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click();
    await expect.poll(() => page.frames().find(frame => frame.url().includes('/terminal/index.html'))?.url()).toBeTruthy();
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.startup.length)).toBeGreaterThan(0);
    await frame.evaluate(() => {
      const changed = () => navigator.connection ? navigator.connection.dispatchEvent(new Event('change')) : window.dispatchEvent(new Event('online'));
      changed(); window.networkStorm = setInterval(changed, 100);
    });
    try {
      await page.waitForTimeout(750);
      expect(await frame.evaluate(() => window.terminalHealthTest.opened)).toBe(1); expect(app.terminalConnections).toBe(1);
      await frame.evaluate(() => window.releaseTerminalReady()); await online(page);
    } finally { await frame.evaluate(() => clearInterval(window.networkStorm)); }
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('probes coexist with accepted input and a lost result stays unknown after recovery without an HTTP resend', async ({ page }) => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, terminalHook: async () => { entered(); await hold; } }), counts = writes(page);
  try {
    const frame = await login(page, app); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('[data-key="Enter"]').click(); await started;
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.replies.length)).toBeGreaterThan(0);
    expect(app.terminalConnections).toBe(1); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'pending');
    await frame.evaluate(() => { const state = window.terminalHealthTest; state.dropSocket = state.socket; state.stallClose = true; window.dispatchEvent(new Event('online')); });
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown', { timeout: 3500 });
    await expect(page.locator('#connection-notice')).toContainText('结果未知');
    release(); await expect.poll(() => app.terminalConnections).toBe(2); await online(page);
    await expect(page.locator('#connection-notice')).toContainText('不会自动重发');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\r' }]); expect(counts).toEqual({ login: 1, claim: 1, input: 0 }); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});

test('background and offline states cancel probes and reconnect only after returning online in the foreground', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => {
      window.fakeHidden = false; window.fakeOnline = true;
      Object.defineProperty(document, 'hidden', { get: () => window.fakeHidden, configurable: true });
      Object.defineProperty(navigator, 'onLine', { get: () => window.fakeOnline, configurable: true });
      window.terminalHealthTest.holdSocket = window.terminalHealthTest.socket; window.dispatchEvent(new Event('online'));
    });
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.sent)).toBeGreaterThan(0);
    await frame.evaluate(() => { window.fakeHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    const sent = await frame.evaluate(() => window.terminalHealthTest.sent);
    await page.waitForTimeout(2250); expect(app.terminalConnections).toBe(1); expect(await frame.evaluate(() => window.terminalHealthTest.sent)).toBe(sent);
    await frame.evaluate(() => { window.fakeOnline = false; window.dispatchEvent(new Event('offline')); window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(2250); expect(app.terminalConnections).toBe(1); expect(await frame.evaluate(() => window.terminalHealthTest.sent)).toBe(sent);
    await frame.evaluate(() => { window.fakeOnline = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => app.terminalConnections).toBe(2); await online(page); expect(app.terminalInputs).toEqual([]); expect((await app.controls.get()).session.pid).toBe(4000);
  } finally { await app.close(); }
});

test('an old echo after foreground recovery cannot satisfy a fresh probe', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => {
      window.fakeHidden = false; Object.defineProperty(document, 'hidden', { get: () => window.fakeHidden, configurable: true });
      window.terminalHealthTest.holdSocket = window.terminalHealthTest.socket; window.dispatchEvent(new Event('online'));
    });
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.held.length)).toBe(1);
    await frame.evaluate(() => { window.fakeHidden = true; document.dispatchEvent(new Event('visibilitychange')); window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.held.length)).toBe(2);
    await frame.evaluate(() => window.releaseTerminalHealth());
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.replies.length)).toBe(1);
    expect(app.terminalConnections).toBe(1);
    await expect.poll(() => app.terminalConnections, { timeout: 5500 }).toBe(2); await online(page); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('page lifecycle restoration reattaches only and takeover disposes the old probe without reclaiming', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }), counts = writes(page);
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => app.terminalConnections).toBe(2); await online(page);
    await frame.evaluate(() => { window.terminalHealthTest.holdSocket = window.terminalHealthTest.socket; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => frame.evaluate(() => window.terminalHealthTest.held.length)).toBeGreaterThan(0);
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('终端在线');
      await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });
      const before = { ...counts }; await page.waitForTimeout(2250); expect(counts).toEqual(before);
      expect(app.terminalConnections).toBe(3); expect(app.terminalInputs).toEqual([]); expect((await app.controls.get()).session.pid).toBe(4000);
    } finally { await second.close(); }
  } finally { await app.close(); }
});
