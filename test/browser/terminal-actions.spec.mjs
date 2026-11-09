import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';

async function setup(page, count = 2) {
  const app = await fixture({ mode: 'terminal', maxTerminals: 8, rfb: true, seamless: true });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: `任务 ${n}`, view: 'terminal' });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return app;
}
const tab = (page, id) => page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
async function activate(button) { if (test.info().project.use.hasTouch) await button.tap(); else await button.click(); }
async function actions(page, id) {
  await closePanels(page);
  const button = page.locator(`#terminal-tabs [data-terminal-actions=${id}]`);
  if (await button.isVisible()) await activate(button);
  else if (await page.locator('#input-terminal').inputValue() === id && await page.locator('#terminal-session-actions').isVisible()) await activate(page.locator('#terminal-session-actions'));
  else {
    await activate(page.locator('#terminal-session-button'));
    await activate(page.locator(`#terminal-switch-list [data-terminal-actions=${id}]`));
  }
  await expect(page.locator('#terminal-action-menu')).toBeVisible();
}
async function edit(page, id) { await actions(page, id); await activate(page.locator('#terminal-action-rename')); await expect(page.locator('#terminal-rename-dialog')).toBeVisible(); }
const renamed = async (app, id) => (await app.controls.listTerminals()).terminals.find(item => item.id === id);

test('renaming a background terminal preserves selection, stream, identity and drafts and persists after reload', async ({ page }) => {
  const app = await setup(page); const writes = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') writes.push(request.postDataJSON()); });
  try {
    const original = await app.controls.listTerminals(), connections = app.terminalConnections;
    await openInput(page); await page.locator('#mobile-input').fill('主终端未提交的草稿');
    await page.frameLocator('#desktop-frame').locator('html').evaluate(el => { el.dataset.renameMarker = 'original-stream'; });
    await edit(page, 'aux1'); await expect(page.locator('#input-terminal')).toHaveValue('main');
    const field = page.locator('#terminal-rename-name'); await expect(field).toBeFocused();
    expect(await field.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, '任务 1'.length]);
    await field.fill('网络诊断任务'); await activate(page.locator('#terminal-rename-save'));
    await expect(page.locator('#terminal-rename-dialog')).toBeHidden(); await expect(tab(page, 'aux1')).toHaveText('网络诊断任务');
    await expect(page.locator('#terminal-switch-list [data-terminal-choice=aux1]')).toContainText('网络诊断任务');
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await expect(page.frameLocator('#desktop-frame').locator('html')).toHaveAttribute('data-rename-marker', 'original-stream');
    expect(app.terminalConnections).toBe(connections);
    expect((await renamed(app, 'aux1')).token).toBe(original.terminals[1].token);
    expect(await renamed(app, 'main')).toEqual(original.terminals[0]);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端未提交的草稿');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(tab(page, 'aux1')).toHaveText('网络诊断任务');
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ action: 'rename', terminalId: 'aux1', terminalToken: original.terminals[1].token, name: '网络诊断任务' });
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('rename validates names, requires explicit save, cancels safely and keeps IME Enter local', async ({ page }) => {
  const app = await setup(page); let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') writes++; });
  try {
    const original = await renamed(app, 'main');
    await edit(page, 'main'); await page.locator('#terminal-rename-name').fill('取消的名称'); await activate(page.locator('#terminal-rename-cancel'));
    expect(await renamed(app, 'main')).toEqual(original); expect(writes).toBe(0);
    await edit(page, 'main'); const field = page.locator('#terminal-rename-name');
    await field.fill('   '); await expect(page.locator('#terminal-rename-save')).toBeDisabled();
    await field.fill('x'.repeat(25)); await expect(page.locator('#terminal-rename-status')).toContainText('1–24'); await expect(page.locator('#terminal-rename-save')).toBeDisabled();
    await field.fill('中文终端 🧪'); await field.dispatchEvent('compositionstart', { data: '中' });
    await field.press('Enter'); expect(writes).toBe(0); await expect(page.locator('#terminal-rename-dialog')).toBeVisible();
    await field.dispatchEvent('compositionend', { data: '中' });
    await page.locator('#terminal-rename-help').click(); expect(writes).toBe(0);
    await field.focus(); await field.press('Enter'); await expect(page.locator('#terminal-rename-dialog')).toBeHidden();
    expect((await renamed(app, 'main')).name).toBe('中文终端 🧪'); expect(writes).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('desktop right click and keyboard context menu use the same actions without switching terminals', async ({ page }, info) => {
  test.skip(info.project.use.hasTouch || info.project.use.isMobile, 'Desktop context menu');
  const app = await setup(page);
  try {
    await tab(page, 'aux1').click({ button: 'right' }); await expect(page.locator('#terminal-action-menu')).toBeVisible();
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await page.keyboard.press('ArrowDown'); await expect(page.locator('#terminal-action-end')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(page.locator('#terminal-action-rename')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.locator('#terminal-action-menu')).toBeHidden();
    await tab(page, 'aux1').focus(); await page.keyboard.press('Shift+F10'); await expect(page.locator('#terminal-action-menu')).toBeVisible();
    await page.keyboard.press('Enter'); await expect(page.locator('#terminal-rename-dialog')).toBeVisible();
    await page.locator('#terminal-rename-name').fill('不会保存'); await page.keyboard.press('Escape');
    await expect(page.locator('#terminal-rename-dialog')).toBeHidden(); expect((await renamed(app, 'aux1')).name).toBe('任务 1');
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('an unknown save result is not retried and a later reload reads the actual saved name', async ({ page }) => {
  const app = await setup(page); let writes = 0;
  try {
    await page.route('**/api/terminals', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'rename') { writes++; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await edit(page, 'main'); await page.locator('#terminal-rename-name').fill('已保存但响应丢失'); await activate(page.locator('#terminal-rename-save'));
    await expect(page.locator('#terminal-rename-status')).toContainText('结果未知'); await expect(page.locator('#terminal-rename-save')).toBeDisabled();
    await page.locator('#terminal-rename-form').dispatchEvent('submit'); expect(writes).toBe(1);
    await activate(page.locator('#terminal-rename-cancel')); await page.unroute('**/api/terminals'); await page.reload();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(tab(page, 'main')).toHaveText('已保存但响应丢失');
    expect(writes).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a stale rename cannot change a replacement terminal in the same slot', async ({ page }) => {
  const app = await setup(page);
  try {
    const old = await renamed(app, 'aux1'); await edit(page, 'aux1');
    await app.controls.manageTerminals({ action: 'close', terminalId: old.id, terminalToken: old.token, confirm: true, view: 'terminal' });
    await app.controls.manageTerminals({ action: 'create', terminalId: old.id, name: '新进程的名称', view: 'terminal' });
    await page.locator('#terminal-rename-name').fill('旧弹窗不能覆盖'); await activate(page.locator('#terminal-rename-save'));
    await expect(page.locator('#terminal-rename-status')).not.toHaveText('正在保存…');
    await expect(page.locator('#terminal-rename-dialog')).toBeVisible();
    expect((await renamed(app, 'aux1')).name).toBe('新进程的名称'); expect((await renamed(app, 'aux1')).token).not.toBe(old.token);
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('takeover closes rename and a stale submit never queues a rename for the next owner', async ({ page, context }) => {
  const app = await setup(page);
  try {
    const original = await app.controls.listTerminals(); await edit(page, 'main'); await page.locator('#terminal-rename-name').fill('不能迟到执行');
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('终端在线');
      await expect(page.locator('#terminal-rename-dialog')).toBeHidden({ timeout: 10000 });
      await page.locator('#terminal-rename-form').dispatchEvent('submit'); expect(await app.controls.listTerminals()).toEqual(original);
      expect(app.terminalInputs).toEqual([]);
    } finally { await second.close(); }
  } finally { await app.close(); }
});

test('tablet touch can rename an overflow terminal with visible full-size actions', async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, 'Touch viewport');
  await page.setViewportSize({ width: 1024, height: 1366 });
  const app = await setup(page, 8);
  try {
    await edit(page, 'aux7'); await page.locator('#terminal-rename-name').fill('平板后台任务'); await activate(page.locator('#terminal-rename-save'));
    await expect(page.locator('#terminal-rename-dialog')).toBeHidden(); await expect(tab(page, 'aux7')).toHaveText('平板后台任务');
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await actions(page, 'aux7');
    for (const id of ['terminal-action-rename', 'terminal-action-end']) { const box = await page.locator('#' + id).boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); }
    const box = await page.locator('#terminal-action-menu').boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(1024);
    await page.screenshot({ path: info.outputPath('tablet-terminal-actions.png') });
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
