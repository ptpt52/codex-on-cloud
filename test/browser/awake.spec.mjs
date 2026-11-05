import { openTools } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function setup(page, { unsupported = false, mode = 'grant' } = {}) {
  await page.addInitScript(({ unsupported, mode }) => {
    window.wakeStats = { requests: 0, releases: 0, active: 0, maximum: 0 };
    window.wakeMode = mode; window.fakeVisible = true; window.testLocks = [];
    Object.defineProperty(document, 'hidden', { get: () => !window.fakeVisible, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => window.fakeVisible ? 'visible' : 'hidden', configurable: true });
    class Lock extends EventTarget {
      released = false;
      release() { if (!this.released) { this.released = true; window.wakeStats.releases++; window.wakeStats.active--; this.dispatchEvent(new Event('release')); } return Promise.resolve(); }
    }
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: unsupported ? undefined : {
      async request(type) {
        if (type !== 'screen') throw new Error('unexpected wake type');
        window.wakeStats.requests++;
        if (window.wakeMode === 'deny') throw new DOMException('denied', 'NotAllowedError');
        if (window.wakeMode === 'hold') await new Promise(resolve => { window.resolveWake = resolve; });
        const lock = new Lock(); window.testLocks.push(lock); window.wakeStats.active++;
        window.wakeStats.maximum = Math.max(window.wakeStats.maximum, window.wakeStats.active); return lock;
      },
    } });
  }, { unsupported, mode });
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
const stats = page => page.evaluate(() => window.wakeStats);

test('screen wake lock is opt-in, resumes in foreground and releases on confirmed logout', async ({ page }) => {
  const app = await fixture({ rfb: true }); await setup(page);
  try {
    await login(page, app); expect((await stats(page)).requests).toBe(0);
    await openTools(page); await page.locator('#awake-button').click(); await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    expect((await stats(page)).active).toBe(1);
    expect((await page.evaluate(() => localStorage.getItem('codex-cloud.display.v1'))).length).toBeLessThanOrEqual(512);
    await page.evaluate(() => { window.fakeVisible = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await stats(page)).active).toBe(0);
    await page.evaluate(() => { window.fakeVisible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#awake-button')).toHaveText('亮屏已开启'); expect((await stats(page)).requests).toBe(2);
    await page.locator('#logout-button').click(); await page.locator('#cancel-confirmation').click(); expect((await stats(page)).active).toBe(1);
    await page.locator('#logout-button').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#login-view')).toBeVisible(); await expect.poll(async () => (await stats(page)).active).toBe(0);
    expect((await stats(page)).maximum).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('disabling a pending screen lock releases a late grant without acquiring another lock', async ({ page }) => {
  const app = await fixture({ rfb: true }); await setup(page, { mode: 'hold' });
  try {
    await login(page, app); await openTools(page); await page.locator('#awake-button').click();
    await expect(page.locator('#awake-button')).toHaveText('亮屏申请中');
    await openTools(page); await page.locator('#awake-button').click(); await page.evaluate(() => window.resolveWake());
    await expect.poll(async () => (await stats(page)).releases).toBe(1);
    expect((await stats(page)).active).toBe(0); expect((await stats(page)).requests).toBe(1);
    await expect(page.locator('#awake-button')).toHaveAttribute('aria-pressed', 'false');
  } finally { await app.close(); }
});

test('quick off/on and page hide/show keep at most one native wake lock', async ({ page }) => {
  const app = await fixture({ rfb: true }); await setup(page, { mode: 'hold' });
  try {
    await login(page, app); await openTools(page); await page.locator('#awake-button').click();
    await expect.poll(async () => (await stats(page)).requests).toBe(1);
    await openTools(page); await page.locator('#awake-button').click(); await openTools(page); await page.locator('#awake-button').click();
    await page.evaluate(() => { window.wakeMode = 'grant'; window.resolveWake(); });
    await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    expect((await stats(page)).requests).toBe(2); expect((await stats(page)).releases).toBe(1); expect((await stats(page)).maximum).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(async () => (await stats(page)).active).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    expect((await stats(page)).requests).toBe(3); expect((await stats(page)).maximum).toBe(1);
  } finally { await app.close(); }
});

test('system release or denial is shown as paused without retry loops; explicit toggle retries', async ({ page }) => {
  const app = await fixture({ rfb: true }); await setup(page, { mode: 'deny' });
  try {
    await login(page, app); await openTools(page); await page.locator('#awake-button').click();
    await expect(page.locator('#awake-button')).toHaveText('亮屏已暂停');
    await page.waitForTimeout(4500); expect((await stats(page)).requests).toBe(1);
    await openTools(page); await page.locator('#awake-button').click(); await page.evaluate(() => { window.wakeMode = 'grant'; });
    await openTools(page); await page.locator('#awake-button').click(); await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    await page.evaluate(() => window.testLocks.at(-1).release());
    await expect(page.locator('#awake-button')).toHaveText('亮屏已暂停');
    await page.waitForTimeout(4500); expect((await stats(page)).requests).toBe(2); expect((await stats(page)).maximum).toBe(1);
  } finally { await app.close(); }
});

test('unsupported browser is clear and refreshing restores the enabled preference without desktop actions', async ({ page, context }) => {
  const app = await fixture({ rfb: true }); await setup(page);
  try {
    await login(page, app); await openTools(page); await page.locator('#awake-button').click(); await expect(page.locator('#awake-button')).toHaveText('亮屏已开启');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#awake-button')).toHaveText('亮屏已开启'); expect((await stats(page)).requests).toBe(1);
    const second = await context.newPage(); await setup(second, { unsupported: true }); await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('桌面在线');
    await expect(second.locator('#awake-button')).toBeDisabled(); await expect(second.locator('#awake-button')).toHaveText('不支持亮屏');
    await expect.poll(async () => (await stats(page)).active).toBe(0);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0); await second.close();
  } finally { await app.close(); }
});
