import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openTools, openInput, closePanels } from './ui.mjs';

async function login(page, app, status = '在线') {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText(status);
}
async function manager(page) { await openTools(page); await page.locator('#terminals-button').click(); }

test('a full terminal manager keeps close, refresh and results reachable while its compact list scrolls', async ({ page }) => {
  test.setTimeout(60000);
  for (const mode of ['desktop', 'terminal']) {
    const app = await fixture({ mode, rfb: true, maxTerminals: 8 });
    try {
      for (let i = 1; i < 8; i++) await app.controls.manageTerminals({ action: 'create', name: i === 7 ? '检查较长名称换行且不挤压按钮的终端任务' : `任务 ${i}`, view: 'terminal' });
      await login(page, app);
      const connections = { vnc: app.vncConnections, terminal: app.terminalConnections };
      for (const viewport of [{ width: 320, height: 500 }, { width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 1440, height: 240 }]) {
        await page.setViewportSize(viewport); await manager(page);
        await expect(page.locator('#terminals-summary')).toHaveText('终端名额已满');
        await expect(page.locator('#terminals-status')).toContainText('共 8 / 8');
        await expect(page.locator('#create-terminal')).toBeDisabled(); await expect(page.locator('#new-terminal-name')).toBeDisabled();
        await expect(page.locator('#terminal-create-help')).toContainText('名额已满');
        await expect(page.locator('#terminal-list input:visible')).toHaveCount(0);
        const close = page.locator('#close-terminals'), before = await close.boundingBox();
        const end = page.locator('[data-terminal="aux7"] .terminal-close'); await end.focus(); await expect(end).toBeInViewport();
        for (const selector of ['#close-terminals', '#refresh-terminals', '#terminals-status']) await expect(page.locator(selector)).toBeInViewport();
        expect(await close.boundingBox()).toEqual(before);
        expect(await page.locator('#terminals-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.querySelector('.terminals-body').scrollWidth <= dialog.querySelector('.terminals-body').clientWidth + 1)).toBe(true);
        const buttons = await page.locator('[data-terminal="aux7"] button:visible').evaluateAll(elements => elements.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
        for (const button of buttons) { expect(button.width).toBeGreaterThanOrEqual(43.99); expect(button.height).toBeGreaterThanOrEqual(43.99); }
        await close.click(); await expect(page.locator('#terminals-dialog')).toBeHidden(); await closePanels(page);
      }
      expect({ vnc: app.vncConnections, terminal: app.terminalConnections }).toEqual(connections);
      expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    } finally { await app.close(); }
  }
});

test('an empty manager offers an explicit new shell and cancellation cannot recreate the ended terminal', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', rfb: true, maxTerminals: 1 });
  try {
    const original = (await app.controls.listTerminals()).terminals[0];
    await app.controls.manageTerminals({ action: 'close', terminalId: original.id, terminalToken: original.token, confirm: true });
    await login(page, app, '终端已关闭'); await manager(page);
    await expect(page.locator('#terminal-empty')).toBeVisible(); await expect(page.locator('#terminals-summary')).toHaveText('还可新建 1 个终端');
    await expect(page.locator('#create-terminal')).toBeEnabled(); await page.locator('#new-terminal-name').fill('新的工作'); await page.locator('#create-terminal').click();
    await expect(page.locator('#cancel-confirmation')).toBeFocused(); await page.keyboard.press('Enter');
    expect((await app.controls.listTerminals()).terminals).toEqual([]);
    await page.locator('#create-terminal').click(); await page.locator('#accept-confirmation').click();
    await expect(page.locator('#terminal-empty')).toBeHidden(); await expect(page.locator('#terminals-summary')).toHaveText('终端名额已满');
    const created = (await app.controls.listTerminals()).terminals;
    expect(created).toHaveLength(1); expect(created[0].token).not.toBe(original.token); expect(created[0].name).toBe('新的工作');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('terminal management accepts full Unicode names and blocks overlong names before submitting', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' });
  const valid = '任务' + '🧪'.repeat(22);
  try {
    await login(page, app); await manager(page);
    const create = page.locator('#new-terminal-name'), row = page.locator('[data-terminal=main]');
    await create.fill('x'.repeat(25)); await create.press('Enter');
    await expect(page.locator('#action-confirmation')).toBeHidden();
    expect(await create.evaluate(element => element.validationMessage)).toContain('1–24');
    await create.fill(valid); await expect(create).toHaveValue(valid); await create.press('Enter');
    await expect(page.locator('#action-confirmation')).toBeVisible();
    await page.locator('#cancel-confirmation').click();
    await row.getByRole('button', { name: '重命名' }).click();
    const field = row.locator('input');
    await field.fill('x'.repeat(25)); await field.press('Enter');
    expect(await field.evaluate(element => element.validationMessage)).toContain('1–24');
    await field.fill(valid); await expect(field).toHaveValue(valid); await field.press('Enter');
    await expect(row.locator('strong')).toHaveText(valid);
    expect((await app.controls.listTerminals()).terminals).toHaveLength(1);
    expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('inline rename cancels locally, protects IME Enter, and preserves the current terminal and draft', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', rfb: true, seamless: true }); const writes = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminals') writes.push(request.postDataJSON()); });
  try {
    await app.controls.manageTerminals({ action: 'create', name: '后台日志', view: 'terminal' });
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('当前终端草稿'); await closePanels(page);
    const original = await app.controls.listTerminals(), connections = app.terminalConnections;
    await manager(page);
    await expect(page.locator('[data-terminal="main"] .terminal-current')).toHaveText('当前终端');
    await expect(page.locator('[data-terminal="aux1"] .terminal-current')).toHaveCount(0);
    const row = page.locator('[data-terminal="aux1"]'), edit = row.getByRole('button', { name: '重命名' }), field = row.getByRole('textbox');
    await edit.click(); await expect(field).toBeFocused(); await expect(edit).toHaveAttribute('aria-expanded', 'true');
    await field.fill('尚未保存'); await field.press('Escape'); await expect(page.locator('#terminals-dialog')).toBeVisible(); await expect(edit).toBeFocused();
    await expect(field).toBeHidden(); expect(writes).toEqual([]);
    const refresh = page.locator('#refresh-terminals');
    await edit.click(); await expect(field).toHaveValue('后台日志');
    await app.controls.manageTerminals({ action: 'rename', terminalId: 'aux1', terminalToken: original.terminals[1].token, name: '后台日志已更新' });
    await refresh.click();
    await expect(edit).toHaveAttribute('aria-expanded', 'true');
    await expect(field).toHaveValue('后台日志已更新');
    await field.fill('诊断日志');
    await refresh.click(); await expect(refresh).toBeEnabled();
    await expect(edit).toHaveAttribute('aria-expanded', 'true'); await expect(field).toHaveValue('诊断日志');
    expect(writes).toEqual([]);
    await field.dispatchEvent('compositionstart', { data: '志' }); await field.press('Enter'); expect(writes).toEqual([]);
    await field.dispatchEvent('compositionend', { data: '志' }); await field.press('Enter');
    await expect(row.locator('strong')).toHaveText('诊断日志'); await expect(edit).toBeFocused(); await expect(field).toBeHidden();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ action: 'rename', terminalId: 'aux1', terminalToken: original.terminals[1].token, name: '诊断日志' });
    expect((await app.controls.listTerminals()).terminals[0]).toEqual(original.terminals[0]);
    await edit.click(); await field.fill('旧终端的未保存名称');
    await app.controls.manageTerminals({ action: 'close', terminalId: 'aux1', terminalToken: original.terminals[1].token, confirm: true });
    await app.controls.manageTerminals({ action: 'create', terminalId: 'aux1', name: '替换终端', view: 'terminal' });
    await refresh.click(); await expect(row.locator('strong')).toHaveText('替换终端');
    await expect(field).toBeHidden(); await edit.click(); await expect(field).toHaveValue('替换终端');
    expect(writes).toHaveLength(1);
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await page.locator('#close-terminals').click(); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('当前终端草稿');
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a rejected inline rename brings keyboard focus back to the editable name', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }), hold = Promise.withResolvers();
  let attempts = 0;
  try {
    await login(page, app); await manager(page);
    const original = (await app.controls.listTerminals()).terminals[0];
    await page.route('**/api/terminals', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (++attempts !== 1) return route.continue();
      await hold.promise;
      await route.fulfill({ status: 409, json: { outcome: 'rejected', error: '当前名称未保存，请调整后重试' } });
    });
    const row = page.locator('[data-terminal=main]'), field = row.getByRole('textbox');
    await row.getByRole('button', { name: '重命名' }).click();
    await field.fill('待保存名称');
    await field.press('Enter');
    await expect(field).toBeDisabled();
    hold.resolve();
    await expect(page.locator('#terminals-status')).toHaveText('当前名称未保存，请调整后重试');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('待保存名称');
    expect(attempts).toBe(1);
    expect((await app.controls.listTerminals()).terminals[0]).toEqual(original);
    await field.fill('确认后的名称');
    await field.press('Enter');
    await expect(row.locator('strong')).toHaveText('确认后的名称');
    expect(attempts).toBe(2);
    expect(app.terminalInputs).toEqual([]);
    expect(app.inputCalls).toEqual([]);
  } finally { hold.resolve(); await app.close(); }
});
