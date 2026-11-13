import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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

for (const direct of [false, true]) for (const [from, to] of [['main', 'aux1'], ['aux1', 'aux2']]) test(`${direct ? 'direct' : 'relay'}: ${from} to ${to} through desktop task tabs shares retained viewers and confirmed targets`, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  test.setTimeout(45000);
  const activated = [], errors = [], offers = [], httpOpens = [];
  const app = await fixture({ rfb: true, seamless: true, webrtc: direct, fastConnect: direct,
    desktopHook: (command, args) => { if (command === 'xdotool' && args[0] === 'windowactivate') activated.push(args.at(-1)); } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'POST') return; const path = new URL(request.url()).pathname; if (path === '/api/rtc') offers.push(request.url()); if (path === '/api/terminals') httpOpens.push(request.postDataJSON()); });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    await app.controls.manageTerminals({ action: 'create', name: '终端3', view: 'terminal' });
    await login(page, app, { modeStandby: true, mode: 'terminal', workspaceLayout: 'sidebar' });
    const terminalSource = await page.locator('#desktop-frame').getAttribute('src'), desktop = await prepared(page, 'desktop');
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const connections = app.vncConnections;
    await page.route('**/api/terminals', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await page.locator(`#terminal-tabs [data-terminal-choice=${from}]`).click();
    await expect(page.locator('#input-terminal')).toHaveValue(from); await expect(page.locator('#input-terminal')).toBeEnabled();
    await switchMode(page, 'desktop'); await expect(page.locator('#input-terminal')).toBeEnabled();
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const negotiated = offers.length;
    expect(activated.at(-1)).toBe(from === 'main' ? '999' : '1001');
    await expect(page.locator(`#terminal-tabs [data-terminal-choice=${from}]`)).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(desktop.source);
    await page.locator(`#terminal-tabs [data-terminal-choice=${to}]`).click();
    await expect(page.locator('#input-terminal')).toHaveValue(to); await expect(page.locator('#input-terminal')).toBeEnabled();
    expect(activated.at(-1)).toBe(to === 'aux1' ? '1001' : '1002');
    expect(await page.locator('#standby-frame').getAttribute('src')).toBe(terminalSource);
    await switchMode(page, 'terminal'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await expect(page.locator(`#terminal-tabs [data-terminal-choice=${to}]`)).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(terminalSource);
    await openInput(page); await page.locator('#mobile-input').fill('只写入终端3'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: to, text: '\x1b[200~只写入终端3\x1b[201~' }]);
    expect(httpOpens).toEqual([]); expect(offers.length).toBe(negotiated); expect(app.vncConnections).toBe(connections);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

for (const direct of [false, true]) test(`${direct ? 'direct' : 'relay'}: returning from the desktop waits for the parked terminal view to restore before attaching the selected target`, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  const parked = new Set();
  const app = await fixture({ rfb: true, seamless: true, webrtc: direct, fastConnect: direct, terminalViewHook: async (id, standby) => {
    if (standby) parked.add(id);
    else if (parked.delete(id)) await new Promise(resolve => setTimeout(resolve, 300));
  } });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    await login(page, app, { modeStandby: true, mode: 'terminal', workspaceLayout: 'sidebar' }); await prepared(page, 'desktop');
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await switchMode(page, 'desktop'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await expect.poll(() => parked.has('main')).toBe(true);
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await switchMode(page, 'terminal'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await expect(page.locator('#terminal-tabs [data-terminal-choice=aux1]')).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
  } finally { await app.close(); }
});

test('real tmux viewers follow main to the second terminal after parking and desktop focus', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  test.setTimeout(45000);
  const directory = await mkdtemp(join(tmpdir(), 'codex-real-mode-target-')), socket = join(directory, 'tmux.sock');
  // Only the PTY/tmux side is real here; desktop focus uses the fixture's X11
  // mock. Do not require xdotool or a running display in browser-only CI jobs.
  const exec = promisify(execFile), children = [], env = { ...process.env, DEPLOY_MODE: 'terminal', TERM: 'xterm-256color', HISTFILE: '/dev/null', DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  delete env.TMUX; delete env.DISPLAY; delete env.XAUTHORITY;
  const tmux = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 8192 });
  let app;
  try {
    const tokens = {};
    for (const [id, session] of [['main', 'codex'], ['aux1', 'codex-aux1']]) {
      await tmux(['-f', resolve('desktop/tmux.conf'), 'new-session', '-d', '-s', session, '-x', '80', '-y', '24', 'bash', '--noprofile', '--norc']);
      tokens[id] = (await tmux(['display-message', '-p', '-t', session, '#{pane_id}:#{pane_pid}'])).stdout.trim();
    }
    app = await fixture({ rfb: true, seamless: true });
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    app.config.terminalLaunch = target => {
      const child = spawn('python3', [resolve('desktop/web-terminal.py'), socket, target.terminalId, tokens[target.terminalId], '--geometry'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      children.push(child); return child;
    };
    await login(page, app, { modeStandby: true, mode: 'terminal', workspaceLayout: 'sidebar' }); await prepared(page, 'desktop');
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#terminal-tabs [data-terminal-choice=main]').click();
    await switchMode(page, 'desktop'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await switchMode(page, 'terminal'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await expect(page.locator('#terminal-tabs [data-terminal-choice=aux1]')).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
  } finally {
    await app?.close(); for (const child of children) child.kill();
    await tmux(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});

test('a rejected desktop focus clears the claimed active tab, never retries, and restores normal input only after a manual selection', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  let rejectFocus = true, release, entered, attempts = 0;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const app = await fixture({ rfb: true, seamless: true, desktopHook: async (command, args) => {
    if (command !== 'xdotool' || args[0] !== 'windowactivate') return;
    attempts++;
    if (rejectFocus) { entered(); await hold; throw Object.assign(Error('injected focus rejection'), { status: 409, outcome: 'rejected' }); }
  } });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    await login(page, app, { modeStandby: true, mode: 'terminal', workspaceLayout: 'sidebar' }); await prepared(page, 'desktop');
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await switchMode(page, 'desktop'); await started;
    await expect(page.locator('#desktop-frame')).toHaveAttribute('inert', ''); await expect(page.locator('#paste-button')).toBeDisabled();
    release(); await expect(page.locator('#toast')).toContainText('桌面终端窗口未确认切换');
    await expect(page.locator('#desktop-frame')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#terminal-tabs [aria-selected=true]')).toHaveCount(0); await expect(page.locator('#paste-button')).toBeDisabled();
    await page.locator('#terminal-switch-refresh').evaluate(button => button.click()); await expect(page.locator('#input-terminal')).toBeEnabled();
    expect(attempts).toBe(1); await expect(page.locator('#paste-button')).toBeDisabled();
    rejectFocus = false; await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click();
    await expect(page.locator('#terminal-tabs [data-terminal-choice=aux1]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#paste-button')).toBeEnabled(); expect(attempts).toBe(2);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});

test('a lost focus reply stays unknown without replaying the operation over HTTP or after reconnect', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  let attempts = 0; const writes = [];
  const app = await fixture({ rfb: true, seamless: true, desktopHook: (command, args) => { if (command === 'xdotool' && args[0] === 'windowactivate') attempts++; } });
  await page.addInitScript(() => {
    const original = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function(type, listener, options) {
      if (type !== 'message') return original.call(this, type, listener, options);
      return original.call(this, type, event => {
        if (typeof event.data === 'string') {
          let value; try { value = JSON.parse(event.data); } catch {}
          if (value?.type === 'panel-result' && value.ok && value.value?.opened === 'aux1') { this.close(); return; }
        }
        listener.call(this, event);
      }, options);
    };
  });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') writes.push(request.postDataJSON()); });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    await login(page, app, { workspaceLayout: 'sidebar' });
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click();
    await expect(page.locator('#toast')).toContainText('操作结果未知');
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await page.locator('#terminal-switch-refresh').evaluate(button => button.click()); await expect(page.locator('#input-terminal')).toBeEnabled();
    expect(attempts).toBe(1); expect(writes).toEqual([]); await expect(page.locator('#terminal-tabs [aria-selected=true]')).toHaveCount(0);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a rejected parked terminal attachment restores its actual target and preserves the other draft', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop terminal task tabs require the wide sidebar');
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '终端2', view: 'terminal' });
    await app.controls.manageTerminals({ action: 'create', name: '终端3', view: 'terminal' });
    await login(page, app, { modeStandby: true, mode: 'terminal', workspaceLayout: 'sidebar' }); await prepared(page, 'desktop');
    await page.locator('#terminal-tabs [data-terminal-choice=aux1]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await switchMode(page, 'desktop'); await expect(page.locator('#input-terminal')).toBeEnabled();
    await page.locator('#terminal-tabs [data-terminal-choice=aux2]').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux2');
    await openInput(page); await page.locator('#mobile-input').fill('终端3草稿'); await closePanels(page);
    const target = (await app.controls.listTerminals()).terminals.find(item => item.id === 'aux2');
    await app.controls.manageTerminals({ action: 'close', terminalId: target.id, terminalToken: target.token, confirm: true });
    await switchMode(page, 'terminal'); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#input-terminal')).toBeEnabled();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('codex-cloud.terminals.v1')).drafts.some(draft => draft.id === 'aux2' && draft.text === '终端3草稿'))).toBe(true);
    await openInput(page); await page.locator('#mobile-input').fill('继续终端2'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\x1b[200~继续终端2\x1b[201~' }]);
  } finally { await app.close(); }
});

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

test('a changed desktop input target retains its parked terminal, while backgrounding releases only standby', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  await app.controls.manageTerminals({ action: 'create', name: 'standby target', view: 'terminal' });
  try {
    await login(page, app, { modeStandby: true }); const main = await prepared(page, 'terminal');
    const desktopSource = await page.locator('#desktop-frame').getAttribute('src');
    await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    const auxiliary = await prepared(page, 'terminal'); expect(auxiliary.source).toBe(main.source);
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
