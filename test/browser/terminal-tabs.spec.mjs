import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

async function setup(page, options = {}) {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, ...options });
  await app.controls.manageTerminals({ action: 'create', name: '测试终端', view: 'terminal' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('codex-cloud.display.v1')) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, mode: 'terminal', terminalInputCollapsed: true }));
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return app;
}
async function choose(page, id) {
  await closePanels(page);
  if (await page.locator('#terminal-session-button').isVisible()) {
    await page.locator('#terminal-session-button').click();
    await page.locator(`#terminal-switch-list [data-terminal-choice="${id}"]`).click();
  } else await page.locator(`#terminal-tabs [data-terminal-choice="${id}"]`).click();
  await expect(page.locator('#input-terminal')).toHaveValue(id);
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
test('terminal labels switch only the current stream, isolate drafts and restore a verified selection after reload', async ({ page }) => {
  const app = await setup(page);
  try {
    const original = await app.controls.listTerminals();
    expect(app.terminalConnections).toBe(1);
    await openInput(page); await page.locator('#mobile-input').fill('主终端草稿');
    await choose(page, 'aux1'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('辅助终端草稿'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\x1b[200~辅助终端草稿\x1b[201~' }]);
    await choose(page, 'main'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端草稿');
    const count = app.terminalConnections; await choose(page, 'main'); expect(app.terminalConnections).toBe(count);
    await choose(page, 'aux1'); await page.reload();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('辅助终端草稿');
    expect(app.terminalInputs).toHaveLength(1); expect(app.inputCalls).toEqual([]);
    await expect.poll(() => app.terminalChildren.length).toBe(1);
    expect(await app.controls.listTerminals()).toEqual(original); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
test('single-terminal mode keeps the session bar hidden and preserves the focused phone layout', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#terminal-mode').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#terminal-session-bar')).toBeHidden();
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('helper pending input and composition cannot switch targets or queue a later switch', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const app = await setup(page, { terminalHook: async () => hold });
  try {
    await openInput(page); await page.locator('#mobile-input').fill('正在编辑');
    await page.locator('#mobile-input').dispatchEvent('compositionstart', { data: '中' });
    await expect(page.locator('#input-terminal')).toBeDisabled();
    await page.locator('#input-terminal').evaluate(select => { select.value = 'aux1'; select.dispatchEvent(new Event('change')); });
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(app.terminalConnections).toBe(1);
    await page.locator('#mobile-input').dispatchEvent('compositionend', { data: '中' });
    await page.locator('#paste-button').click(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'pending');
    await page.locator('#input-terminal').evaluate(select => { select.value = 'aux1'; select.dispatchEvent(new Event('change')); });
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    release(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalConnections).toBe(1); await choose(page, 'aux1'); expect(app.terminalInputs).toHaveLength(1);
  } finally { release(); await app.close(); }
});
test('restoration waits for the catalog and never falls back or transplants a draft after an identity change', async ({ page }) => {
  const app = await setup(page);
  let release, entered; const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  try {
    await choose(page, 'aux1'); await openInput(page); await page.locator('#mobile-input').fill('旧目标草稿');
    const before = app.terminalConnections;
    await page.route('**/api/terminals', async route => {
      const response = await route.fetch(), data = await response.json(); entered(); await hold;
      data.terminals = data.terminals.filter(item => item.id !== 'aux1'); await route.fulfill({ response, json: data });
    });
    await page.reload(); await started; expect(app.terminalConnections).toBe(before);
    release(); await expect(page.locator('#choose-terminal-button')).toBeVisible();
    expect(app.terminalConnections).toBe(before);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('旧目标草稿'); await expect(page.locator('#paste-button')).toBeDisabled();
    await choose(page, 'main'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.unroute('**/api/terminals'); await openTools(page); await page.locator('#terminals-button').click();
    await expect(page.locator('#clear-stale-drafts')).toBeDisabled();
    await page.locator('#close-terminals').click(); await choose(page, 'aux1'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('旧目标草稿');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { release?.(); await app.close(); }
});

test('composition in the native terminal disables session selection until it ends', async ({ page }) => {
  const app = await setup(page);
  try {
    const field = page.frameLocator('#desktop-frame').locator('.xterm-helper-textarea');
    await field.dispatchEvent('compositionstart', { data: '中' });
    await expect(page.locator('#terminal-session-button')).toBeDisabled();
    await expect(page.locator('#terminal-tabs [data-terminal-choice="aux1"]')).toBeDisabled();
    await page.locator('#terminal-view-select').evaluate(select => { select.value = 'aux1'; select.dispatchEvent(new Event('change')); });
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(app.terminalConnections).toBe(1);
    await field.dispatchEvent('compositionend', { data: '中' });
    await expect(page.locator('#terminal-session-button')).toBeEnabled();
    await choose(page, 'aux1'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('expired drafts are removed only after explicit confirmation while live drafts remain', async ({ page }) => {
  const app = await setup(page);
  try {
    await choose(page, 'aux1'); await openInput(page); await page.locator('#mobile-input').fill('等待清理的旧草稿'); await choose(page, 'main');
    await openInput(page); await page.locator('#mobile-input').fill('当前草稿保留');
    await page.route('**/api/terminals', async route => {
      const response = await route.fetch(), value = await response.json(); value.terminals = value.terminals.filter(item => item.id !== 'aux1'); await route.fulfill({ response, json: value });
    });
    await openTools(page); await page.locator('#terminals-button').click();
    await expect(page.locator('#clear-stale-drafts')).toBeEnabled(); await page.locator('#clear-stale-drafts').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.keyboard.press('Enter');
    const texts = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('codex-cloud.terminals.v1')).drafts.map(item => item.text));
    expect(await texts()).toContain('等待清理的旧草稿');
    await page.locator('#clear-stale-drafts').click(); await page.locator('#accept-confirmation').click();
    expect(await texts()).not.toContain('等待清理的旧草稿'); expect(await texts()).toContain('当前草稿保留'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
