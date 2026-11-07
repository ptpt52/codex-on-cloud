import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { portalFixture } from '../portal-fixture.mjs';
import { openInput, openTools } from './ui.mjs';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';

async function login(page, app) { await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); }
async function enroll(page, code, name) { await openTools(page); await page.locator('#portal-settings-button').click(); await expect(page.locator('#portal-register')).toBeEnabled(); await page.locator('#portal-node-name').fill(name); await page.locator('#portal-authorization-code').fill(code); await page.locator('#portal-register').click(); await expect(page.locator('#portal-config-status')).toContainText('注册已保存'); await expect(page.locator('#portal-authorization-code')).toHaveValue(''); await page.locator('#portal-settings-close').click(); await expect(page.locator('#servers-button')).toBeVisible(); }
async function socket(app, path, credential) {
  const ws = new WebSocket(app.config.origin.replace('http:', 'ws:') + path, 'codex-forward-v1', { headers: { origin: app.config.origin, authorization: 'Bearer ' + credential } });
  const records = []; ws.on('error', () => {}); ws.on('message', (data, binary) => { if (records.length > 128) throw Error('test record bound'); records.push(binary ? { binary, data: Buffer.from(data) } : { binary, data: JSON.parse(data.toString()) }); }); await once(ws, 'open'); return { ws, records };
}

test('node settings enroll with one code and switching preserves a live TCP relay, drafts and independent target login', async ({ page, context }, info) => {
  test.setTimeout(45000);
  const portal = await portalFixture({ listen: true }); await portal.login(); const code = await portal.code();
  const targetSockets = new Set(), echo = net.createServer(client => { targetSockets.add(client); client.on('error', () => {}); client.on('data', bytes => client.write(bytes)); client.once('close', () => targetSockets.delete(client)); });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const home = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, forwardPorts: [echo.address().port] }), work = await fixture({ rfb: true }); let control, stream;
  work.config.origin = work.config.origin.replace('127.0.0.1', 'localhost'); work.config.hosts.add(new URL(work.config.origin).host); home.config.portalFetch = work.config.portalFetch = portal.fetch;
  const posts = []; page.on('request', request => { if (request.method() !== 'GET') posts.push(new URL(request.url()).pathname); });
  try {
    await login(page, home); await enroll(page, code.code, 'home');
    await work.login(); await work.claim(); expect((await work.request('/api/portal/register', { method: 'POST', body: { name: 'work', authorizationCode: code.code } })).status).toBe(200);
    let directory = await (await portal.request('/api/nodes')).json();
    for (const item of directory.nodes) { const response = await portal.request('/api/nodes/' + item.id, { method: 'PUT', body: { revision: directory.revision, node: { ...item, enabled: true } } }); directory = await response.json(); }
    await openInput(page); await page.locator('#mobile-input').fill('只属于 home 的中文草稿');
    const mapping = await page.evaluate(async port => { const me = await (await fetch('/api/me')).json(), viewer = new URL(document.getElementById('desktop-frame').src).searchParams.get('viewer'); const response = await fetch('/api/forward', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf, 'x-viewer-id': viewer }, body: JSON.stringify({ localPort: 2222, targetPort: port }) }); return { ...(await response.json()), viewer }; }, echo.address().port);
    expect(mapping.code).toBeTruthy(); control = await socket(home, '/forward/helper', mapping.code); await expect.poll(() => control.records.length).toBe(1); const token = control.records[0].data.streamToken; control.ws.send('{"type":"listening"}'); await expect.poll(() => control.records.length).toBe(2);
    stream = await socket(home, '/forward/data', token); await expect.poll(() => stream.records.some(record => record.data.type === 'ready')).toBe(true);
    stream.ws.send(Buffer.from('before switch')); await expect.poll(() => stream.records.filter(record => record.binary).map(record => record.data.toString()).join('')).toBe('before switch');
    const workId = directory.nodes.find(item => item.name === 'work').id;
    await page.locator('#servers-button').click(); await expect(page.locator(`[data-node-id="${workId}"]`)).toBeEnabled(); await page.locator(`[data-node-id="${workId}"]`).click();
    await expect(page.locator('#servers-cancel')).toBeFocused(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(home.config.origin + '/');
    if (info.project.name === 'mobile') { await page.setViewportSize({ width: 320, height: 640 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await page.locator(`[data-node-id="${workId}"]`).click(); await page.locator('#servers-accept').click(); await expect(page).toHaveURL(work.config.origin + '/');
    await expect(page.locator('#login-view')).toBeVisible(); expect(posts).not.toContain('/api/logout');
    stream.ws.send(Buffer.from(' after switch')); await expect.poll(() => stream.records.filter(record => record.binary).map(record => record.data.toString()).join('')).toBe('before switch after switch'); expect(control.ws.readyState).toBe(WebSocket.OPEN);
    await page.locator('#password').fill(work.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    expect(home.inputCalls).toEqual([]); expect(work.inputCalls).toEqual([]); expect(home.managementStats.restarts).toBe(0); expect(work.managementStats.restarts).toBe(0);
    await page.goto(home.config.origin); await expect(page.locator('#connection-status')).toContainText('桌面在线'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('只属于 home 的中文草稿');
  } finally { stream?.ws.terminate(); control?.ws.terminate(); for (const socket of targetSockets) socket.destroy(); await new Promise(resolve => echo.close(resolve)); await home.close(); await work.close(); await portal.close(); }
});

test('a portal outage leaves the node session, desktop and file transfer available; bad codes do not log out the node', async ({ page }) => {
  const portal = await portalFixture({ listen: true }); await portal.login(); const code = await portal.code();
  const app = await fixture({ rfb: true }); app.config.portalFetch = portal.fetch;
  try {
    await login(page, app); await enroll(page, code.code, 'home');
    app.config.portalFetch = async () => { throw Error('test offline portal'); };
    await page.locator('#servers-button').click(); await expect(page.locator('#servers-status')).toContainText('独立使用'); await page.locator('#servers-close').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#files-button').click(); await page.locator('#upload-input').setInputFiles({ name: 'portal-offline.txt', mimeType: 'text/plain', buffer: Buffer.from('still independent') }); await expect(page.locator('#upload-status')).toContainText('上传完成'); await page.locator('#close-files').click();
    app.config.portalFetch = portal.fetch; await openTools(page); await page.locator('#portal-settings-button').click(); await expect(page.locator('#portal-register')).toBeEnabled();
    await page.locator('#portal-authorization-code').fill('bad-code'); await page.locator('#portal-register').click(); await expect(page.locator('#portal-config-status')).toContainText('完整'); await expect(page.locator('#workspace-view')).toBeVisible();
    expect(app.files.get('portal-offline.txt').toString()).toBe('still independent'); expect(app.vncConnections).toBe(1); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); await portal.close(); }
});
