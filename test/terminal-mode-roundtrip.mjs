// Actual browser -> panel -> Python PTY -> tmux/Xterm and a detached TUI.
// Desktop framebuffer pixels/auth are mocked; no production Codex is operated.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixture } from './fixture.mjs';

export async function terminalModeRoundtrip({ root, source, env, socket, target, controls, run, proof, desktopSize }) {
  assert.ok(socket.startsWith(root + '/') && proof.startsWith(root + '/'));
  const children = [];
  const direct = process.env.TERMINAL_ROUNDTRIP_DIRECT === '1';
  const app = await fixture({ rfb: true, seamless: true, webrtc: direct, fastConnect: direct, desktopHook: async (command, args) => {
    if (command === 'xdotool' && args[0] === 'windowactivate') await controls.manageTerminals({ action: 'open', ...target });
  } });
  app.config.terminalLaunch = () => {
    const child = spawn('python3', [join(source, 'desktop/web-terminal.py'), socket, target.terminalId, target.terminalToken, '--geometry'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    return child;
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      if (window !== parent) return;
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', modeStandby: true, terminalWidthMode: 'viewport', terminalFontSize: 15 }));
      window.roundtripSizes = [];
      window.addEventListener('message', event => {
        if (event.origin === location.origin && event.data?.type === 'codex-terminal-size') {
          window.roundtripSizes.push([event.data.cols, event.data.rows]);
          if (window.roundtripSizes.length > 32) window.roundtripSizes.shift();
        }
      });
    });
    await page.goto(app.config.origin);
    await page.locator('#password').fill(app.config.password);
    await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    if (direct) await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await expect(page.locator('#standby-frame')).toHaveAttribute('src', /\/desktop\/index.html/);
    const terminalSource = await page.locator('#desktop-frame').getAttribute('src');
    const state = async () => JSON.parse(await readFile(proof, 'utf8'));
    const initialPid = (await state()).pid;
    async function displayed(size, phase) {
      try {
        await expect.poll(async () => (await state()).events.at(-1).slice(1), { timeout: 7000 }).toEqual(size);
      } catch (error) {
        console.error('Isolated browser roundtrip failed:', JSON.stringify({ phase, expected: size, state: await state(),
          kernel: await run('tmux', ['-S', socket, 'display-message', '-p', '-t', 'codex', '#{pane_width}x#{pane_height}']),
          sizes: await page.evaluate(() => window.roundtripSizes) }));
        throw error;
      }
      assert.equal((await state()).hex, '', 'mode switches must not inject input');
      assert.equal((await state()).pid, initialPid);
    }
    async function switchMode(mode) {
      await page.locator(`#${mode}-mode`).click();
      await expect(page.locator('#action-confirmation')).toBeVisible();
      await page.locator('#accept-confirmation').click();
      await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
      await expect(page.locator('#input-terminal')).toBeEnabled();
    }
    for (let round = 0; round < 5; round++) {
      await expect.poll(() => page.evaluate(() => window.roundtripSizes.length)).toBeGreaterThan(0);
      const web = await page.evaluate(() => window.roundtripSizes.at(-1));
      assert.ok(web[0] < desktopSize[0], 'mobile web is narrower than the desktop');
      await displayed([web[0], web[1] - 1], `web-${round + 1}`);
      await switchMode('desktop');
      await displayed(desktopSize, `desktop-${round + 1}`);
      await switchMode('terminal');
      await expect(page.locator('#desktop-frame')).toHaveAttribute('src', terminalSource);
    }
    const last = await page.evaluate(() => window.roundtripSizes.at(-1));
    await displayed([last[0], last[1] - 1], 'web-final');
    assert.equal(children.length, 1, 'all five roundtrips reuse one actual Python PTY');
    assert.deepEqual(errors, []);
    console.log(`✓ actual Chromium/${direct ? 'WebRTC' : 'relay'} and native PTY: five warm roundtrips render the web and desktop sizes, without remote clicks, keys or viewer replacement`);
  } finally {
    await browser?.close();
    await app.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
