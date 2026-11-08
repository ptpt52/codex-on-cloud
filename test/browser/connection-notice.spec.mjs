import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';

async function login(page, app, { standby = false } = {}) {
  await page.addInitScript(standby => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', modeStandby: standby, controlsCollapsed: true, terminalInputCollapsed: true }));
  }, standby);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frame({ url: /\/terminal\/index.html/ });
}
async function warn(frame, reason = 'input-unknown', eventId = 'a'.repeat(32)) {
  await frame.evaluate(({ reason, eventId }) => parent.postMessage({ type: 'codex-stream-reset', frame: new URLSearchParams(location.search).get('frame'), reason, eventId }, location.origin), { reason, eventId });
}
async function switchMode(page, mode) {
  await closePanels(page); await page.locator(`#${mode}-mode`).click(); await page.locator('#accept-confirmation').click();
  await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
}

test('dismissed direct terminal warnings survive rerenders, new feedback and mode switches; new events still warn', async ({ page }, info) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    const frame = await login(page, app);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await warn(frame);
    await expect(page.locator('#connection-notice')).toContainText('网页终端');
    await expect(page.locator('#connection-notice')).toContainText('通道数据');
    const close = page.getByRole('button', { name: '关闭此提示', exact: true });
    const box = await close.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    if (info.project.use.hasTouch) await close.tap(); else { await close.focus(); await close.press('Enter'); }
    await expect(page.locator('#connection-notice')).toBeHidden();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await warn(frame); // Duplicate delivery must retain its dismissal.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('#connection-notice')).toBeHidden();
    await openInput(page); await page.locator('#paste-button').click(); // Local validation cannot acknowledge the old warning.
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'rejected');
    await closePanels(page);
    await switchMode(page, 'desktop'); await switchMode(page, 'terminal');
    await expect(page.locator('#connection-notice')).toBeHidden();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
    await warn(page.frame({ url: /\/terminal\/index.html/ }), 'input-pressure', 'b'.repeat(32));
    await expect(page.locator('#connection-notice')).toContainText('发送缓冲达到上限');
    await page.locator('#connection-button').click(); await page.locator('#input-notice-history > summary').click();
    await expect(page.locator('#input-notice-list')).toContainText('已收起');
    await expect(page.locator('#input-notice-list')).toContainText('终端协议消息');
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('assistant failures retain operation and target, and closing a polled historical result never resends or reopens it', async ({ page }) => {
  const app = await fixture({ rfb: true, inputHook: () => { throw Error('fixture execution failure'); } });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#connection-notice')).toContainText('输入助手');
    await expect(page.locator('#connection-notice')).toContainText('Enter');
    await expect(page.locator('#connection-notice')).toContainText('当前窗口');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'rejected');
    await switchMode(page, 'terminal'); await page.waitForTimeout(4500);
    await expect(page.locator('#connection-notice')).toBeHidden();
    await page.reload();
    await expect(page.locator('#connection-notice')).toContainText('桌面执行服务');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(4500); // Includes the normal state poll.
    await expect(page.locator('#connection-notice')).toBeHidden();
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a dismissed background desktop event keeps its source and stays closed when its frame becomes active', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await login(page, app, { standby: true });
    await expect(page.locator('#standby-frame')).toHaveAttribute('src', /\/desktop\/index.html/);
    const background = page.frames().find(frame => frame.url().includes('/desktop/index.html'));
    await warn(background, 'input-pressure');
    await expect(page.locator('#toast')).toContainText('后台桌面');
    await switchMode(page, 'desktop');
    await expect(page.locator('#connection-notice')).toContainText('后台桌面');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await switchMode(page, 'terminal'); await switchMode(page, 'desktop');
    await expect(page.locator('#connection-notice')).toBeHidden();
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('closing an offline episode leaves input blocked, and a new offline episode can warn again', async ({ page, context }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await login(page, app);
    await context.setOffline(true); await expect(page.locator('#connection-notice')).toContainText('网络已断开');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await expect(page.locator('#connection-notice')).toBeHidden();
    await warn(frame); // Closing offline status cannot silence a distinct input event.
    await expect(page.locator('#connection-notice')).toContainText('网页终端');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await expect(page.locator('#connection-notice')).toBeHidden();
    await openInput(page); await expect(page.locator('[data-key="Enter"]')).toBeDisabled();
    await closePanels(page); await context.setOffline(false); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await context.setOffline(true); await expect(page.locator('#connection-notice')).toContainText('网络已断开');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await context.setOffline(false); await app.close(); }
});

test('losing a protocol heartbeat reports channel data with an origin and stable event instead of claiming user input was lost', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    await page.addInitScript(() => {
      if (window === parent) window.noticeResets = [];
      window.addEventListener('message', event => {
        if (event.origin === location.origin && event.data?.type === 'codex-stream-reset') window.noticeResets.push(event.data);
      });
      if (location.pathname !== '/terminal/index.html') return;
      const Native = WebSocket; window.dropNoticeHealth = false;
      window.WebSocket = class extends Native {
        send(data) {
          const record = JSON.parse(data);
          if (new URL(this.url).pathname === '/session/connect' && record.type === 'input' && record.parts === 1 && window.dropNoticeHealth && JSON.parse(atob(record.data)).type === 'health') {
            window.dropNoticeHealth = false; Native.prototype.close.call(this); return;
          }
          super.send(data);
        }
      };
    });
    const frame = await login(page, app);
    await frame.evaluate(() => { window.dropNoticeHealth = true; window.dispatchEvent(new Event('online')); });
    await expect(page.locator('#connection-notice')).toContainText('通道数据结果未知', { timeout: 15000 });
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    const records = await page.evaluate(() => window.noticeResets);
    expect(records).toHaveLength(1); expect(records[0].eventId).toMatch(/^[a-f0-9]{32}$/); expect(records[0].path).toBe('relay');
    await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
    await page.locator('#connection-button').click(); await page.locator('#input-notice-history > summary').click();
    await expect(page.locator('#input-notice-list')).toContainText('终端协议消息');
    await expect(page.locator('#input-notice-list')).toContainText('HTTPS / WebSocket 中转');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
