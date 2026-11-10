import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels, waitForTerminalLayout } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

// Actual HTTP/WSS through one origin. Selecting another upstream simulates a
// completed Tunnel/DNS cutover; terminal and management processes are fixtures.
async function setup(page, { webrtc = false } = {}) {
  const a = await fixture({ mode: 'terminal', nodeId: 'a'.repeat(32), sharedEntry: true, seamless: true, webrtc });
  const b = await fixture({ mode: 'terminal', nodeId: 'b'.repeat(32), sharedEntry: true, seamless: true, webrtc });
  let active = a;
  const sockets = new Set(), upgrades = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 262144 });
  const server = http.createServer((req, res) => {
    const upstream = http.request(new URL(req.url, active.config.origin), { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    const upstream = new WebSocket(new URL(req.url, active.config.origin.replace('http:', 'ws:')), { origin: req.headers.origin, headers: { cookie: req.headers.cookie || '', host: req.headers.host } });
    sockets.add(upstream); upstream.on('error', () => socket.destroy()); upstream.on('close', () => sockets.delete(upstream));
    upstream.once('unexpected-response', (_req, response) => { response.resume(); socket.end('HTTP/1.1 409 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); upstream.terminate(); });
    upstream.once('open', () => upgrades.handleUpgrade(req, socket, head, client => {
      sockets.add(client); client.on('message', (bytes, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary }); });
      upstream.on('message', (bytes, binary) => { if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary }); });
      client.on('error', () => upstream.terminate()); client.on('close', () => { sockets.delete(client); upstream.close(); }); upstream.on('close', () => client.close());
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const node of [a, b]) node.config.hosts.add(new URL(origin).host);
  const login = async target => {
    await target.goto(origin); if (await target.locator('#login-view').isVisible()) { await target.locator('#password').fill(a.config.password); await target.locator('#login-button').click(); }
    await expect(target.locator('#connection-status')).toContainText('终端在线');
  };
  await login(page);
  return { a, b, origin, login, select(node) { active = node; }, async close() {
    for (const socket of sockets) socket.terminate(); upgrades.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await a.close(); await b.close();
  } };
}

test('one fixed URL switches between independent node logins and identical pane identities without mixing drafts or restarting tasks', async ({ page, context }) => {
  const h = await setup(page);
  try {
    await expect(page.locator('#user-label')).toContainText('节点 aaaaaaaa');
    await openInput(page); await page.locator('#mobile-input').fill('A 的未提交草稿');
    const a = (await h.a.controls.listTerminals()).terminals, b = (await h.b.controls.listTerminals()).terminals;
    expect(a[0].token).toBe(b[0].token); // Deliberate cross-host pane/PID collision.
    h.select(h.b); await page.reload(); await expect(page.locator('#login-view')).toBeVisible();
    await page.locator('#password').fill(h.b.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#user-label')).toContainText('节点 bbbbbbbb'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('B 的未提交草稿');
    const cookies = await context.cookies(h.origin); expect(cookies.filter(cookie => cookie.name.startsWith('coc_session_'))).toHaveLength(2);
    h.select(h.a); await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('A 的未提交草稿');
    h.select(h.b); await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('B 的未提交草稿');
    expect(await h.a.controls.listTerminals()).toMatchObject({ terminals: a }); expect(await h.b.controls.listTerminals()).toMatchObject({ terminals: b });
    expect(h.a.terminalInputs).toEqual([]); expect(h.b.terminalInputs).toEqual([]); expect(h.a.managementStats.restarts + h.b.managementStats.restarts).toBe(0);
  } finally { await h.close(); }
});

test('a stale page cannot rename the newly selected node even when that node also has a valid cookie', async ({ page, context }) => {
  const h = await setup(page), other = await context.newPage();
  try {
    await openInput(page); await page.locator('#mobile-input').fill('仍属于 A'); await closePanels(page);
    // Keep the old page's read-only state on A while its next mutation reaches
    // B, as can occur during route propagation or retained direct reads.
    await page.route('**/api/state', async route => { const response = await route.fetch({ url: h.a.config.origin + '/api/state' }); await route.fulfill({ response }); });
    h.select(h.b); await h.login(other);
    await waitForTerminalLayout(page);
    const button = page.locator('#terminal-session-actions');
    if (await button.isVisible()) await button.click(); else await page.locator('#terminal-tabs [data-terminal-actions=main]').click();
    await page.locator('#terminal-action-rename').click(); await page.locator('#terminal-rename-name').fill('不能改到 B'); await page.locator('#terminal-rename-save').click();
    await expect(page.locator('#overlay-title')).toHaveText('入口已切换'); await expect(page.locator('#desktop-frame')).toHaveAttribute('src', 'about:blank');
    expect((await h.a.controls.listTerminals()).terminals[0].name).toBe('Codex 主终端'); expect((await h.b.controls.listTerminals()).terminals[0].name).toBe('Codex 主终端');
    expect(h.a.terminalInputs).toEqual([]); expect(h.b.terminalInputs).toEqual([]);
  } finally { await other.close(); await h.close(); }
});

test('shared-entry uploads and download links stay with their node, including a stale download after cutover', async ({ page, context }) => {
  const h = await setup(page);
  try {
    h.b.files.set('node.txt', Buffer.from('B content'));
    await page.locator('#files-button').click();
    await page.locator('#upload-input').setInputFiles({ name: 'node.txt', mimeType: 'text/plain', buffer: Buffer.from('A content') });
    await expect(page.locator('#upload-status')).toContainText('上传完成：node.txt');
    const link = page.locator('#file-list a[download="node.txt"]');
    await expect(link).toHaveAttribute('href', /node=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    const oldLink = await link.getAttribute('href');
    const first = await context.request.get(h.origin + oldLink);
    expect(first.status()).toBe(200); expect(await first.text()).toBe('A content');
    h.select(h.b); await page.reload(); await h.login(page); await page.locator('#files-button').click();
    await expect(link).toHaveAttribute('href', /node=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    const second = await context.request.get(h.origin + await link.getAttribute('href'));
    expect(second.status()).toBe(200); expect(await second.text()).toBe('B content');
    const stale = await context.request.get(h.origin + oldLink);
    expect(stale.status()).toBe(409); expect(await stale.json()).toMatchObject({ code: 'node_changed', outcome: 'rejected' });
    expect(h.a.files.get('node.txt').toString()).toBe('A content'); expect(h.b.files.get('node.txt').toString()).toBe('B content');
  } finally { await h.close(); }
});

test('scoped login supports both terminal and file WebRTC after switching the fixed entry', async ({ page }) => {
  const h = await setup(page, { webrtc: true }); let httpBodies = 0;
  try {
    await page.route('**/api/files/**', route => { httpBodies++; return route.abort(); });
    for (const [node, content] of [[h.a, 'direct A'], [h.b, 'direct B']]) {
      if (node === h.b) { h.select(node); await page.reload(); await h.login(page); }
      await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
      await page.locator('#files-button').click();
      await expect(page.locator('#file-transport')).toContainText('WebRTC', { timeout: 15000 });
      await page.locator('#upload-input').setInputFiles({ name: 'direct.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
      await expect(page.locator('#upload-status')).toContainText('上传完成：direct.txt');
      expect(node.files.get('direct.txt').toString()).toBe(content);
    }
    expect(h.a.files.get('direct.txt').toString()).toBe('direct A'); expect(h.b.files.get('direct.txt').toString()).toBe('direct B');
    expect(httpBodies).toBe(0); expect(h.a.terminalInputs).toEqual([]); expect(h.b.terminalInputs).toEqual([]);
  } finally { await h.close(); }
});
