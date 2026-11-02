import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
const storedMode = page => page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1') || '{}').mode || 'desktop');
function writes(page) {
  const result = { login: 0, claim: 0, input: 0 };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) result.login++;
    if (request.url().endsWith('/api/desktop/claim')) result.claim++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) result.input++;
  }); return result;
}
async function staleAccept(page) { await page.locator('#accept-confirmation').evaluate(button => { button.click(); button.click(); }); }

test('mode changes in both directions require explicit confirmation, preserve the stream on cancel and switch only once', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }), counts = writes(page);
  try {
    await login(page, app); await page.locator('#mobile-input').fill('确认切换后仍保留草稿');
    const originalFrame = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#desktop-mode').click(); await expect(page.locator('#action-confirmation')).toBeHidden();
    await page.locator('#terminal-mode').dblclick(); await expect(page.locator('#confirmation-title')).toHaveText('切换到网页终端？');
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await expect(page.locator('#confirmation-description')).toContainText('当前任务继续运行');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(originalFrame); expect(await storedMode(page)).toBe('desktop');
    expect(app.vncConnections).toBe(1); expect(app.terminalConnections).toBe(0);
    await page.keyboard.press('Enter'); await expect(page.locator('#action-confirmation')).toBeHidden();
    await page.locator('#terminal-mode').click(); await page.keyboard.press('Escape');
    await page.locator('#terminal-mode').click(); await page.locator('#cancel-confirmation').click(); await staleAccept(page);
    expect(app.terminalConnections).toBe(0); expect(app.vncConnections).toBe(1); expect(await storedMode(page)).toBe('desktop');
    await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click(); await staleAccept(page);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(1); expect(await storedMode(page)).toBe('terminal');
    await page.locator('#terminal-mode').click(); await expect(page.locator('#action-confirmation')).toBeHidden(); expect(app.terminalConnections).toBe(1);
    const terminalFrame = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#desktop-mode').dblclick(); await expect(page.locator('#confirmation-title')).toHaveText('切换到桌面？');
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.keyboard.press('Enter');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(terminalFrame); expect(app.vncConnections).toBe(1); expect(await storedMode(page)).toBe('terminal');
    await page.locator('#desktop-mode').click(); await page.locator('#accept-confirmation').click(); await staleAccept(page);
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); expect(app.vncConnections).toBe(2); expect(app.terminalConnections).toBe(1);
    await expect(page.locator('#mobile-input')).toHaveValue('确认切换后仍保留草稿'); expect(await storedMode(page)).toBe('desktop');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0 }); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('disconnect and page hiding discard pending mode changes, and late confirmation cannot change the recovered terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#desktop-mode').click();
    app.disconnectTerminals(); await expect(page.locator('#action-confirmation')).toBeHidden(); await staleAccept(page);
    await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 15000 }); expect(app.vncConnections).toBe(1); expect(app.terminalConnections).toBe(2);
    await page.locator('#desktop-mode').click(); await expect(page.locator('#action-confirmation')).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#action-confirmation')).toBeHidden(); await staleAccept(page);
    expect(await storedMode(page)).toBe('terminal'); expect(app.vncConnections).toBe(1); expect(app.terminalConnections).toBe(2); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('takeover clears a pending mode change and does not carry its target into the new viewer', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await page.locator('#terminal-mode').click(); await expect(page.locator('#action-confirmation')).toBeVisible();
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('桌面在线');
      await expect(page.locator('#action-confirmation')).toBeHidden({ timeout: 10000 }); await staleAccept(page);
      expect(await storedMode(page)).toBe('desktop'); expect(app.vncConnections).toBe(2); expect(app.terminalConnections).toBe(0); expect(app.inputCalls).toEqual([]);
    } finally { await second.close(); }
  } finally { await app.close(); }
});

test('an accepted pending input disables mode changes and cannot queue a later switch', async ({ page }) => {
  const entered = gate(), hold = gate(), app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, inputHook: async () => { entered.release(); await hold.promise; } });
  try {
    await login(page, app); await page.locator('[data-key="Enter"]').click(); await entered.promise;
    await expect(page.locator('#desktop-mode')).toBeDisabled(); await expect(page.locator('#terminal-mode')).toBeDisabled();
    await page.locator('#terminal-mode').dispatchEvent('click'); await expect(page.locator('#action-confirmation')).toBeHidden();
    hold.release(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success'); await expect(page.locator('#terminal-mode')).toBeEnabled();
    await staleAccept(page); expect(await storedMode(page)).toBe('desktop'); expect(app.terminalConnections).toBe(0); expect(app.vncConnections).toBe(1);
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]); expect(app.managementStats.restarts).toBe(0);
  } finally { hold.release(); await app.close(); }
});

test('mode confirmation postpones automatic direct promotion without opening a text terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true }); let offers = 0;
  try {
    await page.clock.install(); await page.route('**/api/desktop/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
    await login(page, app); await page.locator('#terminal-mode').click(); await page.clock.fastForward(16000); await page.waitForTimeout(100);
    await expect(page.locator('#action-confirmation')).toBeVisible(); expect(offers).toBe(1); expect(app.vncConnections).toBe(1); expect(app.terminalConnections).toBe(0);
    await page.locator('#cancel-confirmation').click();
    await page.frames().find(frame => frame.url().includes('/desktop/index.html')).evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => app.vncConnections, { timeout: 15000 }).toBe(2); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(await storedMode(page)).toBe('desktop'); expect(app.terminalConnections).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
