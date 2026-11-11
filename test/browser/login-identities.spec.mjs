// Real HTTP authentication under one origin. Node processes and their desktop
// managers use fixtures; password-manager save dialogs are outside this test.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from '../fixture.mjs';
import { createSelfhostCenter } from '../../selfhost/center.mjs';

test.use({ serviceWorkers: 'block' });

test('one domain presents separate center and node login identities while retaining independent sessions', async ({ page, context }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-identities-'));
  const a = await fixture({ mode: 'terminal', nodeId: 'a'.repeat(32), entryBasePath: '/node/a/' });
  const b = await fixture({ mode: 'terminal', nodeId: 'b'.repeat(32), entryBasePath: '/node/b/', password: 'other_node_password_12345' });
  const sockets = new Set(), submitted = []; let center;
  const proxy = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://internal').pathname;
    const target = path.startsWith('/node/a/') ? a.config.origin : path.startsWith('/node/b/') ? b.config.origin : `http://127.0.0.1:${center.server.address().port}`;
    const upstream = http.request(new URL(req.url, target), { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.maxConnections = 32;
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (_req, socket) => socket.destroy()); // Audit login, not a native terminal connection.
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const password = 'center_password_very_long_123';
  try {
    center = await createSelfhostCenter({ origin, dataDir: directory, password, frpToken: 'frp_test_token_very_long_123' });
    center.server.listen(0, '127.0.0.1'); await once(center.server, 'listening');
    for (const node of [a, b]) node.config.hosts.add(new URL(origin).host);
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/login')) submitted.push(request.postDataJSON().username); });
    await page.goto(origin + '/admin/'); await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#username')).toHaveValue('admin@center');
    await expect(page.locator('#password')).toHaveAttribute('autocomplete', 'section-coc-center current-password');
    await page.screenshot({ path: testInfo.outputPath('center-login.png'), fullPage: true });
    await page.locator('#password').fill(password); await page.locator('#login-form button[type=submit]').click(); await expect(page.locator('#center-view')).toBeVisible();
    for (const [name, node] of [['a', a], ['b', b]]) {
      await page.goto(origin + '/node/' + name + '/'); await expect(page.locator('#login-view')).toBeVisible();
      await expect(page.locator('#username')).toHaveValue('admin@node-' + name);
      await expect(page.locator('#login-form')).toHaveAttribute('action', '/node/' + name + '/api/login');
      await expect(page.locator('#username')).toHaveAttribute('autocomplete', 'section-coc-node-' + name + ' username');
      if (name === 'a') await page.screenshot({ path: testInfo.outputPath('node-login.png'), fullPage: true });
      await page.locator('#password').fill(node.config.password); await page.locator('#login-button').click(); await expect(page.locator('#workspace-view')).toBeVisible();
    }
    expect(submitted).toEqual(['admin@center', 'admin@node-a', 'admin@node-b']);
    for (const [path, name] of [['/admin/', 'coc_session_center_admin'], ['/node/a/', 'coc_session_' + a.config.nodeId], ['/node/b/', 'coc_session_' + b.config.nodeId]]) {
      const cookies = await context.cookies(origin + path); expect(cookies.find(cookie => cookie.name === name)?.path).toBe(path);
    }
    await page.goto(origin + '/admin/'); await expect(page.locator('#center-view')).toBeVisible();
    await page.goto(origin + '/node/a/'); await expect(page.locator('#workspace-view')).toBeVisible();
    expect(submitted).toHaveLength(3); expect(a.inputCalls).toEqual([]); expect(b.inputCalls).toEqual([]);
    expect(a.managementStats.restarts + b.managementStats.restarts).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    await Promise.all([a.close(), b.close(), center?.close()]); await rm(directory, { recursive: true, force: true });
  }
});
