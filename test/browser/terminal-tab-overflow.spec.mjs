import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

async function setup(page, count) {
  const app = await fixture({ mode: 'terminal', maxTerminals: 8, rfb: true });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: `辅助终端 ${n} 的任务`, view: 'terminal' });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return app;
}
const tab = (page, id) => page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
const picker = page => page.locator('#terminal-session-button');
const list = page => page.locator('#terminal-switch-list');
async function choose(page, id) {
  if (await picker(page).isVisible()) {
    await picker(page).click(); await list(page).locator(`[data-terminal-choice=${id}]`).click();
  } else await tab(page, id).click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}

test('desktop overflow uses the mobile terminal picker and restores all tabs when they fit', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop responsive layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  const app = await setup(page, 8);
  try {
    const original = await app.controls.listTerminals(), connections = app.terminalConnections;
    for (const width of [1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(picker(page)).toBeVisible(); await expect(page.locator('#terminal-tabs')).toBeHidden();
      await picker(page).click();
      await expect(list(page).locator('[data-terminal-choice]')).toHaveCount(9);
      await expect(list(page).locator('[data-terminal-choice=aux7]')).toBeVisible();
      await expect(list(page).locator('[data-terminal-close=aux7]')).toBeVisible();
      await expect(list(page).locator('[data-terminal-choice=new]')).toBeDisabled();
      await page.locator('#close-terminal-switch').click(); await expect(picker(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    expect(app.terminalConnections).toBe(connections); expect(await app.controls.listTerminals()).toEqual(original);
    await choose(page, 'aux7'); await expect(page.locator('#input-terminal')).toHaveValue('aux7');
    await expect(picker(page)).toHaveAccessibleName('辅助终端 7 的任务 ▾');
    await page.screenshot({ path: info.outputPath('terminal-picker.png') });
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator('#terminal-tabs')).toBeVisible(); await expect(picker(page)).toBeHidden();
    expect(await page.locator('#terminal-tabs').evaluate(tabs => {
      const viewport = tabs.getBoundingClientRect();
      return [...tabs.children].every(item => { const box = item.getBoundingClientRect(); return box.left >= viewport.left - 1 && box.right <= viewport.right + 1; });
    })).toBe(true);
    await tab(page, 'main').focus(); await page.keyboard.press('End'); await expect(tab(page, 'aux7')).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(picker(page)).toBeVisible(); await expect(picker(page)).toBeFocused();
    await page.setViewportSize({ width: 1920, height: 900 }); await expect(tab(page, 'aux7')).toBeFocused();
    await page.locator('#terminal-tabs [data-terminal-close=aux7]').focus();
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(picker(page)).toBeFocused();
    await page.locator('#terminal-session-close').focus();
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator('#terminal-tabs [data-terminal-close=aux7]')).toBeFocused();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('creating desktop terminals switches to a picker before tabs become inaccessible and preserves quick close', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop responsive layout');
  await page.setViewportSize({ width: 1100, height: 800 });
  const app = await setup(page, 5);
  try {
    await expect(page.locator('#terminal-tabs')).toBeVisible();
    for (const id of ['aux5', 'aux6', 'aux7']) {
      await choose(page, 'new');
      await expect(page.locator('#input-terminal')).toHaveValue(id);
      await expect(picker(page)).toBeVisible(); await expect(page.locator('#terminal-tabs')).toBeHidden();
      await expect(picker(page)).toHaveAccessibleName(`${(await app.controls.listTerminals()).terminals.find(item => item.id === id).name} ▾`);
    }
    await picker(page).click();
    await expect(list(page).locator('[data-terminal-choice][data-available=true]')).toHaveCount(1);
    await expect(list(page).locator('[data-terminal-choice=new]')).toBeDisabled();
    await page.locator('#close-terminal-switch').click();
    expect((await app.controls.listTerminals()).terminals).toHaveLength(8);
    await page.locator('#terminal-session-close').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.locator('#cancel-confirmation').click();
    expect((await app.controls.listTerminals()).terminals).toHaveLength(8);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
