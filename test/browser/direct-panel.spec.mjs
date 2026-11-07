import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

// Intercept the actual network path, including subframes; a service worker can
// otherwise bypass Playwright routing in some engines.
test.use({ serviceWorkers: 'block' });

async function choose(page, id) {
  await closePanels(page);
  if (await page.locator('#terminal-session-button').isVisible()) {
    const button = page.locator('#terminal-session-button');
    if (test.info().project.use.hasTouch) await button.tap(); else await button.click();
    await expect(page.locator('#terminal-switch-dialog')).toBeVisible();
    await page.locator(`#terminal-switch-list [data-terminal-choice="${id}"]`).click();
  } else await page.locator(`#terminal-tabs [data-terminal-choice="${id}"]`).click();
  await expect(page.locator('#input-terminal')).toHaveValue(id); await expect(page.locator('#connection-status')).toContainText('终端在线');
}

test('a direct terminal keeps its controls and switches targets on the same peer and iframe when HTTPS is unavailable', async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true });
  await app.controls.manageTerminals({ action: 'create', name: '第二终端', view: 'terminal' });
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
    window.directPeers = []; const Native = RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.directPeers.push(this); } };
  });
  const unexpected = [];
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#diag-panel')).toContainText('加密直连', { timeout: 12000 });
    const source = await page.locator('#desktop-frame').getAttribute('src'); const frame = page.frames().find(f => f.url().includes('/terminal/index.html'));
    await page.route('**/api/**', route => { if (unexpected.length >= 64) throw Error('test request bound'); unexpected.push(new URL(route.request().url()).pathname); return route.abort(); });
    await page.route('**/terminal/**', route => route.abort()); await page.route('**/desktop/**', route => route.abort());
    await openInput(page); await page.locator('#mobile-input').fill('主终端的草稿');
    // This exceeds the old HTTPS status deadline while real UDP/DTLS remains live.
    await page.waitForTimeout(9000); await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#paste-button')).toBeEnabled();
    await openTools(page); await page.locator('#terminals-button').click(); await expect(page.locator('#terminal-list')).toContainText('第二终端'); await page.locator('#close-terminals').click(); await closePanels(page);
    await frame.locator('#history-tools-toggle').click();
    if (await page.locator('#history-tools-close').isVisible()) await page.locator('#history-tools-close').click();
    else await frame.locator('#history-tools-close').click();
    await choose(page, 'aux1'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('只发送给第二终端'); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\x1b[200~只发送给第二终端\x1b[201~' }]);
    await choose(page, 'main'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端的草稿');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(page.frames().includes(frame)).toBe(true);
    expect(await frame.evaluate(() => window.directPeers.length)).toBe(1); expect(app.terminalConnections).toBe(3); expect(app.terminalChildren).toHaveLength(1);
    expect(unexpected).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    await app.login(); await app.claim('b'.repeat(32)); await expect(page.locator('#paste-button')).toBeDisabled(); expect(app.terminalInputs).toHaveLength(1);
  } finally { await app.close(); }
});

test('a direct desktop keeps read status and separate input control when HTTPS polling is unavailable', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#diag-panel')).toContainText('加密直连', { timeout: 12000 });
    await page.route('**/api/**', route => route.abort());
    await page.waitForTimeout(9000); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await openInput(page); await page.locator('#mobile-input').fill('HTTPS 中断后明确发送一次'); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.inputCalls).toHaveLength(1); expect(app.inputCalls[0].text).toBe('HTTPS 中断后明确发送一次'); expect(app.vncConnections).toBe(1);
  } finally { await app.close(); }
});

test('slow HTTPS signaling has its own budget and reuses the authenticated parent configuration', async ({ page }) => {
  test.setTimeout(35000);
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true }); let frameAuthQueries = 0, delayed = 0;
  try {
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/me' && req.frame().parentFrame()) frameAuthQueries++; });
    await page.context().route('**/api/desktop/rtc', async route => { await new Promise(resolve => setTimeout(resolve, 11000)); const response = await route.fetch(); delayed++; await route.fulfill({ response }); });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 20000 });
    expect(delayed).toBe(1); expect(frameAuthQueries).toBe(0); expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
