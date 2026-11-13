import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });

async function hints(page, probe = true) {
  await page.locator('#connection-button').click();
  await page.locator('.direct-hints summary').click();
  await page.locator('#direct-server-ip').fill('10.123.254.253');
  await page.locator(probe ? '#save-direct-hints' : '#save-direct-hints-only').click();
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
}

for (const mode of ['terminal', 'desktop']) for (const seamless of [true, false]) test(`healthy ${mode} ${seamless ? 'unified' : 'legacy'} rechecks saved hints and preserves its renderer and input`, async ({ page }) => {
  const app = await fixture({ mode, rfb: true, webrtc: true, fastConnect: seamless, seamless }); const offers = [];
  try {
    page.on('request', request => { if (request.url().endsWith(`/api/${mode}/rtc`)) offers.push(request.postDataJSON()); });
    await page.addInitScript(({ mode, seamless }) => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode }));
      // Mock only old-path TURN diagnostics; ICE/DTLS and payloads stay real.
      if (mode === 'terminal' && seamless) {
        const PC = RTCPeerConnection; let count = 0;
        window.RTCPeerConnection = class extends PC {
          constructor(...args) { super(...args); this.oldTurn = count++ === 0; }
          async getStats(...args) { const stats = await super.getStats(...args); return this.oldTurn && window.mockTurn ? new Map([...stats].map(([id, row]) => [id, row.type === 'remote-candidate' ? { ...row, candidateType: 'relay' } : row])) : stats; }
        };
      }
      if (location.pathname === '/terminal/index.html') {
        let Terminal; window.rendererCount = 0;
        Object.defineProperty(window, 'Terminal', { get: () => Terminal, set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.rendererCount++; } }; } });
      }
    }, { mode, seamless });
    await login(page, app); const source = await page.locator('#desktop-frame').getAttribute('src');
    const frame = page.frames().find(frame => frame.url().includes(mode === 'terminal' ? '/terminal/index.html' : '/desktop/index.html'));
    if (mode === 'terminal' && seamless) { await frame.evaluate(() => { window.mockTurn = true; }); await expect(page.locator('#diag-transport')).toContainText('TURN', { timeout: 8000 }); }
    await hints(page, false); expect(offers).toHaveLength(1);
    if (mode === 'terminal' && seamless) await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift' })));
    await page.locator('#save-direct-hints').click();
    await expect.poll(() => offers.length).toBe(2); expect(offers[1].hints.server).toBe('10.123.254.253');
    if (mode === 'terminal' && seamless) {
      await expect(page.locator('#direct-probe-status')).toContainText('等待操作空闲');
      expect(app.terminalConnections).toBe(1);
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift' })));
    }
    await expect(page.locator('#save-direct-hints')).toBeEnabled({ timeout: 22000 });
    await expect(page.locator('#direct-probe-status')).toContainText(/新连接已启用|新候选已验证|保留当前更快/);
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    if (seamless) expect(mode === 'terminal' ? app.terminalConnections : app.vncConnections).toBe(1);
    if (mode === 'terminal') expect(await page.frames().find(frame => frame.url().includes('/terminal/index.html')).evaluate(() => window.rendererCount)).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a failed explicit recheck keeps the healthy terminal path and makes no new shell or input', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', rfb: true, webrtc: true, fastConnect: true, seamless: true });
  try {
    await login(page, app); let offers = 0;
    await page.route('**/api/terminal/rtc', route => { offers++; return route.fulfill({ status: 503, json: { error: 'isolated recheck failure' } }); });
    await hints(page);
    await expect(page.locator('#direct-probe-status')).toContainText('本次探测未成功');
    await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(offers).toBe(1); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('service recheck waits for an existing file confirmation before replacing its healthy peer', async ({ page }) => {
  const app = await fixture({ webrtc: true }); const offers = [];
  try {
    await app.login(); await app.claim(); await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
    await page.addInitScript(() => {
      window.servicePeers = []; const PC = RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) { super(...args); window.servicePeers.push(this); }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options);
          if (label === 'codex-files') channel.addEventListener('open', () => { window.serviceFileReady = true; });
          if (label === 'codex-files') channel.addEventListener('message', event => {
            if (!event.isTrusted || typeof event.data !== 'string' || JSON.parse(event.data).type !== 'done') return;
            event.stopImmediatePropagation(); window.releaseFileDone = () => channel.dispatchEvent(new MessageEvent('message', { data: event.data }));
          });
          return channel;
        }
      };
    });
    page.on('request', request => { if (request.url().endsWith('/api/service/rtc')) offers.push(request.postDataJSON()); });
    await page.goto(app.config.origin); await page.locator('#username').fill('visitor'); await page.locator('#password').fill('temporary-test-password'); await page.locator('#login-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#files-button').click(); await expect.poll(() => page.evaluate(() => window.serviceFileReady)).toBe(true);
    await page.locator('#upload-input').setInputFiles({ name: 'recheck.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32768, 42) });
    await expect.poll(() => page.evaluate(() => typeof window.releaseFileDone)).toBe('function');
    await page.locator('#close-files').click(); await hints(page);
    await expect(page.locator('#direct-probe-status')).toContainText('等待操作空闲');
    expect(await page.evaluate(() => window.servicePeers[0].connectionState)).toBe('connected');
    expect(offers[1].recheck).toBe(true); expect(app.files.get('recheck.bin').length).toBe(32768);
    await page.evaluate(() => window.releaseFileDone());
    await expect(page.locator('#direct-probe-status')).toContainText('新连接已启用');
    await expect.poll(() => page.evaluate(() => window.servicePeers[0].connectionState)).toBe('closed');
    expect(app.files.get('recheck.bin').length).toBe(32768); expect(app.vncConnections).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
