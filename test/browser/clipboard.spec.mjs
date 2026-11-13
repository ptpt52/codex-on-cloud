import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function login(page, app) {
  await page.goto(app.config.origin);
  await page.getByLabel('密码', { exact: true }).fill(app.config.password);
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');
}
async function open(page) {
  await openInput(page); await page.locator('#clipboard-button').click();
  await expect(page.locator('#clipboard-dialog')).toBeVisible();
}

test('remote text is read only on request, copied after preview and cleared when source or dialog changes', async ({ page }) => {
  const app = await fixture({ rfb: true });
  const text = '  中文😀\r\n</textarea><script>window.clipboardProbe=1</script>\n ';
  app.clipboardText.clipboard = text; app.clipboardText.primary = '远程选中文字';
  await page.addInitScript(() => {
    window.copiedValues = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copiedValues.push({ text, active: navigator.userActivation.isActive }) } });
  });
  try {
    await login(page, app);
    await openInput(page); await page.locator('#mobile-input').fill('保留原草稿');
    await open(page); expect(app.clipboardReads).toHaveLength(0);
    await expect(page.locator('#copy-clipboard')).toBeDisabled();
    await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(text.replaceAll('\r\n', '\n'));
    await expect(page.locator('#clipboard-meta')).toContainText(`${Buffer.byteLength(text)} 字节`);
    expect(await page.evaluate(() => window.clipboardProbe)).toBeUndefined();
    expect(await page.evaluate(() => window.copiedValues)).toEqual([]);
    await page.locator('#copy-clipboard').click();
    await expect(page.locator('#clipboard-status')).toContainText('已复制到本机');
    expect(await page.evaluate(() => window.copiedValues)).toEqual([{ text, active: true }]);
    await page.locator('#clipboard-source').selectOption('primary');
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    expect(app.clipboardReads).toEqual(['clipboard']);
    await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue('远程选中文字');
    await page.locator('#close-input-button').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await open(page); await expect(page.locator('#clipboard-preview')).toHaveValue('');
    expect(app.clipboardReads).toEqual(['clipboard', 'primary']);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('远程选中文字'))).toBe(false);
    await page.locator('#close-input-button').click();
    await expect(page.locator('#mobile-input')).toHaveValue('保留原草稿');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('桌面在线');
    expect(app.clipboardReads).toHaveLength(2); expect(app.inputCalls).toHaveLength(0);
  } finally { await app.close(); }
});

test('clipboard permission denial and missing browser API both provide manual selection', async ({ page }) => {
  const app = await fixture({ rfb: true }); app.clipboardText.clipboard = '手动复制😀\n第二行';
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('permission denied'); } } }));
  try {
    await login(page, app); await open(page); await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    for (let i = 0; i < 2; i++) {
      if (i) await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
      await page.locator('#copy-clipboard').click();
      await expect(page.locator('#clipboard-status')).toContainText('浏览器未允许自动复制');
      expect(await page.locator('#clipboard-preview').evaluate(area => [area.selectionStart, area.selectionEnd])).toEqual([0, app.clipboardText.clipboard.length]);
    }
    await page.locator('#select-clipboard').click();
    await expect(page.locator('#clipboard-status')).toContainText('使用系统的复制操作');
    expect(app.clipboardReads).toHaveLength(1);
  } finally { await app.close(); }
});

test('copy uses the browser clipboard with an explicit user gesture', async ({ page, context }) => {
  const app = await fixture({ rfb: true }); app.clipboardText.clipboard = '本机剪贴板验证\n中文😀';
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.config.origin });
    await login(page, app); await open(page); await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    await page.locator('#copy-clipboard').click();
    await expect(page.locator('#clipboard-status')).toContainText('已复制到本机');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(app.clipboardText.clipboard);
  } finally { await app.close(); }
});

test('late contents cannot repopulate a changed or closed preview', async ({ page }) => {
  let hold = gate();
  const app = await fixture({ rfb: true, clipboardHook: async () => hold.promise }); app.clipboardText.clipboard = '迟到内容';
  try {
    await login(page, app); await open(page); await page.locator('#read-clipboard').click();
    await expect.poll(() => app.clipboardReads.length).toBe(1);
    await page.locator('#clipboard-source').selectOption('primary');
    hold.release();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#read-clipboard')).toBeEnabled();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#copy-clipboard')).toBeDisabled();
    hold = gate(); app.clipboardText.primary = '关闭后不保留';
    await page.locator('#read-clipboard').click();
    await expect.poll(() => app.clipboardReads.length).toBe(2);
    await page.locator('#close-input-button').click(); hold.release();
    await expect.poll(() => app.controls.status().clipboardBusy).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#clipboard-button')).toBeEnabled();
    await open(page); await expect(page.locator('#clipboard-preview')).toHaveValue('');
    expect(app.clipboardReads).toHaveLength(2);
  } finally { hold.release(); await app.close(); }
});

test('takeover and framebuffer reconnect clear the preview without automatic reads', async ({ page, context }) => {
  const app = await fixture({ rfb: true }); app.clipboardText.clipboard = '不保留的远程文字';
  try {
    await login(page, app); await open(page); await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    app.disconnectViewers();
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 10000 });
    expect(app.clipboardReads).toHaveLength(1);
    await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-preview')).toHaveValue(app.clipboardText.clipboard);
    const second = await context.newPage(); await second.goto(app.config.origin);
    await expect(second.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#copy-clipboard')).toBeDisabled();
    expect(app.clipboardReads).toHaveLength(2); await second.close();
  } finally { await app.close(); }
});

test('empty, non-text, oversized and timed-out selections remain empty and require manual retry', async ({ page }) => {
  let mode = 0;
  const app = await fixture({ rfb: true, clipboardHook: () => { if (mode) throw Object.assign(new Error({ 404: '没有可读取的文字', 413: '文字超过 32 KiB', 504: '读取超时，请手动重试' }[mode]), { status: mode }); } });
  try {
    await login(page, app); await open(page);
    for (const [status, message] of [[0, '当前内容为空'], [404, '没有可读取'], [413, '超过 32 KiB'], [504, '读取超时']]) {
      mode = status; await page.locator('#read-clipboard').click();
      await expect(page.locator('#clipboard-status')).toContainText(message);
      await expect(page.locator('#copy-clipboard')).toBeDisabled();
      await expect(page.locator('#clipboard-preview')).toHaveValue('');
    }
    expect(app.clipboardReads).toHaveLength(4); expect(app.inputCalls).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await app.close(); }
});

test('a stalled clipboard response times out without retrying or exposing old text', async ({ page }) => {
  const app = await fixture({ rfb: true }), hold = gate(); let requests = 0;
  try {
    await login(page, app); await open(page);
    await page.route('**/api/clipboard/read', async route => { requests++; await hold.promise; await route.abort().catch(() => {}); });
    await page.locator('#read-clipboard').click();
    await expect(page.locator('#clipboard-status')).toContainText('读取超时', { timeout: 10000 });
    await expect(page.locator('#clipboard-preview')).toHaveValue('');
    await expect(page.locator('#copy-clipboard')).toBeDisabled();
    expect(requests).toBe(1); expect(app.clipboardReads).toHaveLength(0);
  } finally { hold.release(); await app.close(); }
});
