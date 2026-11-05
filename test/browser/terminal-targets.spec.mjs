import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools } from './ui.mjs';

async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}

test('an unsupported auxiliary layout disables only that target and keeps the valid main terminal connected', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '布局已变化', view: 'terminal' });
    await page.route('**/api/terminals', async route => {
      const response = await route.fetch(), data = await response.json();
      Object.assign(data.terminals.find(item => item.id === 'aux1'), { supported: false, token: null });
      await route.fulfill({ response, json: data });
    });
    await login(page, app);
    await expect(page.locator('#terminal-tabs [data-terminal-choice="aux1"]')).toBeDisabled();
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await openInput(page); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a reused terminal ID with a new process token cannot inherit selection or its old draft on reload', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '原终端', view: 'terminal' });
    await login(page, app); await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#mobile-input').fill('只属于原进程的草稿');
    const connected = app.terminalConnections;
    await page.route('**/api/terminals', async route => {
      const response = await route.fetch(), data = await response.json();
      data.terminals.find(item => item.id === 'aux1').token = '%1:9999';
      await route.fulfill({ response, json: data });
    });
    await page.reload(); await expect(page.locator('#choose-terminal-button')).toBeVisible();
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('只属于原进程的草稿');
    await expect(page.locator('#paste-button')).toBeDisabled(); expect(app.terminalConnections).toBe(connected);
    await page.locator('#input-terminal').selectOption('main'); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.unroute('**/api/terminals'); await openTools(page); await page.locator('#terminals-button').click();
    await expect(page.locator('#terminals-status')).toContainText('共 2'); await page.locator('#close-terminals').click();
    await openInput(page); await page.locator('#input-terminal').selectOption('aux1');
    await expect(page.locator('#mobile-input')).toHaveValue('只属于原进程的草稿');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
