import { openTools } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function prepare(page, mode = 'scale') {
  await page.addInitScript(mode => {
    if (window === parent && !localStorage.getItem('codex-cloud.display.v1')) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalWidthMode: mode, terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal; window.terminalInstances = 0;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.widthTerminal = this; window.terminalInstances++; } }; } });
  }, mode);
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 20000 });
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
const dimensions = frame => frame.evaluate(() => {
  const term = window.widthTerminal, host = document.getElementById('terminal'), screen = document.querySelector('.xterm-screen');
  return { cols: term.cols, rows: term.rows, font: term.options.fontSize, hostWidth: host.clientWidth, hostHeight: host.clientHeight,
    width: screen.getBoundingClientRect().width, height: screen.getBoundingClientRect().height };
});
function geometry(app, maxCols) { app.terminalGeometry.maxCols = maxCols; app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'geometry', maxCols }) + '\n'); }

test.describe('touch terminal right edge', () => {
  test.use({ viewport: { width: 407, height: 900 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test('scrollbar stays outside the last column and both text gutters differ by at most one cell', async ({ page }, info) => {
    const app = await fixture({ mode: 'terminal' });
    try {
      await prepare(page, 'viewport'); const frame = await login(page, app);
      for (const width of [320, 390, 407, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => frame.evaluate(() => {
          const screen = document.querySelector('.xterm-screen').getBoundingClientRect(), t = window.widthTerminal;
          return Math.abs(screen.left - (innerWidth - screen.right)) <= t._core._renderService.dimensions.css.cell.width + 1;
        })).toBe(true);
        const edge = await frame.evaluate(async () => {
          const t = window.widthTerminal;
          await new Promise(resolve => t.write('\x1b[2J\x1b[H\x1b[42m' + 'W'.repeat(t.cols - 1) + 'Z\x1b[0m', resolve));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
          const scrollbar = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical').getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(document.querySelector('.xterm-rows > div'));
          return { textRight: range.getBoundingClientRect().right, screenRight: screen.right, scrollbarLeft: scrollbar.left, scrollbarWidth: scrollbar.width, viewport: innerWidth };
        });
        expect(edge.scrollbarWidth).toBe(6); expect(edge.scrollbarLeft).toBeGreaterThanOrEqual(edge.screenRight - .5);
        expect(edge.textRight).toBeLessThanOrEqual(edge.screenRight + .5); expect(edge.screenRight).toBeLessThan(edge.viewport);
      }
      await page.setViewportSize({ width: 407, height: 900 });
      await expect.poll(() => frame.evaluate(() => Math.abs(document.querySelector('.xterm-screen').getBoundingClientRect().left -
        (innerWidth - document.querySelector('.xterm-screen').getBoundingClientRect().right)) <= window.widthTerminal._core._renderService.dimensions.css.cell.width + 1)).toBe(true);
      await frame.evaluate(() => new Promise(resolve => window.widthTerminal.write('\x1b[2J\x1b[H\x1b[42m' + 'W'.repeat(window.widthTerminal.cols - 1) + 'Z\x1b[0m', resolve)));
      await page.screenshot({ path: info.outputPath('touch-terminal-right-edge.png') });
      expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    } finally { await app.close(); }
  });
});

test('desktop scrollbar shares the outer gutter and the grid fills the available width', async ({ page }, info) => {
  test.skip(info.project.use.isMobile, 'Desktop mouse scrollbar');
  let source = '';
  const app = await fixture({ mode: 'terminal', terminalHistory: () => source });
  try {
    await prepare(page, 'viewport'); const frame = await login(page, app);
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => frame.evaluate(() => {
        const screen = document.querySelector('.xterm-screen').getBoundingClientRect(), t = window.widthTerminal;
        const bar = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical').getBoundingClientRect();
        const cell = screen.width / t.cols, right = innerWidth - screen.right;
        return bar.width === 8 && bar.left >= screen.right - .5 && right >= 7.5 && right - screen.left <= cell + 1;
      })).toBe(true);
    }
    const cols = await frame.evaluate(() => window.widthTerminal.cols); source = 'x'.repeat(cols) + '\n'.repeat(100);
    await page.locator('#history-up').click(); const archive = frame.locator('#history-archive'); await expect(archive).toBeVisible();
    expect(await archive.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('viewport layout keeps the chosen font and reflows columns from phone to wide screen without reconnect or input', async ({ page }) => {
  const app = await fixture({ webrtc: true, terminalMaxCols: 122 });
  try {
    await prepare(page, 'viewport'); await page.setViewportSize({ width: 1920, height: 1080 }); const frame = await login(page, app);
    await expect(page.locator('#terminal-width-mode')).toHaveValue('viewport');
    await expect.poll(async () => (await dimensions(frame)).cols).toBeGreaterThan(180);
    for (const width of [2560, 1280, 700, 320, 390, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(async () => { const size = await dimensions(frame); return size.font === 15 && size.width <= size.hostWidth && size.width / size.hostWidth > (width < 400 ? .88 : .96); }).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await openTools(page); await page.locator('#terminal-font-up').click(); await expect.poll(async () => (await dimensions(frame)).font).toBe(16);
    expect((await dimensions(frame)).cols).toBeGreaterThan(170);
    await openTools(page); await page.locator('#terminal-width-mode').selectOption('scale'); await expect.poll(async () => (await dimensions(frame)).font).toBeGreaterThan(20);
    await openTools(page); await page.locator('#terminal-width-mode').selectOption('viewport'); await expect.poll(async () => (await dimensions(frame)).font).toBe(16);
    expect((await dimensions(frame)).cols).toBeGreaterThan(170);
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('width fit fills a wide screen through the direct channel, restores narrow sizes and keeps manual sizing without reconnecting', async ({ page }, info) => {
  const app = await fixture({ webrtc: true, terminalMaxCols: 122 });
  try {
    await prepare(page); await page.setViewportSize({ width: 1920, height: 1080 }); const frame = await login(page, app);
    await expect.poll(async () => (await dimensions(frame)).font).toBeGreaterThan(20);
    let size = await dimensions(frame); expect(size.cols).toBeLessThanOrEqual(122); expect(size.cols).toBeGreaterThan(118);
    expect(size.width / size.hostWidth).toBeGreaterThan(.97); expect(size.width).toBeLessThanOrEqual(size.hostWidth); expect(size.height).toBeLessThanOrEqual(size.hostHeight);
    await expect(page.locator('#terminal-width-mode')).toHaveValue('scale');
    expect(app.terminalConnections).toBe(1); expect(app.vncConnections).toBe(0);
    const records = app.terminalSizes.length; await page.waitForTimeout(300); expect(app.terminalSizes.length - records).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/${info.project.name}-terminal-wide-fit.png` });

    await openTools(page); await page.locator('#terminal-width-mode').selectOption('manual'); await expect.poll(async () => (await dimensions(frame)).font).toBe(15);
    expect((await dimensions(frame)).cols).toBeGreaterThan(180); await expect(page.locator('#terminal-width-mode')).toHaveValue('manual');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    const next = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await expect(page.locator('#terminal-width-mode')).toHaveValue('manual'); expect((await dimensions(next)).font).toBe(15);
    await openTools(page); await page.locator('#terminal-width-mode').selectOption('scale'); await expect.poll(async () => (await dimensions(next)).font).toBeGreaterThan(20);
    const connections = app.terminalConnections;
    for (const width of [2560, 1280, 700, 320, 390, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(async () => (await dimensions(next)).hostWidth).toBeLessThan(width);
      await expect.poll(async () => { const value = await dimensions(next); return value.width <= value.hostWidth && value.width / value.hostWidth > (width < 400 ? .88 : .96); }).toBe(true);
      size = await dimensions(next);
      expect(size.cols).toBeLessThanOrEqual(122); expect(size.rows).toBeGreaterThan(0); expect(size.height).toBeLessThanOrEqual(size.hostHeight);
      if (width < 700) expect(size.font).toBe(15);
      expect(await next.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    geometry(app, 90); await expect.poll(async () => (await dimensions(next)).cols).toBeLessThanOrEqual(90);
    geometry(app, 500); await expect.poll(async () => (await dimensions(next)).font).toBe(15); expect((await dimensions(next)).cols).toBeGreaterThan(180);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.terminalHistoryReads).toEqual([]); expect(app.terminalConnections).toBe(connections);
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('real tmux shared with a narrower PTY fits without dot padding, follows peer changes and preserves the shell across reconnect', async ({ page }, info) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'codex-browser-width-')), socket = join(directory, 'tmux.sock'), proof = join(directory, 'once'), clients = [];
  const env = { ...process.env, HOME: directory, HISTFILE: '/dev/null', TERM: 'xterm-256color', PATH: `${resolve('data/host-tools/usr/bin')}:${process.env.PATH}`, WIDTH_TEST_PROOF: proof };
  delete env.TMUX; delete env.DISPLAY; delete env.XAUTHORITY;
  const exec = promisify(execFile), run = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 8192 });
  let app;
  try {
    await exec('tmux', ['-f', resolve('desktop/tmux.conf'), '-S', socket, 'new-session', '-d', '-s', 'codex', '-x', '122', '-y', '125', 'bash --noprofile --norc'], { env, timeout: 3000 });
    const token = (await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim();
    function client() {
      const child = spawn('python3', [resolve('desktop/web-terminal.py'), socket, 'main', token, '--geometry'], { env, stdio: ['pipe', 'pipe', 'ignore'] }); clients.push(child); return child;
    }
    const peer = client(), peerRecords = []; let pending = '';
    peer.stdout.on('data', bytes => {
      pending += bytes.toString(); let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { const value = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); if (value.type === 'result') peerRecords.push(value); }
    });
    // This attached PTY stands in for the desktop's unchanged 122-column Xterm.
    peer.stdin.write(JSON.stringify({ id: 1, action: 'resize', cols: 122, rows: 125 }) + '\n');
    await expect.poll(() => peerRecords.some(value => value.id === 1 && value.ok)).toBe(true);
    peer.stdin.write(JSON.stringify({ id: 2, action: 'input', data: Buffer.from('printf "once\\n" >> "$WIDTH_TEST_PROOF"\r').toString('base64') }) + '\n');
    await expect.poll(async () => { try { return await readFile(proof, 'utf8'); } catch { return ''; } }).toBe('once\n');
    app = await fixture(); app.config.terminalLaunch = client;
    await prepare(page); await page.setViewportSize({ width: 1920, height: 1080 }); const frame = await login(page, app);
    await expect.poll(async () => (await dimensions(frame)).font).toBeGreaterThan(20);
    let size = await dimensions(frame);
    await expect.poll(async () => Number((await run(['display-message', '-p', '-t', 'codex', '#{pane_width}'])).stdout.trim())).toBe(size.cols);
    expect(size.width / size.hostWidth).toBeGreaterThan(.97);
    expect(await frame.evaluate(() => {
      const term = window.widthTerminal, buffer = term.buffer.active;
      return Array.from({ length: term.rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true)).some(line => /\.{10,}$/.test(line));
    })).toBe(false);
    await page.screenshot({ path: `test-results/${info.project.name}-terminal-native-width.png` });
    peer.stdin.write(JSON.stringify({ id: 3, action: 'resize', cols: 90, rows: 125 }) + '\n');
    await expect.poll(async () => (await dimensions(frame)).cols, { timeout: 7000 }).toBeLessThanOrEqual(90);
    size = await dimensions(frame); expect(size.width / size.hostWidth).toBeGreaterThan(.97);
    expect((await run(['list-clients', '-F', '#{client_width}x#{client_height}'])).stdout).toContain('90x125');
    const attached = clients.at(-1); attached.kill('SIGTERM');
    await expect.poll(() => clients.length).toBe(3); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect.poll(async () => (await dimensions(frame)).cols).toBeLessThanOrEqual(90);
    expect(await frame.evaluate(() => window.terminalInstances)).toBe(1);
    peer.stdin.end(); await expect.poll(async () => (await dimensions(frame)).font, { timeout: 7000 }).toBe(15);
    expect((await dimensions(frame)).cols).toBeGreaterThan(180);
    expect((await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim()).toBe(token);
    expect(await readFile(proof, 'utf8')).toBe('once\n'); expect(app.managementStats.restarts).toBe(0);
  } finally {
    await app?.close(); for (const child of clients) if (child.exitCode === null) child.kill('SIGTERM');
    await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
