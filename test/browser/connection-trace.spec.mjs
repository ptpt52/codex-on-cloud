import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { TRACE_LIMITS } from '../../panel/public/connection-trace.js';
test.use({ serviceWorkers: 'block' });
test('active and standby preparation and stopped probes stay visible with process logging disabled', async ({ page }) => {
  test.setTimeout(45000);
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, seamless: true, webrtc: true, fastConnect: true });
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/desktop/viewer.js?*', async route => { await held; await route.continue(); });
  await page.route('**/api/desktop/rtc', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(() => { if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', modeStandby: true, networkDebug: false })); });
  try {
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#connection-button').click();
    const current = page.locator('#connection-trace-current');
    await expect(current).toContainText(/网页终端：[\s\S]*模块已加载 · 首帧已接收/);
    await expect(current).toContainText(/桌面（待命）：[^\n]*模块加载中/);
    release();
    await expect(current).toContainText(/桌面（待命）：[^\n]*模块已加载 · 首帧已接收/, { timeout: 15000 });
    await expect(current).toContainText('自动探测已停止');
    await expect(current).toContainText('访问权限需要重新确认');
    await expect(page.locator('#copy-connection-trace')).toBeDisabled();
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { release(); await app.close(); }
});
async function login(page, app) {
  await page.addInitScript(() => {
    if (window !== parent) return;
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', networkDebug: true }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('manual copy test'); } } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
test('connection timeline measures relay and direct stages, sanitizes events and offers bounded manual copying', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('中转认证完成');
    for (const text of ['收集地址', '交换连接信息', '建立加密通道', 'ms', '数据通道已启用']) await expect(page.locator('#connection-trace-list')).toContainText(text);
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await frame.evaluate(() => {
      const current = new URLSearchParams(location.search).get('frame');
      parent.postMessage({ type: 'codex-network-event', frame: 'stale', event: { type: 'input-pressure' } }, location.origin);
      parent.postMessage({ type: 'codex-network-event', frame: current, event: { type: 'retry', path: 'direct', waitMs: 500, text: 'PRIVATE_TEXT_SENTINEL', address: 'PRIVATE_ADDRESS_SENTINEL', reason: 'PRIVATE_REASON_SENTINEL' } }, location.origin);
      parent.postMessage({ type: 'codex-network-event', frame: current, event: { type: 'rpc-failed', path: 'direct', reason: 'local-http-timeout', action: 'diagnostics', status: 504, outcome: 'unknown', body: 'PRIVATE_RPC_BODY' } }, location.origin);
      parent.postMessage({ type: 'codex-network-event', frame: current, event: { type: 'rpc-recovered', reason: 'late-reply', action: 'file-delete' } }, location.origin);
    });
    await expect(page.locator('#connection-trace-list')).toContainText('500 ms 后');
    await expect(page.locator('#connection-trace-list')).toContainText('节点本机服务请求超时');
    await expect(page.locator('#connection-trace-list')).toContainText('连接诊断');
    await expect(page.locator('#connection-trace-list')).toContainText('删除文件');
    await expect(page.locator('#connection-trace-list')).not.toContainText('输入队列达到上限');
    await page.locator('#copy-connection-trace').click(); await expect(page.locator('#connection-trace-copy')).toBeVisible();
    const copied = await page.locator('#connection-trace-copy').inputValue();
    expect(copied).not.toContain('PRIVATE_'); expect(new TextEncoder().encode(copied).length).toBeLessThanOrEqual(TRACE_LIMITS.bytes);
    expect(JSON.parse(copied).events.length).toBeLessThanOrEqual(TRACE_LIMITS.events);
    await page.locator('#clear-connection-trace').click(); await expect(page.locator('#connection-trace-list > li')).toHaveCount(0);
    await expect(page.locator('#connection-trace-copy')).toBeHidden();
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('one click copies current progress and exact stopped-probe status; export contains only sanitized diagnostics', async ({ page }) => {
  await page.addInitScript(() => {
    if (window !== parent) return;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedNetworkLog = value; } } });
    localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', networkDebug: true }));
  });
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await page.route('**/api/terminal/rtc', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'PRIVATE_SERVER_ERROR_SENTINEL' }) }));
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('自动直连探测已停止');
    await expect(page.locator('#connection-trace-list')).toContainText('HTTP 409');
    await expect(page.locator('#connection-trace-current')).toContainText('自动直连探测已停止');
    await page.locator('#copy-connection-trace').click();
    await expect.poll(() => page.evaluate(() => !!window.copiedNetworkLog)).toBe(true);
    const copied = await page.evaluate(() => window.copiedNetworkLog), value = JSON.parse(copied);
    expect(value.current.views.some(view => view.mode === 'terminal' && view.path === 'relay')).toBe(true);
    expect(value.current.views.find(view => view.mode === 'terminal').route).toBe('wss');
    expect(value.events.some(event => event.type === 'path-lost' && event.status === 409)).toBe(true);
    expect(copied).not.toContain('PRIVATE_'); expect(copied).not.toContain(app.config.password);
    const download = page.waitForEvent('download'); await page.locator('#download-connection-trace').click();
    expect((await download).suggestedFilename()).toMatch(/^codex-network-.*\.json$/);
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('logs survive a page reload in this tab and an explicit clear persists across the next reload', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    await login(page, app);
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await frame.evaluate(() => parent.postMessage({ type: 'codex-network-event', frame: new URLSearchParams(location.search).get('frame'), event: { type: 'probe-stopped', path: 'direct', reason: 'auth', attempt: 17 } }, location.origin));
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('第 17 次尝试');
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('第 17 次尝试');
    await page.locator('#clear-connection-trace').click();
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).not.toContainText('第 17 次尝试');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('debugging defaults off and toggles live without a new viewer, peer, task or retained export', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true });
  try {
    await page.addInitScript(() => {
      window.debugPeers = [];
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.debugPeers.push(this); } };
      if (window !== parent) {
        addEventListener('message', event => { if (event.origin === location.origin && event.source === parent && event.data?.type === 'codex-network-debug') window.debugSetting = event.data.enabled; });
        return;
      }
      if (!localStorage.getItem('codex-cloud.display.v1')) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal' }));
      window.debugMessages = 0; addEventListener('message', event => { if (event.origin === location.origin && event.data?.type === 'codex-network-event') window.debugMessages++; });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('manual copy'); } } });
    });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const frame = page.frame({ url: /\/terminal\/index.html/ }), source = await page.locator('#desktop-frame').getAttribute('src');
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-debug-toggle')).not.toBeChecked(); await expect(page.locator('#copy-connection-trace')).toBeDisabled();
    expect(await page.evaluate(() => window.debugMessages)).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('codex-cloud.network-log.v2'))).toBeNull();
    await page.locator('#connection-debug-toggle').check();
    await expect(page.locator('#network-debug')).toBeChecked();
    await expect.poll(() => frame.evaluate(() => window.debugSetting)).toBe(true);
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => page.evaluate(() => window.debugMessages)).toBeGreaterThan(0);
    await expect(page.locator('#connection-trace-list')).toContainText('开始记录网络调试日志');
    await page.locator('#copy-connection-trace').click(); await expect(page.locator('#connection-trace-copy')).toBeVisible();
    expect(JSON.parse(await page.locator('#connection-trace-copy').inputValue()).capture.enabled).toBe(true);
    await page.locator('#connection-debug-toggle').uncheck();
    await expect.poll(() => frame.evaluate(() => window.debugSetting)).toBe(false);
    const count = await page.evaluate(() => window.debugMessages);
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.debugMessages)).toBe(count);
    await expect(page.locator('#connection-trace-list > li')).toHaveCount(0); await expect(page.locator('#connection-trace-copy')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('codex-cloud.network-log.v2'))).toBeNull();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(await frame.evaluate(() => window.debugPeers.length)).toBe(1); expect(app.terminalConnections).toBe(1);
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-debug-toggle')).not.toBeChecked(); await expect(page.locator('#connection-trace-list > li')).toHaveCount(0);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a same-origin tab can disable capture without changing the current viewer or connection', async ({ page, context }) => {
  const app = await fixture({ rfb: true, seamless: true, webrtc: true, fastConnect: true }); let other;
  try {
    await login(page, app); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-debug-toggle')).toBeChecked();
    other = await context.newPage(); await other.goto(app.config.origin + '/readyz');
    await other.evaluate(() => { const key = 'codex-cloud.display.v1', value = JSON.parse(localStorage.getItem(key)); value.networkDebug = false; localStorage.setItem(key, JSON.stringify(value)); });
    await expect(page.locator('#connection-debug-toggle')).not.toBeChecked(); await expect(page.locator('#network-debug')).not.toBeChecked();
    await expect(page.locator('#connection-trace-list > li')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('codex-cloud.network-log.v2'))).toBeNull();
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.terminalConnections).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await other?.close(); await app.close(); }
});

test('late clipboard rejection cannot restore an export after capture is disabled and enabled again', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true });
  try {
    await login(page, app); await page.locator('#connection-button').click(); await page.locator('#connection-trace > summary').click();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, reject) => { window.rejectDebugCopy = reject; }) } }));
    await page.locator('#copy-connection-trace').click();
    await expect.poll(() => page.evaluate(() => typeof window.rejectDebugCopy)).toBe('function');
    await page.locator('#connection-debug-toggle').uncheck(); await page.locator('#connection-debug-toggle').check();
    await page.evaluate(() => window.rejectDebugCopy(Error('clipboard denied')));
    await expect(page.locator('#connection-trace-copy')).toBeHidden(); await expect(page.locator('#connection-trace-copy')).toHaveValue('');
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
