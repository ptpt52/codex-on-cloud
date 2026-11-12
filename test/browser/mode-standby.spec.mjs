import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

async function login(page, app, saved) {
  if (saved) await page.addInitScript(saved => { if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', ...saved })); }, saved);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('在线');
}
async function switchMode(page, mode) {
  await closePanels(page); await page.locator(`#${mode}-mode`).click();
  await expect(page.locator('#action-confirmation')).toBeVisible();
  await page.locator('#accept-confirmation').click();
  await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
}
async function prepared(page, mode) {
  await expect(page.locator('#standby-frame')).toHaveAttribute('src', new RegExp(`/${mode}/index.html`));
  const source = await page.locator('#standby-frame').getAttribute('src');
  await expect.poll(() => page.frames().some(frame => frame.url().endsWith(source))).toBe(true);
  const frame = page.frames().find(frame => frame.url().endsWith(source));
  await expect(frame.locator(mode === 'terminal' ? '#terminal .xterm' : '#screen canvas')).toHaveCount(1);
  await expect(frame.locator(mode === 'terminal' ? '#terminal-status' : '#status')).toBeHidden();
  return { frame, source };
}

test('standby defaults off and mode switching keeps the original single-viewer behavior', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await login(page, app); await openTools(page); await expect(page.locator('#mode-standby')).not.toBeChecked();
    await expect(page.locator('#standby-frame')).toHaveCount(0); expect(app.terminalConnections).toBe(0);
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await switchMode(page, 'terminal'); await switchMode(page, 'desktop');
    expect(await page.locator('#desktop-frame').getAttribute('src')).not.toBe(source);
    await expect(page.locator('#standby-frame')).toHaveCount(0);
  } finally { await app.close(); }
});

test('prepared modes reuse their iframe and connections, hidden terminal input and resize stay blocked, disabling releases standby', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  await page.addInitScript(() => {
    let Constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Constructor, set: Native => {
      Constructor = class extends Native { constructor(...args) { super(...args); window.testTerminal = this; } };
    } });
  });
  try {
    await login(page, app); await openTools(page); await page.locator('#mode-standby').check();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    const desktopSource = await page.locator('#desktop-frame').getAttribute('src'), terminal = await prepared(page, 'terminal');
    await expect.poll(() => app.terminalViews.at(-1)?.standby).toBe(true);
    await expect(page.locator('#standby-frame')).toHaveAttribute('inert', '');
    const sizes = app.terminalSizes.length, connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
    await terminal.frame.evaluate(() => {
      parent.postMessage({ type: 'codex-control-request', id: 55, frame: new URLSearchParams(location.search).get('frame'), action: 'key', body: { key: 'Enter' } }, location.origin);
      window.testTerminal.input('SHOULD-NOT-SEND', true);
    });
    await page.evaluate(() => {
      const frame = document.querySelector('#standby-frame');
      frame.contentWindow.postMessage({ type: 'codex-control-request', id: 56, frame: new URL(frame.src).searchParams.get('frame'), action: 'key', body: { key: 'Enter' } }, location.origin);
    });
    await page.setViewportSize({ width: 820, height: 940 });
    await expect.poll(() => terminal.frame.evaluate(() => window.testTerminal.options.disableStdin)).toBe(true);
    expect(app.terminalSizes.length).toBe(sizes); expect(app.terminalInputs).toEqual([]);
    for (let count = 0; count < 2; count++) {
      await switchMode(page, 'terminal'); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(terminal.source);
      await expect.poll(() => app.terminalViews.at(-1)?.standby).toBe(false);
      await expect.poll(() => terminal.frame.evaluate(() => window.testTerminal.options.disableStdin)).toBe(false);
      await openInput(page); await page.locator('#mobile-input').fill('keep this draft'); await closePanels(page);
      await switchMode(page, 'desktop'); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(desktopSource);
      await expect.poll(() => app.terminalViews.at(-1)?.standby).toBe(true);
    }
    expect(app.vncConnections).toBe(connections.vnc); expect(app.terminalConnections).toBe(connections.terminal);
    await switchMode(page, 'terminal'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('keep this draft');
    await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~keep this draft\x1b[201~' }]);
    await closePanels(page); await terminal.frame.locator('#history-tools-toggle').click();
    await expect(page.locator('#desktop-card > #history-tools')).toBeVisible(); await page.locator('#history-tools-close').click();
    await openTools(page); await page.locator('#mode-standby').uncheck(); await expect(page.locator('#standby-frame')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-cloud.display.v1')).modeStandby)).toBe(false);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a changed desktop input target prepares the exact terminal and backgrounding releases only standby', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  await app.controls.manageTerminals({ action: 'create', name: 'standby target', view: 'terminal' });
  try {
    await login(page, app, { modeStandby: true }); const main = await prepared(page, 'terminal');
    const desktopSource = await page.locator('#desktop-frame').getAttribute('src');
    await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    const auxiliary = await prepared(page, 'terminal'); expect(auxiliary.source).not.toBe(main.source);
    expect(new URL(auxiliary.source, app.config.origin).searchParams.get('terminalId')).toBe('aux1');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#standby-frame')).toHaveCount(0); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(desktopSource);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    const refreshed = await prepared(page, 'terminal'); expect(refreshed.source).not.toBe(auxiliary.source);
    await switchMode(page, 'terminal'); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(refreshed.source);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('takeover releases both viewers and terminal-only ignores a saved standby preference', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await login(page, app, { modeStandby: true }); await prepared(page, 'terminal');
    await app.login(); await app.claim('b'.repeat(32));
    await expect(page.locator('#connection-status')).toContainText('等待接管', { timeout: 10000 });
    await expect(page.locator('#standby-frame')).toHaveCount(0); await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
  const terminal = await fixture({ mode: 'terminal', seamless: true });
  try {
    await login(page, terminal, { modeStandby: true }); await openTools(page);
    await expect(page.locator('#mode-standby-option')).toBeHidden(); await expect(page.locator('#standby-frame')).toHaveCount(0);
    expect(terminal.vncConnections).toBe(0);
  } finally { await terminal.close(); }
});

test('both modes keep their direct stream when parked and can switch without another page load', async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await login(page, app, { modeStandby: true, mode: 'terminal' });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const terminalSource = await page.locator('#desktop-frame').getAttribute('src'), desktop = await prepared(page, 'desktop');
    await switchMode(page, 'desktop');
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
    await switchMode(page, 'terminal'); await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(terminalSource);
    await openInput(page); await page.locator('#mobile-input').fill('direct after standby'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await switchMode(page, 'desktop'); await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(desktop.source);
    expect(app.vncConnections).toBe(connections.vnc); expect(app.terminalConnections).toBe(connections.terminal);
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~direct after standby\x1b[201~' }]);
  } finally { await app.close(); }
});
