import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });

// Real local WebRTC channels with synthetic getStats candidate types: these
// assertions verify presentation, not connectivity through an actual TURN server.
async function instrument(page, mode) {
  await page.addInitScript(mode => {
    if (window === window.top) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, zoom: 'width', collapsed: true, terminalInputCollapsed: true }));
      window.routeProfiles = { frame: ['relay', 'relay'], service: ['host', 'host'] };
    }
    const Native = RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      async getStats(...args) {
        const stats = await super.getStats(...args), types = window.top.routeProfiles[window === window.top ? 'service' : 'frame'];
        if (!types) return new Map();
        return new Map([...stats].map(([id, row]) => [id, ['local-candidate', 'remote-candidate'].includes(row.type)
          ? { ...row, candidateType: types[row.type === 'local-candidate' ? 0 : 1], address: window.top.routeAddresses?.[row.type === 'local-candidate' ? 0 : 1] || '203.0.113.8', port: row.type === 'local-candidate' ? 49161 : 49162 }
          : row]));
      }
    };
  }, mode);
}

async function login(page, app, username = '') {
  await page.goto(app.config.origin);
  if (username) await page.locator('#username').fill(username);
  await page.locator('#password').fill(username ? 'temporary-test-password' : app.config.password);
  await page.locator('#login-button').click();
}

for (const mode of ['desktop', 'terminal']) test(`${mode} labels follow their selected route independently of services, files and helper downloads`, async ({ page }) => {
  const app = await fixture({ rfb: true, webrtc: true, seamless: true, fastConnect: true });
  try {
    await instrument(page, mode); await login(page, app);
    await expect(page.locator('#connection-status')).toContainText('在线');
    await page.locator('#forward-button').click();
    await page.locator('#forward-close').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC 加密中继（TURN）', { timeout: 15000 });
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密中继（TURN）');
    await expect(page.locator('#diag-direct-status')).toHaveText('已建立 TURN 中继（端到端加密）');
    await expect(page.locator('#diag-peer')).toHaveText('203.0.113.8:49161（TURN 中继地址） ↔ 203.0.113.8:49162（TURN 中继地址）');
    await expect(page.locator('#file-transport')).toContainText('WebRTC 加密直连');
    await expect(page.locator('#diag-panel')).toContainText('WebRTC 加密直连');
    await expect(page.locator('#forward-download-status')).toContainText('已就绪（直连）');

    await page.evaluate(() => { window.routeProfiles = { frame: ['host', 'srflx'], service: ['host', 'relay'] }; });
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密直连（NAT 打洞）' + (mode === 'terminal' ? ' · 文字终端' : ''), { timeout: 7000 });
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密直连（NAT 打洞）');
    await expect(page.locator('#diag-peer')).toContainText('NAT 映射地址');
    await expect(page.locator('#file-transport')).toContainText('WebRTC 加密中继（TURN）');
    await expect(page.locator('#diag-panel')).toContainText('WebRTC 加密中继（TURN）');
    await expect(page.locator('#forward-download-status')).toContainText('已就绪（TURN 中继）');

    await page.evaluate(() => { window.routeProfiles.frame = ['host', 'host']; window.routeAddresses = ['192.168.1.2', '192.168.1.3']; });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC 加密直连（局域网）', { timeout: 7000 });
    await page.evaluate(() => { window.routeAddresses = ['2606:4700::1', '2408:8000::2']; });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC 加密直连（IPv6）', { timeout: 7000 });
    await page.evaluate(() => { window.routeAddresses = null; });

    await page.evaluate(() => { window.routeProfiles = { frame: ['host', undefined], service: null }; });
    await expect(page.locator('#diag-transport')).toContainText('WebRTC 加密通道（路径待确认）', { timeout: 7000 });
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密通道（路径待确认）');
    await expect(page.locator('#diag-direct-status')).toContainText('路径待确认');
    await expect(page.locator('#diag-peer')).toContainText('类型未知');
    await expect(page.locator('#file-transport')).toContainText('WebRTC 加密通道（路径待确认）');
    await expect(page.locator('#forward-download-status')).toContainText('已就绪（路径待确认）');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('temporary accounts show their service TURN endpoint without claiming the desktop', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  try {
    await app.login(); await app.claim();
    await app.request('/api/security/temporary-account', { method: 'POST', body: { enabled: true, username: 'visitor', password: 'temporary-test-password', durationMs: 3600000 } });
    await instrument(page, 'terminal'); await login(page, app, 'visitor');
    await page.evaluate(() => { window.routeProfiles.service = [undefined, 'relay']; });
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密中继（TURN） · 受限服务', { timeout: 15000 });
    await expect(page.locator('#diag-peer')).toContainText('TURN 中继地址');
    await expect(page.locator('#diag-direct-status')).toContainText('TURN 中继');
    await expect(page.locator('#diag-input-transport')).toHaveText('当前账号无桌面输入权限');
    await expect(page.locator('#file-transport')).toContainText('WebRTC 加密中继（TURN）');
    expect(app.vncConnections).toBe(0); expect(app.terminalConnections).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
