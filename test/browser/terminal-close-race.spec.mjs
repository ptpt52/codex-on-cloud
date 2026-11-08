import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';

async function setup(page) {
  const app = await fixture({ rfb: true, seamless: true });
  await page.addInitScript(() => {
    if (window === parent) {
      window.closeRaceConnections = [];
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', controlsCollapsed: true, terminalInputCollapsed: true }));
    } else if (location.pathname === '/terminal/index.html') {
      const Native = WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          if (new URL(this.url).pathname === '/session/connect' && parent.closeRaceConnections.length < 64) parent.closeRaceConnections.push(new URL(this.url).searchParams.get('terminalToken'));
        }
      };
    }
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  await openInput(page); await page.locator('#mobile-input').fill('旧终端草稿保留，不能发给新进程'); await closePanels(page);
  return app;
}
async function closeCurrent(page) {
  if (await page.locator('#terminal-session-button').isVisible()) await page.locator('#terminal-session-close').click();
  else await page.locator('#terminal-tabs [data-terminal-close=main]').click();
  await page.locator('#accept-confirmation').click();
}
async function chooseMain(page) {
  await closePanels(page);
  if (await page.locator('#terminal-session-button').isVisible()) {
    await page.locator('#terminal-session-button').click(); await page.locator('#terminal-switch-list [data-terminal-choice=main]').click();
  } else await page.locator('#terminal-tabs [data-terminal-choice=main]').click();
}

for (const replacement of [false, true]) test(`a rejected close rechecks a ${replacement ? 'replaced' : 'finished'} terminal before any viewer reconnects`, async ({ page }) => {
  const app = await setup(page); let closes = 0, reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const original = (await app.controls.listTerminals()).terminals[0];
    const attempts = await page.evaluate(() => window.closeRaceConnections.length);
    await page.route('**/api/terminals', async route => {
      const method = route.request().method(), body = method === 'POST' ? route.request().postDataJSON() : null;
      if (body?.action === 'close') {
        closes++;
        await app.controls.manageTerminals({ action: 'close', terminalId: original.id, terminalToken: original.token, confirm: true, view: 'terminal' });
        if (replacement) await app.controls.manageTerminals({ action: 'create', terminalId: 'main', name: '重建后的新进程', view: 'terminal' });
      }
      if (method === 'GET' && closes) { reads++; await gate; }
      await route.continue();
    });
    await closeCurrent(page); await expect.poll(() => reads).toBe(1);
    expect(await page.evaluate(() => window.closeRaceConnections.length)).toBe(attempts);
    await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    release();
    await expect(page.locator('#overlay-title')).toHaveText(replacement ? '请选择终端' : '已关闭');
    await expect(page.locator('#input-terminal')).toHaveValue(replacement ? 'stale' : 'new');
    expect(await page.evaluate(() => window.closeRaceConnections.length)).toBe(attempts);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('旧终端草稿保留，不能发给新进程'); await expect(page.locator('#paste-button')).toBeDisabled();
    expect(closes).toBe(1); expect(reads).toBe(1); expect(app.terminalInputs).toEqual([]);
    if (replacement) {
      const live = (await app.controls.listTerminals()).terminals[0]; expect(live.token).not.toBe(original.token);
      await chooseMain(page); await expect(page.locator('#connection-status')).toContainText('终端在线');
      await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
      expect(await page.evaluate(() => window.closeRaceConnections.at(-1))).toBe(live.token);
      expect(closes).toBe(1);
    }
  } finally { release(); await app.close(); }
});

test('a failed close recheck keeps the stale catalog unusable until an explicit refresh', async ({ page }) => {
  const app = await setup(page); let closes = 0, reads = 0;
  try {
    const original = (await app.controls.listTerminals()).terminals[0], attempts = await page.evaluate(() => window.closeRaceConnections.length);
    await page.route('**/api/terminals', async route => {
      const method = route.request().method();
      if (method === 'POST' && route.request().postDataJSON().action === 'close') {
        closes++; await app.controls.manageTerminals({ action: 'close', terminalId: original.id, terminalToken: original.token, confirm: true, view: 'terminal' });
      }
      if (method === 'GET' && closes && ++reads === 1) return route.abort('failed');
      await route.continue();
    });
    await closeCurrent(page); await expect(page.locator('#terminals-status')).toContainText('列表核对失败');
    await expect(page.locator('#overlay-title')).toHaveText('请选择终端');
    await expect(page.locator('#terminal-tabs [data-terminal-choice]')).toHaveCount(0);
    expect(await page.evaluate(() => window.closeRaceConnections.length)).toBe(attempts); expect(reads).toBe(1); expect(closes).toBe(1);
    await page.locator('#choose-terminal-button').click(); await page.locator('#terminal-switch-refresh').click();
    await expect(page.locator('#overlay-title')).toHaveText('已关闭'); expect(reads).toBe(2); expect(closes).toBe(1);
    expect(await page.evaluate(() => window.closeRaceConnections.length)).toBe(attempts); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a rejected close restores the original viewer only after a fresh matching identity is verified', async ({ page }) => {
  const app = await setup(page); let closes = 0, reads = 0;
  try {
    const original = (await app.controls.listTerminals()).terminals[0];
    await page.route('**/api/terminals', async route => {
      if (route.request().method() === 'POST') { closes++; return route.fulfill({ status: 409, json: { error: '输入仍在处理', outcome: 'rejected' } }); }
      if (closes) reads++; await route.continue();
    });
    await closeCurrent(page); await expect.poll(() => reads).toBe(1); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect((await app.controls.listTerminals()).terminals).toEqual([original]);
    expect(await page.evaluate(() => window.closeRaceConnections)).toEqual([original.token, original.token]);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('旧终端草稿保留，不能发给新进程');
    expect(closes).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a late close recheck cannot restore the viewer after another page takes control', async ({ page, context }) => {
  const app = await setup(page); let closes = 0, reads = 0, release, second;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const attempts = await page.evaluate(() => window.closeRaceConnections.length);
    await page.route('**/api/terminals', async route => {
      if (route.request().method() === 'POST') { closes++; return route.fulfill({ status: 409, json: { error: '输入仍在处理', outcome: 'rejected' } }); }
      if (closes) {
        const response = await route.fetch(); expect(response.status()).toBe(200); reads++; await gate;
        await route.fulfill({ response }).catch(() => {}); return;
      }
      await route.continue();
    });
    await closeCurrent(page); await expect.poll(() => reads).toBe(1);
    second = await context.newPage(); await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 });
    release(); await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    await expect(page.locator('#connection-status')).toContainText('等待接管');
    expect(await page.evaluate(() => window.closeRaceConnections.length)).toBe(attempts);
    expect(closes).toBe(1); expect(reads).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { release(); await second?.close(); await app.close(); }
});
