import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

const pin = 'test-only-screen-password', guestPassword = 'test-only-visitor-password';
async function login(page, app, username = 'admin', password = app.config.password) {
  await page.goto(app.config.origin); await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.locator('#login-button').click();
  await expect(page.locator('#workspace-view')).toBeVisible();
}
async function unlock(page, password = pin) {
  await expect(page.locator('#unlock-dialog')).toBeVisible(); await page.locator('#unlock-password').fill(password); await page.locator('#unlock-submit').click();
  await expect(page.locator('#unlock-dialog')).toBeHidden(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
async function security(page) { await page.locator('#toggle-controls-button').click(); await page.locator('#access-settings-button').click(); await expect(page.locator('#access-status')).toHaveText(''); await expect(page.locator('#screen-lock-save')).toBeEnabled(); }
async function configure(app) {
  await app.login(); await app.claim();
  expect((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: guestPassword, durationMs: 3600000 } })).status).toBe(200);
  expect((await app.request('/api/security/screen-lock', { method: 'POST', body: { enabled: true, password: pin } })).status).toBe(200);
}

test('screen settings, first-entry unlock and each takeover require a fresh password without sending it to the desktop', async ({ page, browser }, info) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }); let other;
  try {
    await login(page, app); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await security(page);
    await page.locator('#screen-lock-enabled').check(); await page.locator('#screen-lock-password').fill(pin); await page.locator('#screen-lock-save').click();
    await expect(page.locator('#access-dialog')).toBeHidden(); await expect(page.locator('#unlock-dialog')).toBeVisible();
    await page.locator('#unlock-password').fill('wrong'); await page.locator('#unlock-submit').click(); await expect(page.locator('#unlock-error')).toContainText('密码不正确'); await expect(page.locator('#unlock-password')).toHaveValue('');
    await unlock(page);
    other = await browser.newContext({ viewport: page.viewportSize(), isMobile: info.project.name === 'mobile', hasTouch: info.project.name === 'mobile' });
    const second = await other.newPage(); await login(second, app); await expect(second.locator('#unlock-dialog')).toBeVisible();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await unlock(second); await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });
    await page.locator('#takeover-button').click(); await expect(page.locator('#unlock-dialog')).toBeVisible(); await expect(page.locator('#unlock-password')).toHaveValue('');
    await page.locator('#unlock-cancel').click(); await expect(page.locator('#desktop-frame')).toBeHidden(); await page.locator('#forward-button').click();
    await expect(page.locator('#forward-direction')).toHaveValue('reverse'); await expect(page.locator('#forward-direction option[value="forward"]')).toHaveAttribute('disabled', ''); await expect(page.locator('#forward-devices')).toBeHidden();
    await page.locator('#forward-close').click(); await page.locator('#takeover-button').click(); await unlock(page);
    await page.reload(); await expect(page.locator('#unlock-dialog')).toBeVisible(); await expect(page.locator('#desktop-frame')).toBeHidden(); await unlock(page);
    await security(page); await page.screenshot({ path: `test-results/${info.project.name}-access-settings.png` });
    expect(await page.locator('#access-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await other?.close(); await app.close(); }
});

test('temporary browser login exposes only status, reverse device mapping and file transfer and is revoked immediately', async ({ page }, info) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, forwardPorts: '*' });
  try {
    await configure(app); await login(page, app, 'visitor', guestPassword);
    await expect(page.locator('#connection-status')).toContainText('临时访问'); await expect(page.locator('#unlock-dialog')).toBeHidden(); await expect(page.locator('#takeover-button')).toBeHidden(); await expect(page.locator('#toggle-controls-button')).toBeHidden(); await expect(page.locator('#terminal-mode')).toBeHidden();
    await page.locator('#connection-button').click(); await expect(page.locator('#connection-dialog')).toBeVisible(); await page.locator('#close-connection').click();
    await page.locator('#forward-button').click(); await expect(page.locator('#forward-direction')).toHaveValue('reverse'); await expect(page.locator('#forward-devices')).toBeHidden();
    await page.locator('#forward-device-name').fill('visitor router'); await page.locator('#forward-host').fill('192.168.16.1'); await page.locator('#forward-create').click(); await expect(page.locator('#forward-code')).not.toHaveValue('');
    await page.screenshot({ path: `test-results/${info.project.name}-temporary-device-access.png` });
    await page.locator('#forward-close').click(); await page.locator('#files-button').click(); await expect(page.locator('#files-dialog')).toBeVisible();
    await page.locator('#upload-input').setInputFiles({ name: 'visitor.txt', mimeType: 'text/plain', buffer: Buffer.from('visitor upload') });
    await expect.poll(() => app.files.get('visitor.txt')?.toString()).toBe('visitor upload');
    expect(app.vncConnections).toBe(0); expect(app.terminalConnections).toBe(0);
    const denied = await page.evaluate(async () => (await fetch('/api/terminals')).status); expect(denied).toBe(403);
    expect((await app.request('/api/desktop/claim', { method: 'POST', body: { viewer: app.viewer, lockPassword: pin } })).status).toBe(200);
    expect((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: false } })).status).toBe(200);
    await page.reload(); await expect(page.locator('#login-view')).toBeVisible(); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('temporary account setup copies credentials only after save and clears secrets when closed', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await security(page);
    let release; const responseGate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/security/temporary-account', async route => { await responseGate; await route.continue(); });
    await page.locator('#temporary-enabled').check(); await page.locator('#temporary-username').fill('visitor'); await page.locator('#temporary-password').fill(guestPassword); await page.locator('#temporary-save').click();
    await expect(page.locator('#temporary-password')).toBeDisabled(); await expect(page.locator('#temporary-copy')).toBeDisabled(); release();
    await expect(page.locator('#temporary-current')).toContainText('当前有效'); await expect(page.locator('#temporary-copy')).toBeEnabled();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.sharedCredentials = text; } } }));
    await page.locator('#temporary-copy').click(); expect(await page.evaluate(() => window.sharedCredentials)).toContain(guestPassword);
    await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { window.rejectCredentialCopy = reject; }); });
    await page.locator('#temporary-copy').click(); await page.locator('#access-close').click(); await page.evaluate(() => window.rejectCredentialCopy(Error('late clipboard denial')));
    await expect(page.locator('#temporary-password')).toHaveValue(''); await expect(page.locator('#temporary-share')).toHaveValue(''); await expect(page.locator('#temporary-share')).toBeHidden(); await page.locator('#access-settings-button').click();
    await expect(page.locator('#temporary-password')).toHaveValue(''); await expect(page.locator('#temporary-copy')).toBeDisabled();
    await page.locator('#temporary-enabled').uncheck(); await page.locator('#temporary-save').click(); await expect(page.locator('#access-confirm-cancel')).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.locator('#access-confirm')).toBeHidden(); await expect(page.locator('#temporary-current')).toContainText('当前有效');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('terminal-only deployment unlocks explicitly and locks again without sending the password or restarting terminals', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  try {
    await configure(app); await login(page, app); await expect(page.locator('#unlock-dialog')).toBeVisible(); expect(app.terminalConnections).toBe(0);
    await page.locator('#unlock-password').fill(pin); await page.locator('#unlock-submit').click(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await security(page); await expect(page.locator('#screen-lock-enabled')).toBeChecked(); await page.locator('#access-close').click(); await page.locator('#screen-lock-button').click();
    await expect(page.locator('#takeover-button')).toBeVisible(); await expect(page.locator('#desktop-frame')).toBeHidden();
    await page.locator('#takeover-button').click(); await expect(page.locator('#unlock-password')).toHaveValue('');
    expect(app.vncConnections).toBe(0); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
