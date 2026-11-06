import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';

async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function login(page, app) { await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await page.locator('#forward-button').click(); }
async function reverseHelper(app, code) {
  const ws = new WebSocket(app.config.origin.replace('http', 'ws') + '/forward/helper', 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + code, 'x-codex-forward-resume': '1', 'x-codex-forward-reverse': '1' } });
  let ready; ws.on('error', () => {}); ws.on('message', bytes => { const value = JSON.parse(bytes); if (value.type === 'ready') ready = value; }); await once(ws, 'open'); return { ws, get ready() { return ready; } };
}

test('reverse device directory preserves drafts, waits for local consent, copies bounded connection metadata and confirms stop', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let helper;
  try {
    await page.addInitScript(() => { window.copiedConnections = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copiedConnections.push(text) } }); });
    await login(page, app); await page.locator('#forward-direction').selectOption('reverse');
    const port = await freePort();
    await page.locator('#forward-device-name').fill('家中路由器'); await page.locator('#forward-host').fill('192.168.1.1'); await page.locator('#forward-local').fill(String(port));
    await page.locator('#forward-device-save').click(); await expect(page.locator('#forward-device-list')).toContainText('家中路由器');
    await expect(page.locator('#forward-device-list')).toContainText('未接入'); await expect(page.locator('.forward-row')).toHaveCount(0);
    await page.locator('#forward-host').fill('192.168.1.2'); await page.locator('#forward-refresh').click(); await expect(page.locator('#forward-host')).toHaveValue('192.168.1.2');
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-status')).toContainText('资料有修改');
    await page.getByRole('button', { name: '选择设备', exact: true }).click(); await expect(page.locator('#forward-host')).toHaveValue('192.168.1.1');
    const request = page.waitForRequest(req => req.url().endsWith('/api/forward') && req.method() === 'POST'); await page.locator('#forward-create').click();
    const data = (await request).postDataJSON(); expect(data.direction).toBe('reverse'); expect(data.deviceId).toMatch(/^[a-f0-9]{32}$/);
    await expect(page.locator('#forward-code')).not.toHaveValue(''); helper = await reverseHelper(app, await page.locator('#forward-code').inputValue());
    await expect.poll(() => helper.ready?.deviceName).toBe('家中路由器'); await page.locator('#forward-refresh').click(); await expect(page.locator('.forward-row')).toContainText('等待本地助手确认');
    helper.ws.send('{"type":"listening"}'); await page.locator('#forward-refresh').click(); await expect(page.locator('.forward-row')).toContainText('已连接');
    await expect(page.locator('#forward-device-list')).toContainText('目标尚未验证');
    await page.getByRole('button', { name: '复制给 Codex', exact: true }).click();
    await expect(page.locator('#forward-status')).toContainText('连接信息已复制'); const copied = await page.evaluate(() => window.copiedConnections.at(-1));
    expect(copied).toContain('服务器入口：127.0.0.1:' + port); expect(copied).toContain('HostKeyAlias=codex-cloud-' + data.deviceId); expect(copied).toContain('192.168.1.1:22'); expect(copied).not.toContain(helper.ready.streamToken);
    await page.locator('#forward-connection-close').click(); await page.locator('.forward-row').getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('#forward-cancel-stop')).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('#forward-confirm')).toBeHidden(); expect(helper.ws.readyState).toBe(1);
    await page.locator('.forward-row').getByRole('button', { name: '停止', exact: true }).click(); await page.locator('#forward-accept-stop').click(); await expect(page.locator('.forward-row')).toHaveCount(0); await expect(page.locator('#forward-device-list')).toContainText('未接入');
    await page.reload(); await page.locator('#forward-button').click(); await page.locator('#forward-devices summary').click(); await expect(page.locator('#forward-device-list')).toContainText('家中路由器');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { helper?.ws.terminate(); await app.close(); }
});

test('device rename and delete preserve fixed authorizations, while manual connection copy and narrow layouts remain usable', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let helper;
  try {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('clipboard denied'); } } }));
    await login(page, app); await page.locator('#forward-direction').selectOption('reverse'); await page.locator('#forward-protocol').selectOption('telnet');
    const port = await freePort(); await page.locator('#forward-local').fill(String(port)); await page.locator('#forward-device-name').fill('交换机'); await page.locator('#forward-host').fill('[2001:0DB8::123]'); await expect(page.locator('#forward-target')).toHaveValue('23');
    await page.locator('#forward-device-save').click(); await expect(page.locator('#forward-device-list')).toContainText('交换机'); await page.locator('#forward-create').click(); await expect(page.locator('#forward-code')).not.toHaveValue('');
    helper = await reverseHelper(app, await page.locator('#forward-code').inputValue()); await expect.poll(() => helper.ready?.direction).toBe('reverse'); helper.ws.send('{"type":"listening"}');
    await page.locator('#forward-refresh').click(); await expect(page.locator('.forward-row')).toContainText('已连接');
    await page.getByRole('button', { name: '复制给 Codex', exact: true }).click(); await expect(page.locator('#forward-status')).toContainText('手动复制');
    await expect(page.locator('#forward-connection-copy')).toBeVisible(); await expect(page.locator('#forward-connection-text')).toHaveValue(new RegExp('telnet 127\\.0\\.0\\.1 ' + port));
    await page.locator('#forward-connection-copy').click(); await expect(page.locator('#forward-status')).toContainText('手动复制');
    expect(await page.locator('#forward-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('#forward-device-name').fill('新名称'); await page.locator('#forward-device-save').click(); await expect(page.locator('#forward-device-list')).toContainText('新名称'); await expect(page.locator('.forward-row strong')).toContainText('交换机');
    await page.getByRole('button', { name: '删除目录条目', exact: true }).click(); await expect(page.locator('#forward-cancel-stop')).toBeFocused(); await page.locator('#forward-accept-stop').click();
    await expect(page.locator('#forward-device-list')).not.toContainText('新名称'); await expect(page.locator('.forward-row')).toHaveCount(1); expect(helper.ws.readyState).toBe(1);
    await page.locator('.forward-row').getByRole('button', { name: '停止', exact: true }).click(); await page.locator('#forward-accept-stop').click(); await expect(page.locator('#forward-connection')).toBeHidden();
    expect(app.inputCalls).toEqual([]);
  } finally { helper?.ws.terminate(); await app.close(); }
});
