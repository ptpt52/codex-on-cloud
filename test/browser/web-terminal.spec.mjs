import { openInput, openTools, closePanels } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#terminal-mode')).toBeEnabled();
}
async function terminal(page) { await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click(); await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#input-dock')).toBeHidden(); }

test('text mode shares the original task, uses native terminal input and separate paste/Enter, fits the viewport and returns to the desktop', async ({ page }, info) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, viewport: true });
  const initialFont = page.viewportSize().width <= 700 ? 10 : 15;
  try {
    await page.addInitScript(() => { window.terminalSizeReports = 0; window.addEventListener('message', event => { if (event.data?.type === 'codex-terminal-size') window.terminalSizeReports++; }); });
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('中文\n第二行'); await terminal(page);
    const desktopGeometry = (await app.controls.get()).actual;
    await expect.poll(() => page.evaluate(() => window.terminalSizeReports)).toBeGreaterThan(0);
    const reports = await page.evaluate(() => window.terminalSizeReports); await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.terminalSizeReports) - reports).toBeLessThanOrEqual(2);
    await page.locator('#toggle-input-button').click();
    const view = page.frameLocator('#desktop-frame'); await expect(view.locator('.xterm-screen')).toBeVisible();
    await openTools(page);
    await expect(page.locator('#terminal-view-controls')).toBeVisible(); await expect(page.locator('#desktop-settings-button')).toBeHidden();
    await expect.poll(() => app.terminalSizes.length).toBeGreaterThan(0);
    await openInput(page); await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~中文\n第二行\x1b[201~' }]); expect(app.inputCalls).toEqual([]);
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.terminalInputs.length).toBe(2); expect(app.terminalInputs[1].text).toBe('\r');
    await closePanels(page);
    await view.locator('.xterm-helper-textarea').press('a'); await expect.poll(() => app.terminalInputs.at(-1).text).toBe('a');
    await page.keyboard.insertText('直输中文'); await expect.poll(() => app.terminalInputs.at(-1).text).toBe('直输中文');
    const previous = app.terminalSizes.at(-1); await page.setViewportSize({ width: 600, height: 700 });
    await expect.poll(() => app.terminalSizes.at(-1).cols).not.toBe(previous.cols);
    const stageBox = await page.locator('#desktop-stage').boundingBox(), cardBox = await page.locator('#desktop-card').boundingBox();
    expect(stageBox.height).toBeGreaterThanOrEqual(240); expect(stageBox.y + stageBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1);
    await page.locator('#toggle-input-button').click();
    await openTools(page); await page.locator('#terminal-font-up').click(); await expect(page.locator('#terminal-font-label')).toHaveText(String(initialFont + 1));
    await page.screenshot({ path: `test-results/${info.project.name}-web-terminal.png` });
    expect((await app.controls.get()).actual).toEqual(desktopGeometry); expect(app.managementStats.restarts).toBe(0);
    await page.locator('#desktop-mode').click(); await page.locator('#accept-confirmation').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toBeVisible();
    expect((await app.controls.get()).session.pid).toBe(4000); await expect(page.locator('#mobile-input')).toHaveValue('中文\n第二行');
  } finally { await app.close(); }
});

test('terminal mode creates independent shells without opening X windows, switches slots and restores mode without recreating tasks', async ({ page }) => {
  const commands = [], app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, desktopHook: (command, args) => commands.push({ command, args }) });
  try {
    await login(page, app); await terminal(page); await openTools(page); await page.locator('#terminal-view-manage').click(); await expect(page.locator('#create-terminal')).toBeEnabled();
    await page.locator('#new-terminal-name').fill('后台日志'); await page.locator('#create-terminal').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await page.locator('#close-terminals').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#toggle-input-button').click();
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.terminalInputs.at(-1)?.terminalId).toBe('aux1');
    expect(commands.some(item => item.command === 'xdotool' && ['search', 'windowactivate'].includes(item.args[0]))).toBe(false);
    await openTools(page); await page.locator('#terminal-view-select').selectOption('main'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    app.disconnectTerminals(); await expect(page.locator('#connection-status')).toContainText('重连');
    await expect(page.locator('#terminal-view-select')).toBeEnabled(); await openTools(page); await page.locator('#terminal-view-select').selectOption('aux1');
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#terminal-mode')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    expect((await app.controls.listTerminals()).terminals.length).toBe(2); expect(commands.filter(item => item.args.includes('new-session')).length).toBe(1);
  } finally { await app.close(); }
});

test('a disconnected accepted terminal input stays unknown, reconnect attaches only and never replays it', async ({ page }) => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, terminalHook: async () => { entered(); await hold; } });
  try {
    await login(page, app); await terminal(page); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('[data-key="Enter"]').click(); await started;
    app.disconnectTerminals(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown'); release();
    await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 15000 });
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\r' }]); expect(app.inputCalls).toEqual([]);
    expect((await app.controls.listTerminals()).terminals.length).toBe(1); expect(app.terminalConnections).toBe(2);
  } finally { release(); await app.close(); }
});

test('takeover revokes the old text terminal and cancelled dangerous keys do not send', async ({ page, context }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    await login(page, app); await terminal(page); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('[data-key="Ctrl+C"]').click(); await page.keyboard.press('Enter'); expect(app.terminalInputs).toEqual([]);
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('终端在线');
      await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });
      expect(app.terminalConnections).toBe(2); expect(app.terminalInputs).toEqual([]); expect((await app.controls.get()).session.pid).toBe(4000);
    } finally { await second.close(); }
  } finally { await app.close(); }
});
