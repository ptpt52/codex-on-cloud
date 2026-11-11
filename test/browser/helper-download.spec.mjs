import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../fixture.mjs';
import { FORWARD_CLIENTS } from '../../panel/public/forward-platform.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function published(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-helper-browser-'));
  let app;
  try {
    app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, fastConnect: true, seamless: true, ...options, forwardDownloadDir: directory });
    const generation = 'd'.repeat(32), release = join(directory, 'releases', generation), bytes = Buffer.alloc(1024 * 1024, 173), files = [];
    await mkdir(release, { recursive: true });
    for (const [arch, client] of Object.entries(FORWARD_CLIENTS)) {
      // Synthetic bytes test delivery and integrity; these are not executables.
      const body = arch === 'windows-amd64' ? bytes : Buffer.from('synthetic package ' + arch);
      await writeFile(join(release, client.name), body);
      files.push({ arch, name: client.name, size: body.length, sha256: hash(body), build: 'browser-test' });
    }
    const base = app.config.entryBasePath || '/';
    await writeFile(join(release, 'manifest.json'), JSON.stringify({ version: 2, generation, server: app.config.origin + (base === '/' ? '' : base), files }));
    await writeFile(join(directory, 'current.json'), JSON.stringify({ version: 1, generation }));
    return { app, bytes, release, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await app?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
async function login(page, app, username) {
  await page.goto(app.config.origin + (app.config.entryBasePath || '/'));
  if (username) await page.locator('#username').fill(username);
  await page.locator('#password').fill(username ? 'temporary-test-password' : app.config.password);
  await page.locator('#login-button').click();
  await expect(page.locator('#workspace-view')).toBeVisible();
  await page.locator('#forward-button').click();
  await expect(page.locator('.forward-download')).toHaveCount(4);
}
async function readDownload(download) {
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const helperLink = page => page.locator('.forward-download[data-arch="windows-amd64"] a');

test('published helper bytes use an independent WebRTC file channel while the direct desktop remains connected', async ({ page }) => {
  const item = await published(), { app } = item; let httpBodies = 0;
  try {
    await page.route('**/api/forward/download/**', route => { httpBodies++; return route.abort(); });
    await login(page, app);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await expect(page.locator('#forward-download-status')).toContainText('WebRTC 加密通道已就绪', { timeout: 15000 });
    const waiting = page.waitForEvent('download'); await helperLink(page).click(); const download = await waiting;
    expect(download.suggestedFilename()).toBe(FORWARD_CLIENTS['windows-amd64'].name);
    expect(hash(await readDownload(download))).toBe(hash(item.bytes));
    await expect(page.locator('#forward-download-status')).toContainText('SHA256 校验通过');
    await page.locator('#forward-close').click();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(httpBodies).toBe(0); expect(app.vncConnections).toBe(1);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await item.close(); }
});

test('a temporary login downloads the exact published generation under its node path without claiming a terminal', async ({ page }) => {
  const item = await published({ mode: 'terminal', nodeId: 'a'.repeat(32), entryBasePath: '/node/a/' }), { app } = item; const escaped = []; let httpBodies = 0;
  try {
    await app.login(); await app.claim();
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
    page.on('request', request => { const url = new URL(request.url()); if (url.origin === app.config.origin && !url.pathname.startsWith('/node/a/')) escaped.push(url.pathname); });
    await page.route('**/api/forward/download/**', route => { httpBodies++; return route.abort(); });
    await login(page, app, 'visitor@node-a');
    await expect(page.locator('#forward-download-status')).toContainText('WebRTC 加密通道已就绪', { timeout: 15000 });
    const waiting = page.waitForEvent('download'); await helperLink(page).click();
    expect(hash(await readDownload(await waiting))).toBe(hash(item.bytes));
    expect(escaped).toEqual([]); expect(httpBodies).toBe(0);
    expect(app.vncConnections).toBe(0); expect(app.terminalConnections).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await item.close(); }
});

test('HTTPS downloads remain available when WebRTC is disabled', async ({ page }) => {
  const item = await published({ webrtc: false }), { app } = item; let httpBodies = 0;
  try {
    app.panel.server.on('request', request => { if (request.url.startsWith('/api/forward/download/')) httpBodies++; });
    await login(page, app);
    const waiting = page.waitForEvent('download'); await helperLink(page).click();
    expect(hash(await readDownload(await waiting))).toBe(hash(item.bytes));
    expect(httpBodies).toBe(1);
    await expect(page.locator('#forward-download-status')).toContainText('HTTPS');
  } finally { await item.close(); }
});

test('a failed helper hash offers no file and no automatic HTTP retry, then a manual retry can succeed', async ({ page }) => {
  const item = await published(), { app } = item; let saved = 0, httpBodies = 0;
  try {
    await writeFile(join(item.release, FORWARD_CLIENTS['windows-amd64'].name), Buffer.alloc(item.bytes.length, 42));
    page.on('download', () => saved++);
    await page.route('**/api/forward/download/**', route => { httpBodies++; return route.abort(); });
    await login(page, app);
    await expect(page.locator('#forward-download-status')).toContainText('WebRTC 加密通道已就绪', { timeout: 15000 });
    await helperLink(page).click(); await expect(page.locator('#forward-download-status')).toContainText('校验失败', { timeout: 15000 });
    expect(saved).toBe(0); expect(httpBodies).toBe(0);
    await writeFile(join(item.release, FORWARD_CLIENTS['windows-amd64'].name), item.bytes);
    const waiting = page.waitForEvent('download'); await helperLink(page).click();
    expect(hash(await readDownload(await waiting))).toBe(hash(item.bytes)); expect(saved).toBe(1); expect(httpBodies).toBe(0);
  } finally { await item.close(); }
});

test('a lost direct completion never retries over HTTPS or replaces the working desktop connection', async ({ page }) => {
  const item = await published(), { app } = item; let saved = 0, httpBodies = 0;
  try {
    await page.addInitScript(() => {
      const original = RTCDataChannel.prototype.addEventListener;
      RTCDataChannel.prototype.addEventListener = function(type, listener, options) {
        if (this.label === 'codex-files' && type === 'message') return original.call(this, type, event => {
          if (typeof event.data === 'string' && JSON.parse(event.data).type === 'done') { this.close(); return; }
          listener.call(this, event);
        }, options);
        return original.call(this, type, listener, options);
      };
    });
    page.on('download', () => saved++);
    await page.route('**/api/forward/download/**', route => { httpBodies++; return route.abort(); });
    await login(page, app);
    await expect(page.locator('#forward-download-status')).toContainText('WebRTC 加密通道已就绪', { timeout: 15000 });
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await helperLink(page).click(); await expect(page.locator('#forward-download-status')).toContainText('手动重试', { timeout: 15000 });
    await page.locator('#forward-close').click(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(saved).toBe(0); expect(httpBodies).toBe(0); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await item.close(); }
});
