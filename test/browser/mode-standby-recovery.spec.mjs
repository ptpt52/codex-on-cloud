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
      constructor(...args) { super(...args); if (new URL(this.url).pathname === '/session/connect') { this.createdHidden = document.hidden; window.modeSockets.push(this); } }
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

test('a fresh terminal page loads the standby desktop while its catalog is pending, then starts its connection after the terminal', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  let release, entered; const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
  const desktops = [];
  page.on('websocket', socket => { const url = new URL(socket.url()); if (url.pathname === '/session/connect' && url.searchParams.get('mode') === 'desktop') desktops.push(socket); });
  await page.addInitScript(() => {
    if (window !== parent) return;
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, modeStandby: true, mode: 'terminal' }));
    window.addEventListener('message', event => { if (event.origin === location.origin && event.source === document.querySelector('#standby-frame')?.contentWindow && event.data?.type === 'codex-desktop' && event.data.state === 'ready') window.standbyLoaded = true; });
  });
  await page.route('**/api/terminals', async route => { if (route.request().method() === 'GET') { entered(); await held; } await route.continue(); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await requested;
    await expect.poll(() => page.evaluate(() => window.standbyLoaded)).toBe(true);
    const source = await page.locator('#standby-frame').getAttribute('src');
    expect(source).toContain('/desktop/index.html'); expect(desktops).toHaveLength(0);
    release(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect.poll(() => desktops.length).toBe(1);
    const frame = page.frames().find(child => child.url().endsWith(source));
    await expect(frame.locator('#status')).toBeHidden();
    await activate(page, 'desktop');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});

test('a fully warmed relay desktop can resume its fresh frame through its healthy direct candidate', async ({ page }) => {
  test.setTimeout(60000);
  let release; const pending = new Set();
  let allowOffer; const offerGate = new Promise(resolve => { allowOffer = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 160, height: 100 }, seamless: true, webrtc: true, fastConnect: true,
    rfbResumeHook: () => new Promise(resolve => { release = resolve; pending.add(resolve); }) });
  await page.addInitScript(() => {
    if (window === parent) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, modeStandby: true, mode: 'terminal', networkDebug: true }));
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.source !== document.querySelector('#standby-frame')?.contentWindow || event.data?.type !== 'codex-network-event') return;
        const value = event.data.event;
        if (value?.type === 'first-frame') window.parkedPixels = true;
        if (value?.path === 'direct' && value?.type === 'probe-waiting') window.parkedDirectWait = value.reason;
        if (value?.path === 'direct' && value?.type === 'path-lost') window.parkedDirectWait = '';
        if (value?.type === 'path-active') window.parkedPath = value.path;
      });
      return;
    }
    if (!['/desktop/index.html', '/terminal/index.html'].includes(location.pathname)) return;
    // An unthrottled localhost relay can win the latency comparison on CI.
    // Delay only its health replies to make the direct candidate preferable
    // without delaying framebuffer data or changing the handoff protocol.
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname !== '/session/connect') return;
        this.addEventListener('message', event => {
          if (!event.isTrusted || typeof event.data !== 'string' || JSON.parse(event.data).type !== 'pong') return;
          event.stopImmediatePropagation();
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })), 350);
        });
      }
    };
  });
  // Establish the slow parked writer and finish the active offer first. This
  // case checks frame admission, independently of the server's offer quota.
  await page.route('**/api/desktop/rtc', async route => { await offerGate; await route.continue(); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect.poll(() => page.evaluate(() => window.parkedPixels)).toBe(true);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 }); allowOffer();
    await expect.poll(() => page.evaluate(() => ({ waiting: window.parkedDirectWait, path: window.parkedPath })), { timeout: 10000 }).toEqual({ waiting: 'standby', path: 'relay' });
    const source = await page.locator('#standby-frame').getAttribute('src'), frame = page.frames().find(child => child.url().endsWith(source));
    await activate(page, 'desktop'); await expect.poll(() => typeof release).toBe('function');
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 4500 });
    await openInput(page); await expect(page.locator('#paste-button')).toBeDisabled(); await expect(frame.locator('#status')).toBeVisible();
    release(); await expect(frame.locator('#status')).toBeHidden(); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { allowOffer(); for (const resolve of pending) resolve(); await app.close(); }
});

for (const initialMode of ['desktop', 'terminal']) test(`a fresh ${initialMode} page can select a healthy desktop direct path before the first frame without enabling input`, async ({ page }) => {
  let release, entered; const held = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 160, height: 100 }, seamless: true, webrtc: true, fastConnect: true,
    rfbFrameHook: () => { entered(); return held; } });
  await page.addInitScript(mode => { if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, modeStandby: true, mode })); }, initialMode);
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('在线');
    await requested;
    if (initialMode === 'terminal') await activate(page, 'desktop');
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    const source = await page.locator('#desktop-frame').getAttribute('src'), frame = page.frames().find(child => child.url().endsWith(source));
    const renderer = frame.locator('#screen canvas'); await renderer.evaluate(element => { window.coldRenderer = element; });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 10000 });
    await expect(frame.locator('#status')).toBeVisible();
    await openInput(page); await expect(page.locator('#paste-button')).toBeDisabled(); await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    expect(app.vncConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    release(); await expect(frame.locator('#status')).toBeHidden(); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(await renderer.evaluate(element => window.coldRenderer === element)).toBe(true);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(1); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});
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
    await expect(page.locator('#terminal-tabs [data-terminal-choice=main]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#draft-status')).toContainText('桌面窗口尚未确认切换');
    await expect(page.locator('#paste-button')).toBeDisabled(); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await page.locator('#terminal-tabs [data-terminal-choice=main]').click(); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(attempts).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

for (const direct of [false, true]) test(`screen-off recovery warms the retained desktop before switching (${direct ? 'WebRTC' : 'relay'})`, async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, seamless: true, webrtc: direct, fastConnect: direct });
  try {
    // New children inherit the parent visibility, as they do on a real phone.
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.parent.screenOff === true });
      const Native = RTCPeerConnection; window.screenPeers = [];
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.screenPeers.push(this); } };
    });
    const { frame, source } = await setup(page, app, 'desktop');
    const terminal = page.frames().find(item => item.url().includes('/terminal/index.html'));
    const terminalSource = terminal.url();
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.evaluate(() => { window.screenOff = true; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#standby-frame')).toHaveAttribute('src', source);
    for (const child of [terminal, frame]) await child.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.parent.screenOff === true });
      document.dispatchEvent(new Event('visibilitychange'));
      for (const socket of window.modeSockets) socket.close();
      for (const peer of window.screenPeers) peer.close();
    });
    expect(await Promise.all([terminal, frame].map(child => child.evaluate(() => document.hidden)))).toEqual([true, true]);
    await expect(page.locator('#connection-status')).not.toContainText('在线');
    // Cover the old stream's resume timeout, not just a brief tab switch.
    if (direct) {
      await page.waitForTimeout(14000);
      expect((await Promise.all([terminal, frame].map(child => child.evaluate(() => window.modeSockets.map(socket => socket.createdHidden))))).flat().some(Boolean)).toBe(false);
    }
    await page.evaluate(() => { window.screenOff = false; document.dispatchEvent(new Event('visibilitychange')); });
    for (const child of [terminal, frame]) await child.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect.poll(() => frame.evaluate(() => window.modeSockets.some(socket => socket.readyState === WebSocket.OPEN))).toBe(true);
    await expect(frame.locator('#status')).toBeHidden();
    await activate(page, 'desktop');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#terminal-tabs [data-terminal-choice=main]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#draft-status')).not.toContainText('尚未确认切换');
    expect(terminal.url()).toBe(terminalSource);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
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
