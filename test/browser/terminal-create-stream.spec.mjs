import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { closePanels, openInput, openTools, waitForTerminalLayout } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

async function setup(page, { direct = false, legacy = false, terminalHook, desktopHook } = {}) {
  await page.addInitScript(({ legacy }) => {
    if (window === parent) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', collapsed: true, terminalInputCollapsed: true }));
      window.createStats = { peers: 0, sockets: 0, commands: 0, replies: 0, states: 0 };
      window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.data?.type !== 'codex-panel-result' || !event.data.value?.created) return;
        window.createStats.replies++;
        if (window.dropCreateReply) { event.stopImmediatePropagation(); window.dropCreateReply = false; }
      }, true);
      return;
    }
    if (location.pathname !== '/terminal/index.html') return;
    window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.createStream = 'retained'; }, { once: true });
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); parent.createStats.peers++; }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args), send = channel.send.bind(channel);
        channel.send = bytes => {
          if (args[0] === 'codex-stream' && bytes.byteLength > 4) {
            try {
              const action = JSON.parse(new TextDecoder().decode(bytes.subarray(4))).action;
              if (action === 'create-terminal') parent.createStats.commands++;
              if (action === 'state') parent.createStats.states++;
            } catch {}
          }
          send(bytes);
        };
        return channel;
      }
    };
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args); if (new URL(this.url).pathname !== '/session/connect') return;
        parent.createStats.sockets++;
        this.addEventListener('message', event => {
          if (!legacy || !event.isTrusted || typeof event.data !== 'string') return;
          const value = JSON.parse(event.data); if (value.type !== 'welcome') return;
          event.stopImmediatePropagation(); delete value.terminalCreate;
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
        });
        const send = this.send.bind(this);
        this.send = text => { if (JSON.parse(text).action === 'create-terminal') parent.createStats.commands++; send(text); };
      }
    };
  }, { legacy });
  const app = await fixture({ mode: 'terminal', maxTerminals: 8, seamless: true, fastConnect: true, webrtc: direct, terminalHook, desktopHook });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  if (direct) { await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 }); await page.locator('#close-connection').click(); }
  return app;
}
async function choose(page, id) {
  await closePanels(page); await waitForTerminalLayout(page);
  const tab = page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
  if (await tab.isVisible()) await tab.click();
  else { await page.locator('#terminal-session-button').click(); await page.locator(`#terminal-switch-list [data-terminal-choice=${id}]`).click(); }
}
const stats = page => page.evaluate(() => ({ ...window.createStats }));

for (const direct of [true, false]) test(`${direct ? 'direct' : 'relay'} creation keeps its iframe and active connection, selects the new shell and preserves the original draft`, async ({ page }) => {
  const app = await setup(page, { direct }), requests = [];
  try {
    await openInput(page); await page.locator('#mobile-input').fill('主终端草稿'); await closePanels(page);
    const before = await stats(page), connections = app.terminalConnections, source = await page.locator('#desktop-frame').getAttribute('src'), original = (await app.controls.listTerminals()).terminals[0];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(terminals|terminal\/rtc)$/.test(new URL(request.url()).pathname)) requests.push(request.url()); });
    await choose(page, 'new'); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await expect(page.frameLocator('#desktop-frame').locator('html')).toHaveAttribute('data-create-stream', 'retained');
    expect(await stats(page)).toMatchObject({ peers: before.peers, ...(direct ? {} : { sockets: before.sockets }), commands: 1, replies: 1 });
    expect(requests).toEqual([]); expect(app.terminalConnections).toBe(connections + 1);
    if (direct) await expect.poll(async () => (await stats(page)).states).toBeGreaterThan(before.states);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.terminalInputs.length).toBe(1);
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\r' }]);
    await choose(page, 'main'); await expect(page.locator('#input-terminal')).toHaveValue('main'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端草稿');
    expect((await app.controls.listTerminals()).terminals[0]).toEqual(original); expect(requests).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('an accepted native failure remains unknown and is never repeated over HTTPS', async ({ page }) => {
  let calls = 0, posts = 0;
  const app = await setup(page, { direct: true, desktopHook: async (command, args) => {
    if (command === 'tmux' && args.includes('@codex_cloud_name')) { calls++; throw Error('label failed after shell creation'); }
  } });
  try {
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') posts++; });
    await choose(page, 'new'); await expect(page.locator('#toast')).toContainText('结果未知');
    expect((await app.controls.listTerminals()).terminals).toHaveLength(2); await expect(page.locator('#input-terminal')).toHaveValue('main');
    expect(calls).toBe(1); expect(posts).toBe(0); expect((await stats(page)).commands).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('an unacknowledged input can defer attachment after creation without losing the old stream or creating another shell', async ({ page }) => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = await setup(page, { direct: true, terminalHook: async () => gate });
  try {
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await page.frameLocator('#desktop-frame').locator('.xterm-helper-textarea').press('x'); await expect.poll(() => app.terminalInputs.length).toBe(1);
    await choose(page, 'new'); await expect(page.locator('#terminals-status')).toContainText('终端已创建，查看切换未完成');
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect((await app.controls.listTerminals()).terminals).toHaveLength(2); expect((await stats(page)).commands).toBe(1);
    release(); await choose(page, 'aux1'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: 'x' }]); expect((await stats(page)).commands).toBe(1);
  } finally { release(); await app.close(); }
});

test('takeover during an accepted creation discards the late reply and never attaches or recreates it', async ({ page }) => {
  let release, created, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { created = resolve; });
  const app = await setup(page, { direct: true, desktopHook: async (command, args) => {
    if (command === 'tmux' && args.includes('@codex_cloud_name')) { calls++; created(); await gate; }
  } });
  try {
    await choose(page, 'new'); await accepted;
    await app.login(); await app.claim();
    await expect(page.locator('#desktop-overlay')).toBeVisible(); release();
    await expect(page.locator('#desktop-frame')).toBeHidden(); await expect(page.locator('#input-terminal')).toHaveValue('main');
    expect((await app.controls.listTerminals()).terminals).toHaveLength(2); expect(calls).toBe(1); expect((await stats(page)).commands).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});

test('a lost accepted creation reply never falls back to HTTP, repeats the command or changes selection', async ({ page }) => {
  const app = await setup(page, { direct: true }); let posts = 0;
  try {
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') posts++; });
    await page.evaluate(() => { window.dropCreateReply = true; });
    await choose(page, 'new'); await expect(page.locator('#toast')).toContainText('结果未知', { timeout: 10000 });
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect((await app.controls.listTerminals()).terminals).toHaveLength(2);
    expect((await stats(page)).commands).toBe(1); expect(posts).toBe(0);
    await openTools(page); await page.locator('#terminal-view-manage').click();
    await expect(page.locator('.terminal-row')).toHaveCount(2); await page.locator('#close-terminals').click();
    await choose(page, 'aux1'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    expect((await stats(page)).commands).toBe(1); expect(posts).toBe(0); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('an older server without the creation capability uses HTTPS once and still retains its stream when attaching', async ({ page }) => {
  const app = await setup(page, { legacy: true }); let posts = 0;
  try {
    const before = await stats(page), source = await page.locator('#desktop-frame').getAttribute('src');
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') posts++; });
    await choose(page, 'new'); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#input-terminal')).toBeEnabled();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(posts).toBe(1);
    expect(await stats(page)).toMatchObject({ peers: before.peers, sockets: before.sockets, commands: 0 }); expect(app.terminalConnections).toBe(2);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
