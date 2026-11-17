import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
async function setup(page, options = {}) {
  const app = await fixture({ mode: 'terminal', ...options });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click(); return app;
}

test('upload waits for its final confirmation, can be canceled, and never replays committed bytes', async ({ page }, info) => {
  const app = await setup(page); let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/files/')) writes++; });
  try {
    await page.route('**/api/file-progress/*', route => route.fulfill({ json: { loaded: 32768, total: 65536 } }));
    await page.evaluate(() => {
      const original = fetch; window.fetch = async (...args) => {
        const response = await original(...args);
        if (args[1]?.method === 'PUT') {
          await new Promise(resolve => { window.releaseUploadResponse = resolve; args[1].signal.addEventListener('abort', resolve, { once: true }); });
          if (args[1].signal.aborted) throw new DOMException('canceled', 'AbortError');
        }
        return response;
      };
    });
    await page.locator('#upload-input').setInputFiles({ name: 'confirm.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(65536, 91) });
    await expect.poll(() => app.files.has('confirm.bin')).toBe(true);
    await expect(page.locator('#file-progress')).toBeVisible(); await expect(page.locator('#upload-status')).not.toContainText('上传完成');
    await expect(page.locator('#file-progress-meter')).toHaveAttribute('value', '50');
    await expect(page.locator('#file-progress-detail')).toContainText('32.0 KiB / 64.0 KiB');
    await expect(page.locator('#cancel-file-transfer')).toBeInViewport(); await page.screenshot({ path: info.outputPath('upload-progress.png') });
    await page.locator('#cancel-file-transfer').click(); await expect(page.locator('#upload-status')).toContainText('结果未知');
    await expect(page.locator('#upload-input')).toBeEnabled(); await expect(page.locator('#cancel-file-transfer')).toBeHidden();
    expect(writes).toBe(1); expect(app.files.get('confirm.bin').length).toBe(65536); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('download reports received bytes, cancels without saving partial content, and allows a new manual download', async ({ page }) => {
  const app = await setup(page); app.files.set('download.bin', Buffer.alloc(65536, 73)); let downloads = 0;
  page.on('download', () => downloads++);
  try {
    await page.locator('#refresh-files').click();
    await page.evaluate(() => {
      const original = fetch; let first = true;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (first && String(args[0]).includes('/api/files/') && [undefined, 'GET'].includes(args[1]?.method)) {
          first = false; const bytes = new Uint8Array(await response.arrayBuffer());
          const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 32768)); window.releaseDownload = () => { controller.enqueue(bytes.slice(32768)); controller.close(); }; }, cancel() { window.downloadReaderCanceled = true; } });
          return new Response(stream, { status: 200, headers: response.headers });
        }
        return response;
      };
    });
    await page.locator('.file-row a').click();
    await expect(page.locator('#file-progress-meter')).toHaveAttribute('value', '50');
    await expect(page.locator('#file-progress-detail')).toContainText('32.0 KiB / 64.0 KiB');
    await page.locator('#cancel-file-transfer').click(); await expect(page.locator('#upload-status')).toContainText('下载已中断');
    expect(await page.evaluate(() => window.downloadReaderCanceled)).toBe(true); expect(downloads).toBe(0);
    const download = page.waitForEvent('download'); await page.locator('.file-row a').click();
    expect((await download).suggestedFilename()).toBe('download.bin');
    await expect(page.locator('#file-progress-meter')).toHaveAttribute('value', '100'); expect(downloads).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('an HTTPS upload cut halfway retains its byte count, records HTTP status and never retries the body', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', networkDebug: true }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.uploadDebugLog = value; } } });
  });
  const app = await setup(page); let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/file-progress/*', route => route.fulfill({ json: { loaded: 1572864, total: 3145728 } }));
    await page.route('**/api/files/**', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++; await gate; await route.fulfill({ status: 524, contentType: 'text/html', body: 'PRIVATE_UPSTREAM_RESPONSE' }).catch(() => {});
    });
    await page.locator('#upload-input').setInputFiles({ name: 'PRIVATE_FILENAME.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3145728, 91) });
    await expect(page.locator('#file-progress-meter')).toHaveAttribute('value', '50'); release();
    await expect(page.locator('#upload-status')).toContainText('524');
    await expect(page.locator('#file-progress-detail')).toContainText('HTTPS · 1.5 MiB / 3.0 MiB');
    await expect(page.locator('#upload-input')).toBeEnabled();
    await page.locator('#close-files').click(); await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click(); await page.locator('#copy-connection-trace').click();
    const log = await page.evaluate(() => window.uploadDebugLog), event = JSON.parse(log).events.findLast(value => value.type === 'file-ended');
    expect(event).toMatchObject({ route: 'https', loadedBytes: 1572864, totalBytes: 3145728, status: 524, reason: 'http-status', outcome: 'unknown' });
    expect(log).not.toContain('PRIVATE_'); expect(writes).toBe(1); expect(app.files.has('PRIVATE_FILENAME.bin')).toBe(false);
  } finally { release(); await app.close(); }
});

test('the upload deadline identifies its cause rather than reporting an unexplained interruption', async ({ page }) => {
  const app = await setup(page); let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.clock.install();
    await page.route('**/api/files/**', async route => { if (route.request().method() !== 'PUT') return route.continue(); writes++; await gate; await route.abort().catch(() => {}); });
    await page.locator('#upload-input').setInputFiles({ name: 'deadline.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3145728) });
    await expect.poll(() => writes).toBe(1); await page.clock.fastForward(300001);
    await expect(page.locator('#upload-status')).toContainText('上传超过五分钟，结果未知');
    await expect(page.locator('#upload-input')).toBeEnabled(); expect(writes).toBe(1); expect(app.files.size).toBe(0);
  } finally { release(); await app.close(); }
});

test('an explicit busy upload is reported as rejected and its copied log distinguishes contention from an unknown outcome', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', networkDebug: true }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.uploadDebugLog = value; } } });
  });
  const app = await setup(page); let puts = 0;
  try {
    await page.route('**/api/files/**', route => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts++; return route.fulfill({ status: 409, json: { error: '正在上传其他文件，请稍后重试', fileCode: 'file_busy', outcome: 'rejected' } });
    });
    await page.locator('#upload-input').setInputFiles({ name: 'busy.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3145728) });
    await expect(page.locator('#file-progress-detail')).toContainText('本次上传已拒绝，未保存文件');
    await expect(page.locator('#file-progress-detail')).not.toContainText('未知'); await expect(page.locator('#upload-input')).toBeEnabled();
    await page.locator('#close-files').click(); await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click(); await page.locator('#copy-connection-trace').click();
    const log = JSON.parse(await page.evaluate(() => window.uploadDebugLog)), event = log.events.findLast(value => value.type === 'file-ended');
    expect(event).toMatchObject({ status: 409, reason: 'file_busy', outcome: 'rejected' }); expect(puts).toBe(1); expect(app.files.size).toBe(0);
  } finally { await app.close(); }
});

test('an HTTPS upload keeps its actual route label when a file direct channel becomes ready in the meantime', async ({ page }) => {
  let releaseSignal, releaseUpload, puts = 0;
  const signalGate = new Promise(resolve => { releaseSignal = resolve; }), uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) { const channel = create.apply(this, args); if (args[0] === 'codex-files') channel.addEventListener('open', () => { window.fileDirectOpened = true; }); return channel; };
  });
  await page.route('**/api/service/rtc', async route => { await signalGate; await route.continue().catch(() => {}); });
  await page.route('**/api/files/**', async route => { if (route.request().method() === 'PUT') { puts++; await uploadGate; } await route.continue().catch(() => {}); });
  const app = await setup(page, { webrtc: true });
  try {
    await page.locator('#upload-input').setInputFiles({ name: 'fixed-route.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3145728) });
    await expect(page.locator('#file-transport')).toHaveText('文件内容：HTTPS（本次传输）'); releaseSignal();
    await expect.poll(() => page.evaluate(() => window.fileDirectOpened), { timeout: 15000 }).toBe(true);
    await expect(page.locator('#file-transport')).toHaveText('文件内容：HTTPS（本次传输）');
    releaseUpload(); await expect(page.locator('#upload-status')).toContainText('上传完成');
    await expect(page.locator('#file-transport')).toContainText('下次传输可用'); expect(puts).toBe(1); expect(app.files.get('fixed-route.bin').length).toBe(3145728);
  } finally { releaseSignal(); releaseUpload(); await app.close(); }
});
