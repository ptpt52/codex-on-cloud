import { openInput, openTools } from './ui.mjs';
import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { rtcAddress, rtcIPv6Address } from '../../panel/rtc.mjs';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function writes(page) {
  const value = { login: 0, claim: 0, input: 0, ws: 0, rtc: 0 };
  page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/terminal/connect') value.ws++; });
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/login')) value.login++;
    if (request.url().endsWith('/api/desktop/claim')) value.claim++;
    if (/\/api\/(paste|key|terminal)$/.test(request.url())) value.input++;
    if (request.url().endsWith('/api/terminal/rtc')) value.rtc++;
  }); return value;
}
async function prepare(page, badChannel = false) {
  await page.addInitScript(({ badChannel }) => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    window.terminalPeers = []; window.terminalChannels = [];
    const Native = RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) { super(...args); window.terminalPeers.push(this); if (window.terminalPeers.length > 16) window.terminalPeers.shift(); }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        if (label === 'codex-terminal') {
          window.terminalChannels.push(channel); if (window.terminalChannels.length > 16) window.terminalChannels.shift();
          const send = channel.send.bind(channel);
          channel.send = bytes => {
            if (bytes.byteLength === 1 && badChannel) return send(new Uint8Array([1]));
            let record; try { record = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + 4, bytes.byteLength - 4))); } catch {}
            if (channel === window.dropHealthChannel && record?.type === 'health') return;
            send(bytes);
          };
        }
        return channel;
      }
    };
  }, { badChannel });
}
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 20000 });
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
async function diagnostics(page, transport) {
  await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toHaveText(transport);
}
async function network(frame) { await frame.evaluate(() => window.dispatchEvent(new Event('online'))); }
const DIRECT = 'WebRTC 加密直连 · 文字终端', RELAY = 'HTTPS / WebSocket 文字终端';

test('real terminal UDP/DTLS shares the original task, routes Chinese paste and separate Enter, and switches auxiliary terminals without VNC or WSS', async ({ page }) => {
  const app = await fixture({ webrtc: true }), counts = writes(page);
  try {
    await app.controls.manageTerminals({ action: 'create', name: '独立任务', view: 'terminal' }); await prepare(page);
    const frame = await login(page, app); await diagnostics(page, DIRECT);
    await expect(page.locator('#diag-input-transport')).toHaveText('WebRTC 加密直连');
    await expect(page.locator('#diag-network')).toHaveText('IPv4 / UDP'); await expect(page.locator('#diag-latency')).toHaveText(/^\d+ ms$/);
    const transport = await frame.evaluate(async () => [...(await window.terminalPeers.at(-1).getStats()).values()].find(value => value.type === 'transport'));
    expect(transport.dtlsState).toBe('connected'); expect(transport.dtlsCipher).toBeTruthy(); expect(transport.selectedCandidatePairId).toBeTruthy();
    await page.locator('#close-connection').click(); await page.locator('#toggle-input-button').click();
    await openInput(page); await page.locator('#mobile-input').fill('中文\n第二行'); await openInput(page); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~中文\n第二行\x1b[201~' }]);
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await expect.poll(() => app.terminalInputs.length).toBe(2); expect(app.terminalInputs[1].text).toBe('\r');
    await page.frameLocator('#desktop-frame').locator('.xterm-helper-textarea').press('a'); await expect.poll(() => app.terminalInputs.at(-1).text).toBe('a');
    await page.keyboard.insertText('直输中文'); await expect.poll(() => app.terminalInputs.at(-1).text).toBe('直输中文');
    await page.locator('#toggle-input-button').click(); await openTools(page); await page.locator('#terminal-font-up').click();
    await openTools(page); await page.locator('#terminal-view-select').selectOption('aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线', { timeout: 15000 });
    await expect(page.locator('#terminal-font-label')).toHaveText('16'); await expect(page.locator('#mobile-input')).toHaveValue('');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 0, rtc: 2 }); expect(app.terminalConnections).toBe(2); expect(app.vncConnections).toBe(0);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    expect((await app.controls.listTerminals()).terminals.find(value => value.id === 'main').token).toBe('%0:4000');
  } finally { await app.close(); }
});

test('failed direct negotiation retains authenticated WSS and reports the fallback reason without replay', async ({ page }) => {
  const app = await fixture({ webrtc: true }), counts = writes(page);
  try {
    await prepare(page); await page.route('**/api/terminal/rtc', route => route.fulfill({ status: 503, json: { error: '模拟直连暂不可达' } }));
    await login(page, app); await diagnostics(page, RELAY);
    await expect(page.locator('#diag-direct-status')).toHaveText('协商服务暂不可达，稍后重试');
    await expect(page.locator('#diag-latency')).toHaveText(/^\d+ ms$/);
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 1, rtc: 1 }); expect(app.terminalConnections).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.vncConnections).toBe(0);
  } finally { await app.close(); }
});

test('periodic probing keeps WSS and its sole PTY alive until direct activation, retries after failure and preserves the draft and font', async ({ page }) => {
  test.setTimeout(60000);
  const app = await fixture({ webrtc: true }), counts = writes(page), answered = gate(), hold = gate(); let offers = 0;
  try {
    await prepare(page); await page.clock.install();
    await page.route('**/api/terminal/rtc', async route => {
      if (++offers < 3) return route.fulfill({ status: 503, json: { error: '等待网络恢复' } });
      const response = await route.fetch(); answered.release(); await hold.promise; await route.fulfill({ response }).catch(() => {});
    });
    const frame = await login(page, app); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('#mobile-input').fill('自动换通道保留草稿');
    await page.locator('#toggle-input-button').click(); await openTools(page); await page.locator('#terminal-font-up').click();
    await page.clock.fastForward(16000); await expect.poll(() => offers).toBe(2);
    await frame.waitForFunction(() => window.terminalPeers.at(-1).connectionState === 'closed'); expect(app.terminalConnections).toBe(1);
    await page.clock.fastForward(31000); await answered.promise;
    expect(app.terminalConnections).toBe(1); await expect(page.locator('#connection-status')).toContainText('终端在线');
    hold.release(); await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(2);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await diagnostics(page, DIRECT);
    await expect(page.locator('#terminal-font-label')).toHaveText('16'); await expect(page.locator('#mobile-input')).toHaveValue('自动换通道保留草稿');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 1, rtc: 3 }); expect(app.terminalInputs).toEqual([]); expect(app.vncConnections).toBe(0);
  } finally { hold.release(); await app.close(); }
});

test('accepted input and IME composition defer automatic promotion; server also refuses activation while terminal input is pending', async ({ page }) => {
  test.setTimeout(60000);
  const entered = gate(), hold = gate(), app = await fixture({ webrtc: true, terminalHook: async () => { entered.release(); await hold.promise; } }); let available = false, offers = 0;
  try {
    await prepare(page); await page.clock.install(); await page.route('**/api/terminal/rtc', route => { offers++; return available ? route.continue() : route.fulfill({ status: 503, json: { error: '直连暂不可用' } }); });
    const frame = await login(page, app); await page.clock.fastForward(14000); await page.waitForTimeout(100);
    await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('[data-key="Enter"]').click(); await entered.promise;
    available = true; await page.clock.fastForward(2000); expect(offers).toBe(1); expect(app.terminalConnections).toBe(1);
    const status = await frame.evaluate(async () => {
      const { terminalDirect } = await import('/terminal/terminal-rtc.js'), query = new URLSearchParams(location.search);
      const candidate = await terminalDirect(query.get('viewer'), { terminalId: query.get('terminalId'), terminalToken: query.get('terminalToken') }, {});
      try { await candidate.start(); await candidate.activate(); return 200; } catch (error) { return error.status; } finally { candidate?.close(); }
    });
    expect(status).toBe(409); expect(app.terminalConnections).toBe(1);
    hold.release(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await frame.evaluate(() => window.dispatchEvent(new CompositionEvent('compositionstart'))); await network(frame);
    await page.clock.fastForward(2000); expect(offers).toBe(2); expect(app.terminalConnections).toBe(1);
    await frame.evaluate(() => window.dispatchEvent(new CompositionEvent('compositionend'))); await network(frame);
    await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(2); await diagnostics(page, DIRECT);
    expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\r' }]); expect(app.inputCalls).toEqual([]);
  } finally { hold.release(); await app.close(); }
});

test('a silent OPEN direct connection loses an accepted result once, falls back to WSS and later recovers direct without resending', async ({ page }) => {
  test.setTimeout(60000);
  const entered = gate(), hold = gate(), app = await fixture({ webrtc: true, terminalHook: async () => { entered.release(); await hold.promise; } }), counts = writes(page);
  try {
    await prepare(page); const frame = await login(page, app); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('#mobile-input').fill('切网仍保留');
    await openInput(page); await page.locator('[data-key="Enter"]').click(); await entered.promise;
    await frame.evaluate(() => { window.dropHealthChannel = window.terminalChannels.at(-1); window.dispatchEvent(new Event('online')); });
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown', { timeout: 3500 });
    await expect.poll(() => app.terminalConnections, { timeout: 10000 }).toBe(2); hold.release();
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await diagnostics(page, RELAY);
    await expect(page.locator('#diag-direct-status')).toHaveText('WebRTC 心跳无回复，已开始回退 HTTPS / WebSocket'); await page.locator('#close-connection').click();
    await network(frame); await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(3); await diagnostics(page, DIRECT);
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 1, rtc: 2 }); expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\r' }]);
    await expect(page.locator('#mobile-input')).toHaveValue('切网仍保留'); expect(app.managementStats.restarts).toBe(0);
  } finally { hold.release(); await app.close(); }
});

test('takeover cancels a pending terminal probe and cannot attach an extra PTY to the new viewer', async ({ page, context }) => {
  test.setTimeout(60000);
  const app = await fixture({ webrtc: true }), hold = gate(), answered = gate(), counts = writes(page); let offers = 0;
  try {
    await prepare(page); await page.clock.install(); await page.route('**/api/terminal/rtc', async route => {
      if (++offers === 1) return route.fulfill({ status: 503, json: { error: '首次直连不可用' } });
      const response = await route.fetch(); answered.release(); await hold.promise; await route.fulfill({ response }).catch(() => {});
    });
    await login(page, app); await page.clock.fastForward(16000); await answered.promise; expect(app.terminalConnections).toBe(1);
    const second = await context.newPage();
    try {
      await second.goto(app.config.origin); await expect(second.locator('#connection-status')).toContainText('终端在线', { timeout: 20000 });
      hold.release(); await expect(page.locator('#takeover-button')).toBeVisible({ timeout: 10000 }); await page.waitForTimeout(2250);
      expect(app.terminalConnections).toBe(2); expect(app.terminalInputs).toEqual([]); expect(counts.login).toBe(1); expect(counts.claim).toBe(1);
    } finally { await second.close(); }
  } finally { hold.release(); await app.close(); }
});

test('an invalid terminal readiness byte closes direct before any PTY starts and falls back to WSS', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let beforeFallback;
  app.panel.server.on('upgrade', () => { beforeFallback = app.terminalConnections; });
  try {
    await prepare(page, true); await login(page, app); await diagnostics(page, RELAY);
    expect(beforeFallback).toBe(0); expect(app.terminalConnections).toBe(1); expect(app.vncConnections).toBe(0); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a wrong DTLS fingerprint cannot start a terminal PTY and falls back to WSS', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let beforeFallback;
  app.panel.server.on('upgrade', () => { beforeFallback = app.terminalConnections; });
  try {
    await prepare(page); await page.route('**/api/terminal/rtc', route => {
      const body = route.request().postDataJSON(); body.sdp = body.sdp.replace(/a=fingerprint:sha-256 [^\r\n]+/, 'a=fingerprint:sha-256 ' + Array(32).fill('00').join(':'));
      return route.continue({ postData: JSON.stringify(body) });
    });
    await login(page, app); await diagnostics(page, RELAY); expect(beforeFallback).toBe(0); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('the terminal uses an actual IPv6 UDP/DTLS path when the host has a global IPv6 address', async ({ page }) => {
  const address = rtcIPv6Address(undefined, rtcAddress());
  test.skip(!address, '需要本机已分配的公网 IPv6，不用模拟地址替代真实网络栈');
  const app = await fixture({ webrtc: true, webrtcIPv6: true, webrtcIPv6Address: address, webrtcStunUrl: 'stun:stun.cloudflare.com:3478' }), counts = writes(page);
  const onlyIPv6 = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || line.split(' ')[4]?.includes(':')).join('\r\n');
  try {
    await prepare(page); await page.route('**/api/terminal/rtc', async route => {
      const body = route.request().postDataJSON(); body.sdp = onlyIPv6(body.sdp);
      const response = await route.fetch({ postData: JSON.stringify(body) }), answer = await response.json(); answer.sdp = onlyIPv6(answer.sdp);
      await route.fulfill({ response, json: answer });
    });
    await login(page, app); await diagnostics(page, DIRECT); await expect(page.locator('#diag-network')).toHaveText('IPv6 / UDP');
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 0, rtc: 1 }); expect(app.terminalConnections).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('held native keys and a dangerous-key confirmation postpone promotion until both are released', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let offers = 0;
  try {
    await prepare(page); await page.clock.install(); await page.route('**/api/terminal/rtc', route => ++offers === 1 ? route.fulfill({ status: 503, json: { error: '首次直连不可用' } }) : route.continue());
    const frame = await login(page, app); await page.frameLocator('#desktop-frame').locator('.xterm-helper-textarea').focus(); await page.keyboard.down('Shift');
    await page.clock.fastForward(16000); await page.waitForTimeout(100); expect(offers).toBe(1); expect(app.terminalConnections).toBe(1);
    await page.keyboard.up('Shift'); await page.locator('#toggle-input-button').click(); await openInput(page); await page.locator('[data-key="Ctrl+C"]').click();
    await network(frame); await page.clock.fastForward(2000); expect(offers).toBe(1); expect(app.terminalInputs).toEqual([]);
    await page.locator('#cancel-confirmation').click(); await network(frame);
    await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(2); await diagnostics(page, DIRECT); expect(app.terminalInputs).toEqual([]);
  } finally { await page.keyboard.up('Shift'); await app.close(); }
});

test('hidden and offline terminal states stop probes and return through WSS before recovering direct', async ({ page }) => {
  const app = await fixture({ webrtc: true }), counts = writes(page);
  try {
    await prepare(page); await page.clock.install(); const frame = await login(page, app);
    await frame.evaluate(() => {
      window.fakeHidden = true; window.fakeOnline = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fakeHidden });
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.fakeOnline });
      window.dropHealthChannel = window.terminalChannels.at(-1); document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(6000); expect(app.terminalConnections).toBe(1); expect(counts.ws).toBe(0);
    await frame.evaluate(() => { window.fakeOnline = false; window.dispatchEvent(new Event('offline')); window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(6000); expect(app.terminalConnections).toBe(1); expect(counts.ws).toBe(0);
    await frame.evaluate(() => { window.fakeOnline = true; window.dispatchEvent(new Event('online')); });
    await expect.poll(() => app.terminalConnections).toBe(2); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await network(frame); await expect.poll(() => app.terminalConnections, { timeout: 15000 }).toBe(3); await diagnostics(page, DIRECT);
    expect(counts).toEqual({ login: 1, claim: 1, input: 0, ws: 1, rtc: 2 }); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});
