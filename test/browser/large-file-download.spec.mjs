import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'allow' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('sustained native saving remains alive beyond five minutes without extending file deadlines', async ({ page }) => {
  test.skip(process.env.FILE_LONG_DOWNLOAD_TEST !== '1', 'opt-in browser wall-clock lifecycle acceptance');
  test.setTimeout(360000); const app = await fixture();
  try {
    await page.goto(app.config.origin);
    const downloading = page.waitForEvent('download', { timeout: 20000 }), start = performance.now();
    const saving = page.evaluate(async () => {
      const { createDownloadSink } = await import('/file-download.js');
      const sink = await createDownloadSink('duration-proof.bin', 8 * 1024 * 1024);
      for (let index = 0; index < 32; index++) { await sink.write(new Uint8Array(262144).fill(73)); await new Promise(resolve => setTimeout(resolve, 9700)); }
      await sink.close();
    });
    const download = await downloading, stream = await download.createReadStream(), digest = createHash('sha256'); let received = 0;
    for await (const chunk of stream) { received += chunk.length; digest.update(chunk); }
    await saving; expect(received).toBe(8 * 1024 * 1024); expect(digest.digest('hex')).toBe(hash(Buffer.alloc(received, 73)));
    expect(performance.now() - start).toBeGreaterThan(300000);
    console.log(JSON.stringify({ kind: 'download-lifetime', seconds: Math.round((performance.now() - start) / 1000), bytes: received, hashVerified: true }));
  } finally { await app.close(); }
});

for (const entryBasePath of ['/', '/node/download-test/']) test(`the isolated download worker streams bytes within node path ${entryBasePath} without a Blob or server file body`, async ({ page }) => {
  const app = await fixture({ entryBasePath, ...(entryBasePath !== '/' ? { nodeId: 'a'.repeat(32) } : {}) }), escaped = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === app.config.origin && !url.pathname.startsWith(entryBasePath)) escaped.push(url.pathname); });
  try {
    await page.goto(app.config.origin + entryBasePath);
    const downloadEvent = page.waitForEvent('download');
    await page.evaluate(() => { const button = document.createElement('button'); button.id = 'save-proof'; button.textContent = 'save'; document.body.append(button); });
    await page.evaluate(() => { document.querySelector('#save-proof').onclick = () => { window.savingProof = (async () => {
      const { createDownloadSink } = await import('/file-download.js');
      const sink = await createDownloadSink('中文-download.bin', 2 * 1024 * 1024);
      const block = new Uint8Array(16380); block.fill(91); let left = 2 * 1024 * 1024;
      while (left) { const part = block.subarray(0, Math.min(block.length, left)); await sink.write(part); left -= part.length; }
      await sink.close();
      return { frames: document.querySelectorAll('iframe[title="文件下载"]').length };
    })(); }; });
    await page.locator('#save-proof').click();
    const saving = page.evaluate(() => window.savingProof);
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('中文-download.bin');
    const stream = await download.createReadStream();
    const parts = [];
    for await (const bytes of stream) parts.push(bytes);
    expect(hash(Buffer.concat(parts))).toBe(hash(Buffer.alloc(2 * 1024 * 1024, 91)));
    expect(await saving).toEqual({ frames: 1 });
    expect(app.inputCalls).toEqual([]); expect(escaped).toEqual([]);
  } finally { await app.close(); }
});

for (const cancelFromBrowser of [false, true]) test(`a large direct download canceled from ${cancelFromBrowser ? 'the browser' : 'the workbench'} stops once and preserves the service peer`, async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ webrtc: true, mode: 'terminal' }); app.files.set('large-cancel.bin', Buffer.alloc(60 * 1024 * 1024, 53)); let bodies = 0;
  await page.addInitScript(() => {
    const listen = RTCDataChannel.prototype.addEventListener;
    RTCDataChannel.prototype.addEventListener = function(type, callback, options) {
      if (this.label === 'codex-files' && type === 'message') return listen.call(this, type, event => { if (typeof event.data !== 'string') setTimeout(() => callback.call(this, event), 40); else callback.call(this, event); }, options);
      return listen.call(this, type, callback, options);
    };
  });
  try {
    await page.route('**/api/files/**', route => { bodies++; return route.abort(); });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click();
    await expect(page.locator('#file-transport')).toContainText('大文件下载最多 1 GiB', { timeout: 15000 });
    const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: '下载 large-cancel.bin', exact: true }).click();
    const download = await downloading;
    await expect.poll(() => page.locator('#file-progress-meter').getAttribute('value')).not.toBe('0');
    if (cancelFromBrowser) await download.cancel(); else await page.locator('#cancel-file-transfer').click();
    await expect(page.locator('#upload-status')).toContainText('下载已中断');
    // The workbench stops the source bytes. Browser-owned partial downloads
    // may still need the separate cleanup described in the on-screen notice;
    // Firefox does not always settle Download.failure until that cleanup.
    if (!cancelFromBrowser) await download.cancel();
    expect(await download.failure()).toBeTruthy();
    await expect(page.locator('#file-transport')).toContainText('大文件下载最多 1 GiB', { timeout: 10000 });
    await page.locator('#upload-input').setInputFiles({ name: 'after-cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('fresh manual operation') });
    await expect(page.locator('#upload-status')).toContainText('上传完成');
    expect(app.files.get('after-cancel.bin').toString()).toBe('fresh manual operation'); expect(bodies).toBe(0);
    expect(app.received.filter(row => row.method === 'GET' && row.url === '/files/large-cancel.bin')).toHaveLength(1);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('consecutive streamed saves reuse one inert frame without a cooldown or retained payload', async ({ page }) => {
  const app = await fixture();
  try {
    await page.goto(app.config.origin);
    for (let index = 0; index < 3; index++) {
      const downloading = page.waitForEvent('download');
      const saving = page.evaluate(async index => {
        const { createDownloadSink } = await import('/file-download.js');
        const sink = await createDownloadSink(`repeat-${index}.bin`, 262144);
        await sink.write(new Uint8Array(262144).fill(index)); await sink.close();
      }, index);
      const download = await downloading, stream = await download.createReadStream(); let count = 0;
      for await (const bytes of stream) { count += bytes.length; expect(bytes.every(byte => byte === index)).toBe(true); }
      await saving; expect(count).toBe(262144); expect(await page.locator('iframe[title="文件下载"]').count()).toBe(1);
    }
  } finally { await app.close(); }
});

test('140 MiB uses actual WebRTC and bounded native saving without browser HTTPS file bodies', async ({ page }) => {
  test.setTimeout(180000);
  const app = await fixture({ webrtc: true, mode: 'terminal' }), size = 140 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 37), expected = hash(bytes); app.files.set('large-140MiB.bin', bytes);
  let bodies = 0;
  try {
    await page.addInitScript(() => {
      const create = URL.createObjectURL;
      URL.createObjectURL = function(value) { if (value instanceof Blob && value.size > 50 * 1024 * 1024) throw Error('Large Blob allocation forbidden'); return create.call(this, value); };
    });
    await page.route('**/api/files/**', route => { bodies++; return route.abort(); });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await page.locator('#files-button').click();
    await expect(page.locator('#file-transport')).toContainText('大文件下载最多 1 GiB', { timeout: 15000 });
    const downloaded = page.waitForEvent('download'), start = performance.now();
    await page.getByRole('link', { name: '下载 large-140MiB.bin', exact: true }).click();
    const download = await downloaded, stream = await download.createReadStream(), digest = createHash('sha256'); let received = 0;
    for await (const chunk of stream) { received += chunk.length; digest.update(chunk); }
    expect(received).toBe(size); expect(digest.digest('hex')).toBe(expected);
    await expect(page.locator('#upload-status')).toContainText('下载完成'); expect(bodies).toBe(0);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
    console.log(JSON.stringify({ kind: 'large-download', bytes: size, MiBps: Math.round(size / 1048576 / ((performance.now() - start) / 1000) * 100) / 100, hashVerified: true, browserHTTPFileBodies: bodies }));
  } finally { await app.close(); }
});

test('large-file selection verifies its listed version and logs HTTPS handoff and explicit rejections', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ webrtc: true, mode: 'terminal' });
  const name = 'listed.bin', size = 51 * 1024 * 1024;
  app.files.set(name, Buffer.alloc(size, 11));
  app.files.set('removed.bin', Buffer.from('old'));
  try {
    await page.goto(app.config.origin);
    await page.locator('#password').fill(app.config.password);
    await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#connection-button').click();
    await page.locator('#connection-trace > summary').click();
    await page.locator('#connection-debug-toggle').check();
    await page.keyboard.press('Escape');
    await page.locator('#files-button').click();
    await expect(page.locator('#file-transport')).toContainText('大文件下载最多 1 GiB');
    const direct = filename => page.getByRole('link', { name: `下载 ${filename}`, exact: true });
    const fallback = page.getByRole('link', { name: `HTTPS 下载 ${name}`, exact: true });
    const events = () => page.evaluate(() => {
      const log = JSON.parse(sessionStorage.getItem('codex-cloud.network-log.v2') || '{"entries":[]}');
      return log.entries.flatMap(entry => entry.events);
    });
    await expect(fallback).toHaveAttribute('href', /[?&]version=[a-f0-9]{64}/);
    const downloading = page.waitForEvent('download');
    await fallback.click();
    expect(await (await downloading).failure()).toBeNull();
    app.files.delete('removed.bin');
    await direct('removed.bin').press('Enter');
    await expect(page.locator('#upload-status')).toContainText('文件不存在');
    await expect(page.locator('#file-transport')).toContainText('大文件下载最多 1 GiB', { timeout: 10000 });
    app.files.set(name, Buffer.alloc(size, 29));
    const pending = page.waitForEvent('download');
    await direct(name).press('Enter');
    const stale = await pending;
    await expect(page.locator('#upload-status')).toContainText('文件已变化');
    const downloads = async () => (await events()).filter(event => event.direction === 'download');
    await expect.poll(downloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'file-ended', route: 'direct', status: 412, loadedBytes: 0, reason: 'http-status', outcome: 'rejected' }),
      expect.objectContaining({ type: 'file-handoff', route: 'https', totalBytes: size }),
      expect.objectContaining({ type: 'file-ended', route: 'direct', status: 404, loadedBytes: 0, reason: 'http-status', outcome: 'rejected' }),
    ]));
    const handoff = (await downloads()).find(event => event.type === 'file-handoff');
    expect(handoff).not.toHaveProperty('outcome');
    expect(handoff).not.toHaveProperty('loadedBytes');
    expect(JSON.stringify(await downloads())).not.toContain(name);
    await stale.cancel();
  } finally { await app.close(); }
});
