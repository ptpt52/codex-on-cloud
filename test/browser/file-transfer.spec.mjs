import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
async function setup(page) {
  const app = await fixture({ mode: 'terminal' });
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
