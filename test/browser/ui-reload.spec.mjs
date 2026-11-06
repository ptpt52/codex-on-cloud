import { test, expect } from '@playwright/test';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { fixture } from '../fixture.mjs';
import { uiSnapshot } from '../support/ui-snapshot.mjs';

test('live UI publication keeps old modules coherent, preserves draft and frame, and a new page loads the new snapshot', async ({ page, context }) => {
  const snapshot = await uiSnapshot(), app = await fixture({ uiRoot: snapshot.root, rfb: true, rfbSize: { width: 640, height: 480 } });
  try {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#toggle-input-button').click();
    await page.locator('#mobile-input').fill('发布期间保留的中文草稿');
    const initial = app.panel.uiRevision, frame = await page.locator('#desktop-frame').getAttribute('src');
    expect(frame).toContain('ui=' + initial);
    const control = new URL('control.js', snapshot.root); await writeFile(control, (await readFile(control, 'utf8')) + '\n// browser-updated-control');
    await app.panel.reloadUI(); expect(app.panel.uiRevision).not.toBe(initial);
    expect(await page.locator('meta[name="ui-revision"]').getAttribute('content')).toBe(initial);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(frame);
    await expect(page.locator('#mobile-input')).toHaveValue('发布期间保留的中文草稿');
    const old = await page.request.get(app.config.origin + '/control.js?ui=' + initial); expect(await old.text()).not.toContain('browser-updated-control');
    const second = await context.newPage(); await second.goto(app.config.origin);
    await expect(second.locator('meta[name="ui-revision"]')).toHaveAttribute('content', app.panel.uiRevision);
    await expect(second.locator('#forward-button')).toBeEnabled(); await second.close();
    expect(errors).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); await rm(snapshot.directory, { recursive: true, force: true }); }
});
