import { openInput } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { rtcAddress, rtcIPv6Address } from '../../panel/rtc.mjs';

const address = rtcIPv6Address(undefined, rtcAddress());
const onlyIPv6 = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || line.split(' ')[4]?.includes(':')).join('\r\n');
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线', { timeout: 20000 });
}

test('real IPv6 UDP/DTLS direct path reports selected addresses and survives relay fallback and re-upgrade without replay', async ({ page }) => {
  test.skip(!address, '需要本机已分配的公网 IPv6；不以模拟地址替代实际 IPv6 网络栈');
  test.setTimeout(60000);
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, webrtcIPv6: true, webrtcIPv6Address: address,
    webrtcStunUrl: 'stun:stun.cloudflare.com:3478' });
  const writes = { login: 0, claim: 0, input: 0, rtc: 0, ws: 0 };
  page.on('websocket', () => writes.ws++);
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) writes.login++;
    if (request.url().endsWith('/api/desktop/claim')) writes.claim++;
    if (request.url().endsWith('/api/desktop/rtc')) writes.rtc++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) writes.input++;
  });
  await page.addInitScript(() => {
    window.healthTrace = { sent: 0, dropped: 0, replies: 0 };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) { super(...args); window.testPeer = this; }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args), send = channel.send.bind(channel);
        if (args[0] === 'codex-health') {
          channel.send = bytes => { window.healthTrace.sent++; if (!window.dropHealth) send(bytes); else window.healthTrace.dropped++; };
          channel.addEventListener('message', () => window.healthTrace.replies++);
        }
        return channel;
      }
    };
  });
  // Remove IPv4 from both directions: a successful test must use actual IPv6.
  await page.route('**/api/desktop/rtc', async route => {
    const body = route.request().postDataJSON(); body.sdp = onlyIPv6(body.sdp);
    expect(body.sdp).toMatch(/a=candidate:[^\r\n]+ [0-9a-f:]+ \d+ typ /i);
    const response = await route.fetch({ postData: JSON.stringify(body) }), answer = await response.json();
    answer.sdp = onlyIPv6(answer.sdp); await route.fulfill({ response, json: answer });
  });
  try {
    await login(page, app);
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-transport')).toHaveText('WebRTC 加密直连（IPv6）');
    await expect(page.locator('#diag-network')).toHaveText('IPv6 / UDP');
    await expect(page.locator('#diag-peer')).toContainText(`[${address}]:`);
    const frame = page.frames().find(f => f.url().includes('/desktop/index.html'));
    expect(await frame.evaluate(async () => [...(await window.testPeer.getStats()).values()].find(row => row.type === 'transport').dtlsState)).toBe('connected');
    await page.locator('#close-connection').click();
    await openInput(page); await page.locator('#mobile-input').fill('IPv6 往返切换保留草稿');
    await openInput(page); await page.locator('[data-key="Enter"]').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await frame.evaluate(() => {
      window.dropHealth = true; window.dispatchEvent(new Event('online'));
      window.noisyNetwork = setInterval(() => window.dispatchEvent(new Event('online')), 100);
    });
    try {
      await expect.poll(() => writes.ws, { timeout: 3500, intervals: [100] }).toBe(1);
    } catch (error) {
      console.log('IPv6 heartbeat state', await frame.evaluate(() => ({ ...window.healthTrace, hidden: document.hidden, online: navigator.onLine, state: window.testPeer.connectionState })));
      throw error;
    }
    await frame.evaluate(() => clearInterval(window.noisyNetwork));
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-transport')).toHaveText('HTTPS / WebSocket 中转');
    await expect(page.locator('#diag-network')).toHaveText('当前未使用 WebRTC');
    await expect(page.locator('#diag-peer')).toHaveText('—');
    await page.locator('#close-connection').click();
    await frame.evaluate(() => { window.dropHealth = false; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => app.vncConnections, { timeout: 15000 }).toBe(3);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.locator('#connection-button').click();
    await expect(page.locator('#diag-network')).toHaveText('IPv6 / UDP');
    await expect(page.locator('#mobile-input')).toHaveValue('IPv6 往返切换保留草稿');
    expect(app.inputCalls).toEqual([{ action: 'key', key: 'Enter' }]);
    expect(writes).toEqual({ login: 1, claim: 1, input: 0, rtc: 2, ws: 1 });
    expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('unreachable browser STUN is bounded and does not prevent the existing IPv4 LAN connection', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, webrtc: true, webrtcIPv6: true, webrtcStunUrl: 'stun:127.0.0.1:9' });
  try {
    await login(page, app); await page.locator('#connection-button').click();
    await expect(page.locator('#diag-network')).toHaveText('IPv4 / UDP');
    await expect(page.locator('#diag-peer')).toContainText('127.0.0.1:');
    await expect(page.locator('#diag-direct-status')).toHaveText('已建立加密直连');
    expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
