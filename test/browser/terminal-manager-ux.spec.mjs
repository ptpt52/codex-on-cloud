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
    await edit.click(); await expect(field).toHaveValue('后台日志'); await field.fill('诊断日志');
    await field.dispatchEvent('compositionstart', { data: '志' }); await field.press('Enter'); expect(writes).toEqual([]);
    await field.dispatchEvent('compositionend', { data: '志' }); await field.press('Enter');
    await expect(row.locator('strong')).toHaveText('诊断日志'); await expect(edit).toBeFocused(); await expect(field).toBeHidden();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ action: 'rename', terminalId: 'aux1', terminalToken: original.terminals[1].token, name: '诊断日志' });
    expect((await app.controls.listTerminals()).terminals[0]).toEqual(original.terminals[0]);
    await expect(page.locator('#input-terminal')).toHaveValue('main');
    await page.locator('#close-terminals').click(); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('当前终端草稿');
    expect(app.terminalConnections).toBe(connections); expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
