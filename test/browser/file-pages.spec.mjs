import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
const metadata = /\/api\/files(?:\?.*)?$/;

test('1000 long filenames refresh over service RTC with one census and no HTTP fallback', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  const name = n => String(n).padStart(4, '0') + '-' + 'x'.repeat(180) + '.txt';
  for (let n = 0; n < 1000; n++) app.files.set(name(n), Buffer.from('kept'));
  let http = 0;
  try {
    await app.login(); await app.claim();
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
    await page.goto(app.config.origin); await page.locator('#username').fill('visitor'); await page.locator('#password').fill('temporary-test-password'); await page.locator('#login-button').click();
    await expect(page.locator('#user-label')).toContainText('临时访问'); await page.locator('#files-button').click();
    await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /, { timeout: 15000 });
    await expect(page.locator('.file-row')).toHaveCount(1000); await expect(page.locator('#file-list-status')).toBeEmpty();
    await page.route(metadata, route => { http++; return route.abort(); });
    const baseline = app.received.filter(req => req.url === '/files').length;
    await page.locator('#refresh-files').click(); await expect(page.locator('#file-list-status')).toBeEmpty();
    await expect(page.locator('.file-row')).toHaveCount(1000);
    expect(http).toBe(0); expect(app.received.filter(req => req.url === '/files').length - baseline).toBe(1);
    // The last page participates in collision handling; no bytes are sent until confirmation.
    await page.locator('#upload-input').setInputFiles({ name: name(999), mimeType: 'text/plain', buffer: Buffer.from('new') });
    await expect(page.locator('#file-conflict-dialog')).toBeVisible(); await page.locator('#file-conflict-cancel').click();
    expect(app.files.get(name(999)).toString()).toBe('kept'); expect(http).toBe(0);
    expect(app.received.filter(req => req.method === 'PUT')).toHaveLength(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('a failed later HTTP page keeps the displayed catalog intact and a legacy list remains readable', async ({ page }) => {
  const app = await fixture({ mode: 'terminal' }); let calls = 0, legacy = false;
  try {
    app.files.set('original.txt', Buffer.from('kept'));
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click();
    await expect(page.locator('.file-row')).toHaveCount(1); await expect(page.locator('.file-row')).toContainText('original.txt');
    for (let n = 0; n < 150; n++) app.files.set('later-' + n, Buffer.from('new'));
    await page.route(metadata, async route => {
      calls++;
      if (legacy) return route.fulfill({ json: { uploadProtocol: 1, files: [{ name: 'legacy.txt', size: 1 }] } });
      if (new URL(route.request().url()).searchParams.get('page') !== '1') return route.fulfill({ status: 503, json: { error: 'second page unavailable' } });
      return route.continue();
    });
    await page.locator('#refresh-files').click(); await expect(page.locator('#file-list-status')).toContainText('second page unavailable');
    expect(calls).toBe(2); await expect(page.locator('.file-row')).toHaveCount(1); await expect(page.locator('.file-row')).toContainText('original.txt');
    legacy = true; await page.locator('#refresh-files').click(); await expect(page.locator('.file-row')).toContainText('legacy.txt');
    expect(calls).toBe(3); expect(app.received.filter(req => req.method === 'PUT')).toHaveLength(0);
  } finally { await app.close(); }
});
