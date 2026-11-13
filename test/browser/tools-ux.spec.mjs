import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

test('tools keep their close button and preference status reachable while keyboard focus scrolls to the last action', async ({ page }) => {
  test.setTimeout(60000);
  for (const mode of ['desktop', 'terminal']) {
    const app = await fixture({ rfb: true, mode }), errors = [];
    const pageError = error => errors.push(error.message); page.on('pageerror', pageError);
    try {
      await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
      await expect(page.locator('#connection-status')).toContainText('在线');
      await openInput(page); await page.locator('#mobile-input').fill('滚动工具面板后保留的草稿'); await closePanels(page);
      const source = await page.locator('#desktop-frame').getAttribute('src'), connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
      for (const [index, size] of [{ width: 320, height: 500 }, { width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 1440, height: 240 }].entries()) {
        await page.setViewportSize(size);
        // The media-query change moves controls after the viewport updates.
        await expect(page.locator('#workspace-view')).toHaveAttribute('data-workspace-layout', size.width >= 1200 ? 'sidebar' : 'top');
        const frame = await page.locator('#desktop-frame').boundingBox();
        await openTools(page);
        const close = page.locator('#close-controls-button'), initial = await close.boundingBox();
        await page.locator('#access-settings-button').focus();
        await expect(page.locator('#access-settings-button')).toBeInViewport();
        await expect(page.locator('#browser-preferences-note')).toBeInViewport();
        await expect(close).toBeInViewport();
        expect(await close.boundingBox()).toEqual(initial);
        // Firefox can round a 44px rectangle down by a few millionths of a pixel.
        expect(initial.width).toBeGreaterThanOrEqual(43.99); expect(initial.height).toBeGreaterThanOrEqual(43.99);
        expect(await page.locator('#workspace-tools').evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
        if (index % 2) { await page.keyboard.press('Escape'); await expect(page.locator('#toggle-controls-button')).toBeFocused(); }
        else await close.click();
        await expect(page.locator('#workspace-tools')).toBeHidden();
        expect(await page.locator('#desktop-frame').boundingBox()).toEqual(frame);
        expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
      }
      await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('滚动工具面板后保留的草稿');
      expect({ vnc: app.vncConnections, terminal: app.terminalConnections }).toEqual(connections); expect(app.managementStats.restarts).toBe(0);
      expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(errors).toEqual([]);
    } finally { page.off('pageerror', pageError); await app.close(); }
  }
});

test('server desktop settings keep their heading and result visible while scrolling without replacing the viewer', async ({ page }) => {
  const app = await fixture({ rfb: true, viewport: true });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await openTools(page); await page.locator('#desktop-settings-button').click();
    await expect(page.locator('#maximize-terminal')).toBeEnabled();
    const source = await page.locator('#desktop-frame').getAttribute('src'), connections = app.vncConnections;
    for (const size of [{ width: 320, height: 500 }, { width: 1024, height: 768 }, { width: 1440, height: 240 }]) {
      await page.setViewportSize(size); await page.locator('#restore-terminal').focus();
      await expect(page.locator('#restore-terminal')).toBeInViewport(); await expect(page.locator('#close-desktop-settings')).toBeInViewport();
      await expect(page.locator('#refresh-desktop-settings')).toBeInViewport();
      expect(await page.locator('#desktop-settings-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const body = await page.locator('#desktop-settings-dialog .settings-dialog-body').boundingBox(), button = await page.locator('#restore-terminal').boundingBox();
      expect(button.y).toBeGreaterThanOrEqual(body.y - 1); expect(button.y + button.height).toBeLessThanOrEqual(body.y + body.height + 1);
    }
    await page.locator('#close-desktop-settings').click();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(connections);
    expect(app.managementStats.restarts).toBe(0); expect(app.managementStats.saves).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop and terminal access settings retain drafts and reachable close and feedback areas in short viewports', async ({ page }) => {
  test.setTimeout(60000);
  for (const mode of ['desktop', 'terminal']) {
    const app = await fixture({ mode, rfb: true });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
      await expect(page.locator('#connection-status')).toContainText('在线'); await openTools(page); await page.locator('#access-settings-button').click();
      await expect(page.locator('#temporary-save')).toBeEnabled(); await expect(page.locator('#screen-lock-password')).toBeDisabled();
      await page.locator('#screen-lock-enabled').check(); await page.locator('#screen-lock-password').fill('test-only-lock-draft');
      await page.locator('#temporary-enabled').check(); await page.locator('#temporary-username').fill('draft-visitor');
      const source = await page.locator('#desktop-frame').getAttribute('src'), connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
      for (const size of [{ width: 320, height: 500 }, { width: 1024, height: 768 }, { width: 1440, height: 240 }]) {
        await page.setViewportSize(size); await page.locator('#temporary-save').focus();
        await expect(page.locator('#temporary-save')).toBeInViewport(); await expect(page.locator('#access-close')).toBeInViewport();
        await expect(page.locator('#access-dialog .settings-dialog-footer')).toBeInViewport();
        await expect(page.locator('#temporary-username')).toHaveValue('draft-visitor');
        await expect(page.locator('#screen-lock-password')).toHaveValue('test-only-lock-draft');
        expect(await page.locator('#access-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await page.locator('#access-close').click(); await expect(page.locator('#screen-lock-password')).toHaveValue('');
      expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
      expect({ vnc: app.vncConnections, terminal: app.terminalConnections }).toEqual(connections);
      expect(app.managementStats.restarts).toBe(0); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    } finally { await app.close(); }
  }
});

test('unlock and temporary confirmation keep both actions reachable on narrow and short screens', async ({ page }) => {
  const app = await fixture({ rfb: true }), password = 'test-only-prompt-password';
  try {
    await app.login(); await app.claim();
    expect((await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password, durationMs: 3600000 } })).status).toBe(200);
    expect((await app.request('/api/security/screen-lock', { method: 'POST', body: { enabled: true, password } })).status).toBe(200);
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#unlock-dialog')).toBeVisible();
    for (const size of [{ width: 320, height: 500 }, { width: 1024, height: 768 }, { width: 1440, height: 240 }]) {
      await page.setViewportSize(size); await page.locator('#unlock-password').focus();
      for (const id of ['unlock-close', 'unlock-password', 'unlock-cancel', 'unlock-submit']) await expect(page.locator('#' + id)).toBeInViewport();
      expect(await page.locator('#unlock-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await page.locator('#unlock-password').fill(password); await page.locator('#unlock-submit').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线'); await openTools(page); await page.locator('#access-settings-button').click();
    await expect(page.locator('#temporary-enabled')).toBeChecked(); await page.locator('#temporary-enabled').uncheck(); await page.locator('#temporary-save').click();
    await expect(page.locator('#access-confirm-title')).toHaveText('停用临时账号？');
    for (const size of [{ width: 320, height: 500 }, { width: 1440, height: 240 }]) {
      await page.setViewportSize(size);
      for (const id of ['access-confirm-cancel', 'access-confirm-accept']) await expect(page.locator('#' + id)).toBeInViewport();
      expect(await page.locator('#access-confirm').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await page.locator('#access-confirm-cancel').click(); await expect(page.locator('#temporary-state')).toHaveText('当前有效');
    expect(app.managementStats.restarts).toBe(0); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
