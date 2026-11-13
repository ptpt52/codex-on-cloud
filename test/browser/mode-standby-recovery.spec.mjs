import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';

async function setup(page, app, cachedMode) {
  await page.addInitScript(mode => {
    if (window === parent) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, modeStandby: true, mode: mode === 'terminal' ? 'desktop' : 'terminal' }));
      window.addEventListener('message', event => {
        if (event.origin === location.origin && event.source === document.querySelector('#standby-frame')?.contentWindow && event.data?.type === 'codex-stream-state') window.cachedPaused = event.data.paused;
      });
    }
    window.modeSockets = []; const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); if (new URL(this.url).pathname === '/session/connect') window.modeSockets.push(this); }
      send(data) {
        if (typeof data === 'string' && window.holdModeAuth && JSON.parse(data).type === 'auth') { this.heldAuth = data; return; }
        super.send(data);
      }
    };
  }, cachedMode);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('在线');
  await expect(page.locator('#standby-frame')).toHaveAttribute('src', new RegExp(`/${cachedMode}/index.html`));
  const source = await page.locator('#standby-frame').getAttribute('src');
  await expect.poll(() => page.frames().some(frame => frame.url().endsWith(source))).toBe(true);
  const frame = page.frames().find(frame => frame.url().endsWith(source));
  await expect(frame.locator(cachedMode === 'terminal' ? '#terminal .xterm' : '#screen canvas')).toHaveCount(1);
  await expect(frame.locator(cachedMode === 'terminal' ? '#terminal-status' : '#status')).toBeHidden();
  return { frame, source };
}
async function activate(page, mode) {
  await closePanels(page); await page.locator(`#${mode}-mode`).click(); await page.locator('#accept-confirmation').click();
}
for (const mode of ['terminal', 'desktop']) test(`a recovering cached ${mode} keeps input paused until its real relay resumes`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  const writes = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') writes.push(request.postDataJSON()); });
  try {
    const { frame, source } = await setup(page, app, mode);
    await frame.evaluate(() => { window.holdModeAuth = true; window.modeSockets.find(socket => socket.readyState === WebSocket.OPEN).close(); });
    await expect.poll(() => page.evaluate(() => window.cachedPaused)).toBe(true);
    await activate(page, mode); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await expect(page.locator('#connection-status')).toContainText('正在优化连接');
    await openInput(page); await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await page.locator('[data-key="Enter"]').dispatchEvent('click');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    await frame.evaluate(() => {
      window.holdModeAuth = false;
      for (const socket of window.modeSockets) if (socket.readyState === WebSocket.OPEN && socket.heldAuth) { const value = socket.heldAuth; socket.heldAuth = ''; socket.send(value); }
    });
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    await expect(page.locator('[data-key="Enter"]')).toBeEnabled();
    expect(writes).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a parked desktop recovery that exceeds focus admission never sends the old selection after reconnect', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Manual desktop task retry is checked in the wide sidebar');
  let attempts = 0;
  const app = await fixture({ rfb: true, seamless: true, desktopHook: (command, args) => { if (command === 'xdotool' && args[0] === 'windowactivate') attempts++; } });
  try {
    const { frame, source } = await setup(page, app, 'desktop');
    await frame.evaluate(() => { window.holdModeAuth = true; window.modeSockets.find(socket => socket.readyState === WebSocket.OPEN).close(); });
    await expect.poll(() => page.evaluate(() => window.cachedPaused)).toBe(true);
    await activate(page, 'desktop'); await expect(page.locator('#toast')).toContainText('桌面终端窗口未确认切换');
    expect(attempts).toBe(0);
    await frame.evaluate(() => {
      window.holdModeAuth = false;
      for (const socket of window.modeSockets) if (socket.readyState === WebSocket.OPEN && socket.heldAuth) { const value = socket.heldAuth; socket.heldAuth = ''; socket.send(value); }
    });
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#input-terminal')).toBeEnabled(); expect(attempts).toBe(0);
    await expect(page.locator('#paste-button')).toBeDisabled(); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await page.locator('#terminal-tabs [data-terminal-choice=main]').click(); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(attempts).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('an uncertain native input reported while parked stays visible when returning to its terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const { frame, source } = await setup(page, app, 'terminal');
    await frame.evaluate(() => parent.postMessage({ type: 'codex-stream-reset', frame: new URLSearchParams(location.search).get('frame'), reason: 'input-unknown' }, location.origin));
    await expect(page.locator('#toast')).toContainText('结果未知');
    await activate(page, 'terminal'); await openInput(page);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await expect(page.locator('#input-status')).toContainText('不会自动重发');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
