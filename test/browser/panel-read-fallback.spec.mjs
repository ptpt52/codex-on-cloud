import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
async function login(page, app, mode) {
  await page.addInitScript(mode => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, modeStandby: false }));
    else window.addEventListener('message', event => {
      if (!window.failPanelRead || event.data?.type !== 'codex-panel-request' || event.data.action !== 'state') return;
      event.stopImmediatePropagation(); window.failedPanelReads = (window.failedPanelReads || 0) + 1;
      parent.postMessage({ type: 'codex-panel-result', frame: event.data.frame, id: event.data.id, ok: false, error: window.failPanelRead }, location.origin);
    });
  }, mode);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
  return page.frames().find(frame => frame.url().includes(`/${mode}/index.html`));
}

for (const mode of ['desktop', 'terminal']) test(`${mode}: a failed stream state read falls back to authenticated HTTPS without replacing the viewer`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true }); let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/state') reads++; });
  try {
    const frame = await login(page, app, mode), before = reads, source = frame.url();
    await frame.evaluate(() => { window.failPanelRead = { status: 504, message: 'isolated state timeout', outcome: 'rejected' }; });
    await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(before);
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    await expect(page.locator('#diag-panel')).toContainText('HTTPS');
    expect(frame.url()).toBe(source); expect(app.vncConnections).toBe(mode === 'desktop' ? 1 : 0);
    expect(app.terminalConnections).toBe(mode === 'terminal' ? 1 : 0); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

for (const status of [401, 403, 423]) test(`stream read denial ${status} is never retried over HTTPS`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true }); let reads = 0, failed = false;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/state') reads++; });
  await page.exposeFunction('readDenied', () => { failed = true; });
  await page.addInitScript(() => { if (window === parent) window.addEventListener('message', event => { if (event.data?.type === 'codex-panel-result' && event.data.error?.message === 'isolated denial') void window.readDenied(); }); });
  try {
    const frame = await login(page, app, 'desktop'), before = reads;
    await frame.evaluate(status => { window.failPanelRead = { status, message: 'isolated denial', outcome: 'rejected' }; }, status);
    await expect.poll(() => failed, { timeout: 10000 }).toBe(true);
    if (status === 401) await expect(page.locator('#login-view')).toBeVisible();
    else await expect(page.locator('#connection-status')).toContainText('等待网络');
    expect(reads).toBe(before);
  } finally { await app.close(); }
});
