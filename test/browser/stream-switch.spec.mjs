import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';
async function login(page, app, mode) {
  await page.addInitScript(mode => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
    window.streamPeers = []; const Native = RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.streamPeers.push(this); } };
    if (location.pathname === '/terminal/index.html') {
      let wrapped;
      Object.defineProperty(window, 'Terminal', { configurable: true, get: () => wrapped, set: Native => { wrapped = class extends Native { constructor(...args) { super(...args); window.streamTerminal = this; } }; } });
    }
  }, mode);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText(mode === 'desktop' ? '桌面在线' : '终端在线');
  expect(await page.locator('#desktop-frame').getAttribute('src')).toContain('stream=1');
}
async function route(page, expected) {
  await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText(expected, { timeout: 12000 }); await page.locator('#close-connection').click();
}
for (const mode of ['desktop', 'terminal']) test(`${mode}: warm relay and direct share one upstream and keep the original renderer through fallback`, async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, fastConnect: true, seamless: true });
  try {
    await login(page, app, mode); const frameUrl = await page.locator('#desktop-frame').getAttribute('src');
    const renderer = page.frameLocator('#desktop-frame').locator(mode === 'desktop' ? '#screen canvas' : '.xterm-screen');
    await renderer.evaluate(el => { window.originalRenderer = el; });
    if (mode === 'desktop') await expect.poll(() => renderer.evaluate(el => el.getContext('2d').getImageData(320, 240, 1, 1).data[3])).toBe(255);
    await openInput(page); await page.locator('#mobile-input').fill('切换通道仍保留的草稿'); await closePanels(page);
    await route(page, 'WebRTC');
    expect(mode === 'desktop' ? app.vncConnections : app.terminalConnections).toBe(1);
    const child = mode === 'terminal' ? [...app.terminalChildren][0] : null;
    await page.frameLocator('#desktop-frame').locator('body').evaluate(() => window.streamPeers.at(-1).close());
    await route(page, mode === 'desktop' ? '中转' : 'WebSocket');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(frameUrl);
    expect(await renderer.evaluate(el => window.originalRenderer === el)).toBe(true);
    expect(mode === 'desktop' ? app.vncConnections : app.terminalConnections).toBe(1);
    if (child) expect([...app.terminalChildren][0]).toBe(child);
    await expect(page.locator('#desktop-overlay')).toBeHidden(); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('切换通道仍保留的草稿');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('an accepted pending paste completes across fallback once, and Enter remains a separate action', async ({ page }) => {
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true, terminalHook: async () => { entered(); await hold; } });
  try {
    await login(page, app, 'terminal'); await route(page, 'WebRTC');
    const child = [...app.terminalChildren][0];
    await openInput(page); await page.locator('#mobile-input').fill('粘贴一次'); await page.locator('#paste-button').click(); await began;
    await page.frameLocator('#desktop-frame').locator('body').evaluate(() => window.streamPeers.at(-1).close());
    await route(page, 'WebSocket'); release(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~粘贴一次\x1b[201~' }]);
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.terminalInputs.length).toBe(2);
    expect(app.terminalInputs[1].text).toBe('\r'); expect(app.terminalConnections).toBe(1); expect([...app.terminalChildren][0]).toBe(child);
  } finally { release(); await app.close(); }
});

test('UTF-8 output and terminal colour state continue across a failed direct path without duplicated rows', async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true });
  try {
    await login(page, app, 'terminal'); await route(page, 'WebRTC'); const child = [...app.terminalChildren][0];
    const emit = text => child.stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
    const text = () => page.frameLocator('#desktop-frame').locator('body').evaluate(() => {
      const b = window.streamTerminal.buffer.active; return Array.from({ length: b.length }, (_, n) => b.getLine(n)?.translateToString(true) || '').join('\n');
    });
    emit('\r\n\x1b[32mSTREAM-BEGIN 中文'); await expect.poll(text).toContain('STREAM-BEGIN 中文');
    await page.frameLocator('#desktop-frame').locator('body').evaluate(() => window.streamPeers.at(-1).close()); emit('😀\x1b[0m STREAM-END\r\n');
    await route(page, 'WebSocket'); await expect.poll(text).toContain('STREAM-BEGIN 中文😀 STREAM-END');
    expect((await text()).match(/STREAM-BEGIN/g)).toHaveLength(1);
    const fg = await page.frameLocator('#desktop-frame').locator('body').evaluate(() => {
      const b = window.streamTerminal.buffer.active;
      for (let n = 0; n < b.length; n++) { const line = b.getLine(n); if (line.translateToString(true).startsWith('STREAM-BEGIN')) return line.getCell(0).getFgColor(); }
    });
    expect(fg).toBe(2); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
    for (let i = 0; i < 5; i++) await page.frameLocator('#desktop-frame').locator('body').evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1250); await route(page, 'WebSocket'); expect(app.terminalConnections).toBe(1);
  } finally { await app.close(); }
});
