import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

async function setup(page, options = {}) {
  const app = await fixture({ rfb: true, seamless: true, ...options });
  if (options.maxTerminals !== 1) await app.controls.manageTerminals({ action: 'create', name: '待结束的任务', view: 'terminal' });
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', controlsCollapsed: true, terminalInputCollapsed: true })));
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
async function manager(page) { await openTools(page); await page.locator('#terminals-button').click(); }
const endButton = (page, id) => page.locator(`[data-terminal="${id}"] .terminal-close`);

test('close confirmation leaves a reusable placeholder and preserves drafts without reopening or selecting another task', async ({ page }) => {
  const app = await setup(page);
  try {
    const original = (await app.controls.listTerminals()).terminals;
    await choose(page, 'aux1'); await openInput(page); await page.locator('#mobile-input').fill('旧会话草稿，不能发给新 shell');
    await manager(page); await endButton(page, 'aux1').click();
    await expect(page.locator('#confirmation-description')).toContainText('待结束的任务');
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.keyboard.press('Enter');
    expect((await app.controls.listTerminals()).terminals).toEqual(original);
    await endButton(page, 'aux1').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminals-status')).toContainText('共 1');
    await page.locator('#close-terminals').click(); await closePanels(page);
    await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await expect(page.locator('#connection-status')).toContainText('终端已关闭');
    const afterClose = app.terminalConnections;
    await page.reload(); await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    expect(app.terminalConnections).toBe(afterClose);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('旧会话草稿，不能发给新 shell'); await expect(page.locator('#paste-button')).toBeDisabled();
    await closePanels(page); await page.locator('#choose-terminal-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    const reopened = (await app.controls.listTerminals()).terminals;
    expect(reopened[0]).toEqual(original[0]); expect(reopened[1].token).not.toBe(original[1].token);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('codex-cloud.terminals.v1')).drafts.map(item => item.text))).toContain('旧会话草稿，不能发给新 shell');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    await choose(page, 'main'); await expect(page.locator('#input-terminal')).toHaveValue('main');
  } finally { await app.close(); }
});

test('background close preserves the active stream and an empty slot is the quick create entry', async ({ page }) => {
  const app = await setup(page);
  try {
    const original = (await app.controls.listTerminals()).terminals[0], connections = app.terminalConnections;
    await manager(page); await endButton(page, 'aux1').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminals-status')).toContainText('共 1'); await page.locator('#close-terminals').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(connections);
    await choose(page, 'aux3');
    const result = await app.controls.listTerminals(); expect(result.terminals.map(item => item.id)).toEqual(['main', 'aux3']); expect(result.terminals[0]).toEqual(original);
    await expect(page.locator('#input-terminal')).toHaveValue('aux3'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('an unknown close result never retries or attaches a replacement until an explicit catalog refresh', async ({ page }) => {
  const app = await setup(page); let closes = 0;
  try {
    await choose(page, 'aux1'); await manager(page);
    await page.route('**/api/terminals', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'close') { closes++; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await endButton(page, 'aux1').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminals-status')).toContainText('结果未知'); expect(closes).toBe(1);
    const connections = app.terminalConnections;
    await expect(page.locator('#overlay-title')).toHaveText('请选择终端');
    await page.locator('#refresh-terminals').click(); await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    expect(app.terminalConnections).toBe(connections); expect(closes).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('takeover cancels a pending close and a stale confirmation cannot end any task', async ({ page, context }) => {
  const app = await setup(page);
  try {
    const original = await app.controls.listTerminals();
    await manager(page); await endButton(page, 'aux1').click();
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('终端在线');
      await expect(page.locator('#action-confirmation')).toBeHidden({ timeout: 10000 });
      await page.locator('#accept-confirmation').evaluate(button => button.click());
      expect(await app.controls.listTerminals()).toEqual(original); expect(app.terminalInputs).toEqual([]);
    } finally { await second.close(); }
  } finally { await app.close(); }
});

test('the final terminal remains closed across reload and its single slot can explicitly start a fresh shell', async ({ page }) => {
  const app = await setup(page, { maxTerminals: 1 });
  try {
    const original = (await app.controls.listTerminals()).terminals[0];
    await expect(page.locator('#terminal-session-bar')).toBeHidden();
    await manager(page); await endButton(page, 'main').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminals-status')).toContainText('共 0 / 1'); await page.locator('#close-terminals').click(); await closePanels(page);
    await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    await page.reload(); await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    await page.locator('#choose-terminal-button').click(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    const reopened = (await app.controls.listTerminals()).terminals;
    expect(reopened).toHaveLength(1); expect(reopened[0].id).toBe('main'); expect(reopened[0].token).not.toBe(original.token);
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
