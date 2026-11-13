import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

// The recovery case injects an HTTP catalog, including after a page reload.
test.use({ serviceWorkers: 'block' });

// These cases exercise the optional horizontal layout; sidebar navigation has
// its own full-height, scrolling and keyboard coverage in sidebar-layout.
async function setup(page, count, mode = 'terminal', desktopHook) {
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top' })));
  const app = await fixture({ mode, maxTerminals: 8, rfb: true, desktopHook });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: `辅助终端 ${n} 的任务`, view: 'terminal' });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
  return app;
}

test('desktop top tabs and compact picker activate the same tasks without replacing the viewer', async ({ page }, info) => {
  const activated = [];
  const app = await setup(page, 8, 'desktop', (command, args) => { if (command === 'xdotool' && args[0] === 'windowactivate') activated.push(args.at(-1)); });
  try {
    const original = await app.controls.listTerminals(), source = await page.locator('#desktop-frame').getAttribute('src'), connections = app.vncConnections;
    const ids = original.terminals.map(item => item.id);
    await expect(page.locator('#terminal-tabs')).toHaveAttribute('aria-label', '桌面终端任务');
    await expect(tab(page, 'new')).toHaveCount(0);
    if (!info.project.use.hasTouch && !info.project.use.isMobile) {
      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(tab(page, 'main')).toBeVisible(); await expect(picker(page)).toBeVisible();
      await expect.poll(() => fitted(page)).toBe(true);
      await picker(page).click(); await expect(page.locator('#terminal-switch-title')).toHaveText('更多终端');
      await expect.poll(() => page.locator('#terminal-tabs [data-terminal-choice], #terminal-switch-list [data-terminal-choice]').evaluateAll(buttons =>
        buttons.filter(button => button.getClientRects().length).map(button => button.dataset.terminalChoice))).toEqual(ids);
      await list(page).locator('[data-terminal-choice=aux7]').click();
    } else {
      await page.setViewportSize({ width: 768, height: 900 });
      await picker(page).click(); await expect(page.locator('#terminal-switch-title')).toHaveText('选择桌面终端');
      expect(await visibleChoices(list(page))).toEqual(ids);
      await list(page).locator('[data-terminal-choice=aux7]').click();
    }
    await expect(page.locator('#input-terminal')).toHaveValue('aux7');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker(page)).toContainText('辅助终端 7 的任务');
    await expect(page.locator('#terminal-session-actions')).toBeVisible();
    await picker(page).click(); expect(await visibleChoices(list(page))).toEqual(ids);
    await list(page).locator('[data-terminal-choice=main]').click(); await expect(page.locator('#input-terminal')).toHaveValue('main');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: info.outputPath('desktop-terminal-picker.png') });
    if (!info.project.use.hasTouch && !info.project.use.isMobile) {
      await page.setViewportSize({ width: 1920, height: 900 });
      await expect(picker(page)).toBeHidden(); await expect(tab(page, 'aux7')).toBeVisible();
      await tab(page, 'aux1').click(); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
      expect(activated).toEqual(['1007', '999', '1001']);
      await page.screenshot({ path: info.outputPath('desktop-terminal-tabs.png') });
    } else expect(activated).toEqual(['1007', '999']);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.vncConnections).toBe(connections);
    expect(await app.controls.listTerminals()).toEqual(original);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
const tab = (page, id) => page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
const picker = page => page.locator('#terminal-session-button');
const list = page => page.locator('#terminal-switch-list');
const visibleChoices = parent => parent.locator('[data-terminal-choice]:visible').evaluateAll(buttons => buttons.map(button => button.dataset.terminalChoice));
async function choose(page, id) {
  if (await tab(page, id).isVisible()) await tab(page, id).click();
  else { await picker(page).click(); await list(page).locator(`[data-terminal-choice=${id}]`).click(); }
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
async function fitted(page) {
  return page.locator('#terminal-tabs').evaluate(tabs => {
    const viewport = tabs.getBoundingClientRect();
    return [...tabs.children].filter(item => !item.hidden).every(item => {
      const box = item.getBoundingClientRect();
      return box.left >= viewport.left - 1 && box.right <= viewport.right + 1;
    }) && tabs.scrollLeft === 0 && tabs.scrollWidth <= tabs.clientWidth + 1;
  });
}

test('desktop keeps the tabs that fit and lists only the remaining entries in More', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop responsive layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  const app = await setup(page, 8);
  try {
    const original = await app.controls.listTerminals(), connections = app.terminalConnections;
    const ids = original.terminals.map(item => item.id).concat('new');
    let previousVisible = 0;
    for (const width of [1024, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(picker(page)).toBeVisible(); await expect(tab(page, 'main')).toBeVisible();
      await expect(tab(page, 'aux7')).toBeHidden(); await expect.poll(() => fitted(page)).toBe(true);
      const visible = await visibleChoices(page.locator('#terminal-tabs'));
      expect(visible).toEqual(ids.slice(0, visible.length)); expect(visible.length).toBeGreaterThanOrEqual(previousVisible);
      expect(visible.length).toBeGreaterThan(0); expect(visible.length).toBeLessThan(ids.length); previousVisible = visible.length;
      await picker(page).click(); await expect(page.locator('#terminal-switch-title')).toHaveText('更多终端');
      // Opening the modal can change toolbar geometry. Read both groups in
      // one browser task so the partition belongs to the same layout.
      await expect.poll(() => page.locator('#terminal-tabs [data-terminal-choice], #terminal-switch-list [data-terminal-choice]').evaluateAll(buttons =>
        buttons.filter(button => button.getClientRects().length).map(button => button.dataset.terminalChoice))).toEqual(ids);
      await expect(list(page).locator('[data-terminal-choice=main]')).toBeHidden();
      await expect(list(page).locator('[data-terminal-actions=aux7]')).toBeVisible();
      await expect(list(page).locator('[data-terminal-choice=new]')).toBeDisabled();
      await page.locator('#close-terminal-switch').click(); await expect(picker(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    expect(app.terminalConnections).toBe(connections); expect(await app.controls.listTerminals()).toEqual(original);
    await choose(page, 'aux7'); await expect(page.locator('#input-terminal')).toHaveValue('aux7');
    await expect(picker(page)).toHaveText('辅助终端 7 的任务 ▾'); await expect(picker(page)).toHaveAttribute('data-active', 'true');
    expect(await picker(page).evaluate(button => {
      const arrow = button.lastElementChild.getBoundingClientRect(), box = button.getBoundingClientRect();
      return arrow.width > 0 && arrow.left >= box.left && arrow.right <= box.right;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath('terminal-overflow.png') });
    await tab(page, 'main').focus(); await page.keyboard.press('End');
    const visible = await visibleChoices(page.locator('#terminal-tabs'));
    await expect(tab(page, visible.at(-1))).toBeFocused(); await page.keyboard.press('ArrowRight'); await expect(tab(page, 'main')).toBeFocused();
    await picker(page).focus(); await page.setViewportSize({ width: 1920, height: 900 });
    await expect(picker(page)).toBeHidden(); await expect(tab(page, 'aux7')).toBeVisible(); await expect(tab(page, 'aux7')).toBeFocused();
    expect(await visibleChoices(page.locator('#terminal-tabs'))).toEqual(ids); expect(await fitted(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(picker(page)).toBeFocused();
    await choose(page, 'main'); await expect(picker(page)).toHaveAttribute('data-active', 'false'); await expect(picker(page)).toContainText('更多终端');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('new and close actions remain reachable through partial desktop overflow as the catalog changes', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop responsive layout');
  await page.setViewportSize({ width: 1100, height: 800 });
  const app = await setup(page, 5);
  try {
    await expect(tab(page, 'new')).toBeVisible(); await expect(picker(page)).toBeHidden();
    for (const id of ['aux5', 'aux6', 'aux7']) {
      await choose(page, 'new'); await expect(page.locator('#input-terminal')).toHaveValue(id);
      await expect(picker(page)).toBeVisible(); await expect(tab(page, 'main')).toBeVisible(); await expect(tab(page, id)).toBeHidden();
      await expect(picker(page)).toHaveText(`${(await app.controls.listTerminals()).terminals.find(item => item.id === id).name} ▾`);
      expect(await fitted(page)).toBe(true);
    }
    await picker(page).click(); await expect(list(page).locator('[data-terminal-choice][data-available=true]:visible')).toHaveCount(1);
    await expect(list(page).locator('[data-terminal-choice=new]')).toBeDisabled();
    await list(page).locator('[data-terminal-actions=aux7]').click();
    await page.locator('#terminal-action-end').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.locator('#cancel-confirmation').click();
    expect((await app.controls.listTerminals()).terminals).toHaveLength(8);
    await picker(page).click();
    await list(page).locator('[data-terminal-actions=aux7]').click(); await page.locator('#terminal-action-end').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#input-terminal')).toHaveValue('new'); await expect(page.locator('#overlay-title')).toHaveText('已关闭');
    await expect(list(page).locator('[data-terminal-choice=aux7]')).toHaveCount(0);
    await picker(page).click();
    await list(page).locator('[data-terminal-choice=new]').click(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#input-terminal')).toHaveValue('aux7');
    expect((await app.controls.listTerminals()).terminals).toHaveLength(8);
    await page.locator('#terminal-tabs [data-terminal-actions=main]').click();
    await page.locator('#terminal-action-end').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.locator('#cancel-confirmation').click();
    expect((await app.controls.listTerminals()).terminals).toHaveLength(8);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('an open terminal list adapts between partial desktop overflow and the full mobile picker', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop responsive layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  const app = await setup(page, 8);
  try {
    const ids = (await app.controls.listTerminals()).terminals.map(item => item.id).concat('new');
    await picker(page).click(); await list(page).locator('[data-terminal-choice=aux7]').focus();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.locator('#terminal-switch-title')).toHaveText('选择终端'); expect(await visibleChoices(list(page))).toEqual(ids);
    await list(page).locator('[data-terminal-choice=main]').focus();
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(page.locator('#terminal-switch-title')).toHaveText('更多终端');
    await expect(list(page).locator('[data-terminal-choice=main]')).toBeHidden();
    expect(await page.evaluate(() => !!document.activeElement.closest('#terminal-switch-list .terminal-choice-row:not([hidden])'))).toBe(true);
    await page.setViewportSize({ width: 1920, height: 900 }); await expect(page.locator('#terminal-switch-dialog')).toBeHidden();
    await expect(tab(page, 'main')).toBeFocused();
    await page.setViewportSize({ width: 320, height: 800 }); await picker(page).click();
    expect(await visibleChoices(list(page))).toEqual(ids); await page.locator('#close-terminal-switch').click();
    await page.locator('#terminal-session-actions').focus(); await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator('#terminal-tabs [data-terminal-actions=main]')).toBeFocused();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('recovery can open the full chooser even when every desktop tab fits', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop recovery chooser');
  const app = await setup(page, 2);
  try {
    let intercepted = 0;
    await page.route('**/api/terminals', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), data = await response.json();
      data.terminals = data.terminals.map(item => item.id === 'main' ? { ...item, token: '%9999:99999' } : item);
      await route.fulfill({ response, json: data });
      intercepted++;
    });
    await page.reload(); await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(page.locator('#overlay-title')).toHaveText('请选择终端');
    await page.locator('#choose-terminal-button').click();
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#terminal-switch-dialog')).toBeVisible();
    expect(await visibleChoices(list(page))).toEqual(['main', 'aux1', 'new']);
    await list(page).locator('[data-terminal-choice=aux1]').click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
