import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { closePanels, openTools, waitForTerminalLayout } from './ui.mjs';
test.use({ serviceWorkers: 'block' });
async function setup(page, { direct = false, count = 1 } = {}) {
  await page.addInitScript(() => {
    if (window === parent) { localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode: 'terminal' })); window.attachmentPaths = { peers: 0, sockets: 0 }; return; }
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    const P = RTCPeerConnection; window.RTCPeerConnection = class extends P { constructor(...args) { super(...args); parent.attachmentPaths.peers++; } };
    const S = WebSocket; window.WebSocket = class extends S { constructor(...args) { super(...args); if (new URL(this.url).pathname === '/session/connect') parent.attachmentPaths.sockets++; } };
  });
  const app = await fixture({ mode: 'terminal', seamless: true, fastConnect: true, webrtc: direct });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: 'Attachment ' + n, view: 'terminal' });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  await expect.poll(() => page.frameLocator('#desktop-frame').locator('html').evaluate(() => document.querySelector('.xterm-helper-textarea')?.disabled !== true)).toBe(true);
  if (direct) { await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 }); await page.locator('#close-connection').click(); }
  return app;
}
async function choose(page, id) {
  await closePanels(page); await waitForTerminalLayout(page);
  const tab = page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
  if (await tab.isVisible()) await tab.click(); else { await page.locator('#terminal-session-button').click(); await page.locator(`#terminal-switch-list [data-terminal-choice=${id}]`).click(); }
}
async function closeCurrent(page) {
  await closePanels(page); await waitForTerminalLayout(page);
  const action = page.locator('#terminal-tabs [data-terminal-actions=main]');
  if (await action.isVisible()) await action.click(); else await page.locator('#terminal-session-actions').click();
  await page.locator('#terminal-action-end').click(); await page.locator('#accept-confirmation').click();
}
const paths = page => page.evaluate(() => ({ ...window.attachmentPaths }));
const output = (app, text) => app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
for (const direct of [false, true]) {
  test(`${direct ? 'direct' : 'relay'}: closing the active terminal selects its neighbor on the retained connection`, async ({ page }) => {
    const app = await setup(page, { direct, count: 3 });
    try {
      const before = await paths(page), src = await page.locator('#desktop-frame').getAttribute('src');
      await closeCurrent(page); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
      await choose(page, 'aux2'); await expect(page.locator('#input-terminal')).toHaveValue('aux2'); await expect(page.locator('#paste-button')).toBeEnabled();
      expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src); const after = await paths(page);
      expect(direct ? after.peers : after.sockets).toBe(direct ? before.peers : before.sockets); expect(app.terminalInputs).toEqual([]);
    } finally { await app.close(); }
  });
  test(`${direct ? 'direct' : 'relay'}: closing the last terminal preserves readonly output and creates a fresh identity on the same connection`, async ({ page }) => {
    const app = await setup(page, { direct });
    try {
      output(app, 'FINAL-ATTACHMENT-SCREEN\r\n'); const frame = page.frameLocator('#desktop-frame');
      await expect(frame.locator('.xterm-rows')).toContainText('FINAL-ATTACHMENT-SCREEN');
      const before = await paths(page), src = await page.locator('#desktop-frame').getAttribute('src'), old = (await app.controls.listTerminals()).terminals[0];
      await closeCurrent(page); await expect(page.locator('#connection-status')).toContainText('终端已关闭'); await expect(frame.locator('#terminal-status')).toContainText('终端已结束');
      await expect(page.locator('#desktop-overlay')).toBeHidden(); await expect(frame.locator('.xterm-rows')).toContainText('FINAL-ATTACHMENT-SCREEN');
      await frame.locator('.xterm-helper-textarea').dispatchEvent('input', { data: 'must not send' }); expect(app.terminalInputs).toEqual([]);
      await choose(page, 'new'); await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#input-terminal')).toHaveValue('main');
      expect((await app.controls.listTerminals()).terminals[0].token).not.toBe(old.token); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src);
      await expect(frame.locator('.xterm-rows')).not.toContainText('FINAL-ATTACHMENT-SCREEN');
      const after = await paths(page); expect(direct ? after.peers : after.sockets).toBe(direct ? before.peers : before.sockets); expect(app.terminalInputs).toEqual([]);
    } finally { await app.close(); }
  });
}
test('natural exit and helper failure retain the viewer, and only an explicit selection attaches again', async ({ page }) => {
  const app = await setup(page, { count: 2 });
  try {
    const src = await page.locator('#desktop-frame').getAttribute('src'), main = (await app.controls.listTerminals()).terminals[0];
    app.terminalChildren.at(-1).kill(); await expect(page.locator('#connection-status')).toContainText('终端附加失败');
    const attachments = app.terminalConnections; await page.waitForTimeout(1200); expect(app.terminalConnections).toBe(attachments);
    await choose(page, 'main'); await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(attachments + 1);
    await app.controls.manageTerminals({ action: 'close', terminalId: main.id, terminalToken: main.token, confirm: true, view: 'terminal' });
    await expect(page.frameLocator('#desktop-frame').locator('#terminal-status')).toContainText('终端已结束', { timeout: 7000 });
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src);
    await choose(page, 'aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect((await paths(page)).sockets).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('an unknown close result retains output without selecting or retrying until the list is verified', async ({ page }) => {
  const app = await setup(page, { count: 2 }); let closes = 0;
  try {
    output(app, 'CLOSE-UNKNOWN-SCREEN');
    const src = await page.locator('#desktop-frame').getAttribute('src');
    await page.route('**/api/terminals', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'close') return route.continue();
      closes++; await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await closeCurrent(page); await expect(page.locator('#terminals-status')).toContainText('结果未知');
    await expect(page.frameLocator('#desktop-frame').locator('.xterm-rows')).toContainText('CLOSE-UNKNOWN-SCREEN');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src); expect(app.terminalConnections).toBe(1);
    await openTools(page); await page.locator('#terminal-view-manage').click(); await page.locator('#refresh-terminals').click(); await page.locator('#close-terminals').click();
    await choose(page, 'aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(closes).toBe(1); expect((await paths(page)).sockets).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('logout revokes a detached connection without reopening the ended task', async ({ page }) => {
  const app = await setup(page);
  try {
    await closeCurrent(page); await expect(page.frameLocator('#desktop-frame').locator('#terminal-status')).toContainText('终端已结束');
    await page.locator('#logout-button').click(); await page.locator('#accept-confirmation').click(); await expect(page.locator('#login-view')).toBeVisible();
    await page.waitForTimeout(1100); expect(app.terminalConnections).toBe(1); expect((await app.controls.listTerminals()).terminals).toEqual([]);
    expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
