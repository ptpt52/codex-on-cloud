import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
// A cold manager can miss its first health deadline. Allow the next 4-second
// state poll and viewer handshake to finish before asserting preferences.
const online = page => expect(page.locator('#connection-status')).toContainText('在线', { timeout: 15000 });

async function setup(page, { terminal = true, denied = false } = {}) {
  await page.addInitScript(({ terminal, denied }) => {
    if (window !== parent) return;
    if (denied) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
    else if (!localStorage.getItem('codex-cloud.display.v1')) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: terminal ? 'terminal' : 'desktop' }));
    window.preferenceWake = { requests: 0, active: 0 };
    class Lock extends EventTarget {
      released = false;
      async release() { if (!this.released) { this.released = true; window.preferenceWake.active--; this.dispatchEvent(new Event('release')); } }
    }
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() { window.preferenceWake.requests++; window.preferenceWake.active++; return new Lock(); } } });
  }, { terminal, denied });
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await online(page);
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')));

test('a slow unavailable startup snapshot recovers on the next state poll without repeating login or control claims', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true }); let states = 0, logins = 0, claims = 0;
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/login') logins++;
    if (path === '/api/desktop/claim') claims++;
  });
  await page.route('**/api/state', async route => {
    const response = await route.fetch(), state = await response.json();
    if (++states === 1) {
      // The first response plus the normal poll interval exceeds the default
      // 5-second assertion deadline, as in the cold Chromium CI failure.
      await new Promise(resolve => setTimeout(resolve, 1500));
      state.desktop.ready = false; state.controls.available = false;
    }
    await route.fulfill({ response, json: state });
  });
  try {
    await setup(page); await login(page, app); await openTools(page);
    expect(states).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#terminal-font-label')).toHaveText('15');
    expect(logins).toBe(1); expect(claims).toBe(1);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('separate browser profiles isolate fonts, history and screen-wake preferences while terminal slots and new pages share local choices', async ({ page, browser }) => {
  const app = await fixture({ rfb: true, seamless: true }), secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const global = await app.controls.get(); app.controls.save({ ...global.saved, fontSize: 28, revision: global.revision });
  await app.controls.manageTerminals({ action: 'create', name: '第二终端', view: 'terminal' });
  const remoteWrites = []; page.on('request', req => { if (req.method() === 'POST' && /\/api\/desktop\/(settings|terminal-display)$/.test(new URL(req.url()).pathname)) remoteWrites.push(req.url()); });
  try {
    await setup(page); await login(page, app); await openTools(page);
    await expect(page.locator('#terminal-font-label')).toHaveText('15');
    for (let n = 0; n < 3; n++) await page.locator('#terminal-font-up').click();
    await page.locator('#terminal-width-mode').selectOption('manual'); await page.locator('#terminal-history-rows').selectOption('5000');
    await page.locator('#awake-button').click(); await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    expect((await stored(page)).terminalFontSize).toBe(18);
    const second = await secondContext.newPage(); await setup(second); await login(second, app); await openTools(second);
    await expect(second.locator('#terminal-font-label')).toHaveText('15'); await expect(second.locator('#terminal-history-rows')).toHaveValue('10000');
    await expect(second.locator('#terminal-width-mode')).toHaveValue('viewport'); await expect(second.locator('#awake-button')).toHaveAttribute('aria-pressed', 'false');
    expect(await second.evaluate(() => window.preferenceWake.requests)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.preferenceWake.active)).toBe(0);
    await second.locator('#terminal-font-down').click(); await second.locator('#terminal-width-mode').selectOption('manual');
    const next = await secondContext.newPage(); await setup(next); await next.goto(app.config.origin);
    await online(next); await openTools(next);
    await expect(next.locator('#terminal-font-label')).toHaveText('14'); await expect(next.locator('#awake-button')).toHaveAttribute('aria-pressed', 'false');
    await closePanels(next); await openInput(next); await next.locator('#input-terminal').selectOption('aux1');
    await online(next); await openTools(next);
    await expect(next.locator('#terminal-font-label')).toHaveText('14');
    expect((await stored(page)).terminalFontSize).toBe(18); expect((await stored(page)).terminalHistoryRows).toBe(5000); expect((await stored(page)).keepAwake).toBe(true);
    expect((await app.controls.get()).saved.fontSize).toBe(28); expect(app.managementStats.fontChanges).toBe(0); expect(app.managementStats.saves).toBe(0);
    expect(remoteWrites).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await secondContext.close(); await app.close(); }
});

test('unavailable browser storage keeps controls usable and reports that preferences cannot survive a refresh', async ({ page }) => {
  const app = await fixture({ rfb: true, mode: 'terminal', seamless: true });
  try {
    await setup(page, { denied: true }); await login(page, app); await openTools(page);
    await expect(page.locator('#browser-preferences-note')).toContainText('未能保存');
    await page.locator('#terminal-font-up').click(); await expect(page.locator('#terminal-font-label')).toHaveText('16');
    await page.locator('#awake-button').click(); await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    await page.reload(); await online(page); await openTools(page);
    await expect(page.locator('#terminal-font-label')).toHaveText('15'); await expect(page.locator('#awake-button')).toHaveAttribute('aria-pressed', 'false');
    expect(app.managementStats.saves).toBe(0); expect(app.managementStats.fontChanges).toBe(0); expect(app.managementStats.restarts).toBe(0); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('desktop reading scale belongs to each browser and shared resolution saves never upload a font preference', async ({ page, browser }) => {
  const app = await fixture({ rfb: true }), secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const global = await app.controls.get(); app.controls.save({ ...global.saved, fontSize: 24, revision: global.revision });
  const bodies = [];
  try {
    await setup(page, { terminal: false }); await login(page, app); await openTools(page);
    await expect(page.locator('#zoom-label')).toHaveText(/^\d+%$/); await page.locator('#actual-size-button').click(); await page.locator('#zoom-in-button').click();
    await expect(page.locator('#zoom-label')).toHaveText('125%');
    const second = await secondContext.newPage(); await setup(second, { terminal: false }); await login(second, app); await openTools(second);
    await expect(second.locator('#width-button')).toHaveAttribute('aria-pressed', 'true');
    second.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/desktop/settings') bodies.push(req.postDataJSON()); });
    await second.locator('#desktop-settings-button').click();
    await expect(second.locator('#desktop-settings-dialog h2')).toHaveText('服务器桌面设置'); await expect(second.locator('#terminal-font-size')).toHaveCount(0);
    await expect(second.locator('#apply-terminal-font')).toHaveCount(0);
    await second.locator('#desktop-width').fill('1920'); await second.locator('#save-desktop-settings').click();
    await expect(second.locator('#settings-pending')).toContainText('1920'); expect(bodies).toHaveLength(1); expect(Object.hasOwn(bodies[0], 'fontSize')).toBe(false);
    expect((await app.controls.get()).saved.fontSize).toBe(24); expect((await stored(page)).zoom).toBe(1.25); expect(app.managementStats.fontChanges).toBe(0);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await secondContext.close(); await app.close(); }
});
