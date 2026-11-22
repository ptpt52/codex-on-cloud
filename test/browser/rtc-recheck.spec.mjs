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

for (const mode of ['terminal', 'desktop']) for (const seamless of [false, true]) for (const hint of ['hidden', 'offline']) test(`${mode} ${seamless ? 'unified' : 'legacy'} cancels a manual heartbeat when ${hint} and preserves its live path`, async ({ page }) => {
  const app = await fixture({ mode, rfb: true, webrtc: true, fastConnect: seamless, seamless });
  try {
    await page.addInitScript(mode => {
      window.recheckPeers = []; window.manualHealthSends = 0;
      const PC = RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) { super(...args); this.manual = window.holdManual === true; window.recheckPeers.push(this); }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options);
          if (this.manual && label === 'codex-health') {
            const send = channel.send.bind(channel);
            channel.send = data => { window.manualHealthSends++; send(data); };
            // Lose only the manual candidate's health reply; its ICE/DTLS and
            // the existing viewer's association and application traffic stay real.
            channel.addEventListener('message', event => event.stopImmediatePropagation());
          }
          return channel;
        }
      };
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode }));
    }, mode);
    await login(page, app);
    const frame = page.frames().find(frame => frame.url().includes(`/${mode}/index.html`));
    await frame.evaluate(() => { window.holdManual = true; });
    await hints(page);
    await expect.poll(() => frame.evaluate(() => window.manualHealthSends), { timeout: 10000 }).toBe(1);
    await frame.evaluate(hint => {
      if (hint === 'hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      } else {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline'));
      }
    }, hint);
    await expect.poll(() => frame.evaluate(() => window.recheckPeers.find(peer => peer.manual)?.connectionState), { timeout: 1000 }).toBe('closed');
    await expect(page.locator('#save-direct-hints')).toBeEnabled({ timeout: 1000 });
    expect(await frame.evaluate(() => window.manualHealthSends)).toBe(1);
    expect(await frame.evaluate(() => window.recheckPeers[0].connectionState)).toBe('connected');
    expect(mode === 'terminal' ? app.terminalConnections : app.vncConnections).toBe(1);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['terminal', 'desktop']) for (const fault of ['lost reply', 'refusal']) test(`legacy ${mode} recheck recovers from activation ${fault} without replaying input`, async ({ page }) => {
  const app = await fixture({ mode, rfb: true, webrtc: true });
  try {
    await page.addInitScript(({ mode, fault }) => {
      if (window === parent) {
        localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode, networkDebug: true }));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.recheckLog = value; } } });
      }
      window.recheckPeers = []; window.recheckFaultReplies = 0; window.oldHealthSends = 0;
      const record = data => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
      };
      const PC = RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) { super(...args); this.oldPath = window.recheckPeers.length === 0; window.recheckPeers.push(this); }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options), send = channel.send.bind(channel);
          let faultId;
          channel.send = data => {
            if (this.oldPath && label === 'codex-health') window.oldHealthSends++;
            let value; try { value = record(data); } catch {}
            if (this.oldPath && label === 'codex-terminal' && value?.type === 'health') window.oldHealthSends++;
            if (label === 'codex-control' && value?.action === 'activate' && window.failActivation) {
              window.failActivation = false; faultId = value.id;
              window.healthBeforeFailure = window.oldHealthSends;
              if (fault === 'refusal') {
                // The real server rejects the invalid body before committing.
                const bytes = new TextEncoder().encode(JSON.stringify({ ...value, body: null })), frame = new Uint8Array(bytes.length + 4);
                new DataView(frame.buffer).setUint32(0, bytes.length); frame.set(bytes, 4); data = frame;
              }
            }
            send(data);
          };
          if (label === 'codex-control') channel.addEventListener('message', event => {
            let value; try { value = record(event.data); } catch { return; }
            if (value.id !== faultId) return;
            window.recheckFaultReplies++;
            // Lose only the committed activation reply. ICE, DTLS, the old
            // path's close and every other application message remain real.
            if (fault === 'lost reply') event.stopImmediatePropagation();
          });
          return channel;
        }
      };
    }, { mode, fault });
    await login(page, app);
    const source = await page.locator('#desktop-frame').getAttribute('src');
    const frame = page.frames().find(frame => frame.url().includes(mode === 'terminal' ? '/terminal/index.html' : '/desktop/index.html'));
    await frame.evaluate(() => { window.failActivation = true; });
    await hints(page);
    await expect.poll(() => frame.evaluate(() => window.recheckFaultReplies), { timeout: 15000 }).toBe(1);
    await expect(page.locator('#save-direct-hints')).toBeEnabled({ timeout: 12000 });
    await expect(page.locator('#direct-probe-status')).toContainText('本次探测未成功');
    if (fault === 'lost reply') {
      await expect.poll(() => mode === 'terminal' ? app.terminalConnections : app.vncConnections, { timeout: 10000 }).toBe(2);
      expect(await frame.evaluate(() => window.recheckPeers.slice(0, 2).map(peer => peer.connectionState))).toEqual(['closed', 'closed']);
    } else {
      await expect.poll(() => frame.evaluate(() => window.oldHealthSends > window.healthBeforeFailure), { timeout: 5000 }).toBe(true);
      expect(mode === 'terminal' ? app.terminalConnections : app.vncConnections).toBe(1);
      expect(await frame.evaluate(() => window.recheckPeers[0].connectionState)).toBe('connected');
    }
    await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    await page.locator('#connection-trace > summary').click();
    await expect(page.locator('#connection-trace-list')).toContainText('手动直连重测结束');
    await page.locator('#copy-connection-trace').click();
    const events = JSON.parse(await page.evaluate(() => window.recheckLog)).events.filter(event => event.mode === mode && event.type.startsWith('recheck-'));
    expect(events.map(event => event.type)).toEqual(['recheck-start', 'recheck-switch', 'recheck-ended']);
    expect(events.at(-1)).toMatchObject({ step: 'commit', result: 'failed', outcome: fault === 'refusal' ? 'rejected' : 'unknown' });
    if (fault === 'refusal') expect(events.at(-1).status).toBe(400);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['terminal', 'desktop']) for (const hint of ['hidden', 'offline', 'visibility-pulse', 'pagehide']) test(`legacy ${mode} retains a committed recheck under ${hint} or closes it on explicit exit`, async ({ page }) => {
  const app = await fixture({ mode, rfb: true, webrtc: true });
  try {
    await page.addInitScript(mode => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode }));
      window.committedPeers = [];
      const PC = RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) { super(...args); this.manual = window.holdCommittedRecheck === true; this.healthSends = 0; this.channels = []; window.committedPeers.push(this); }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options); this.channels.push({ label, channel });
          if (!this.manual) return channel;
          const send = channel.send.bind(channel), listen = channel.addEventListener.bind(channel), owner = this;
          let holding = false;
          const record = data => { const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength); return JSON.parse(new TextDecoder().decode(bytes.subarray(4))); };
          channel.send = data => {
            if (label === 'codex-health') owner.healthSends++;
            if (label === 'codex-terminal') { try { if (record(data).type === 'health') owner.healthSends++; } catch {} }
            if (label === 'codex-control') { try { if (record(data).action === 'activate') holding = true; } catch {} }
            return send(data);
          };
          if (label === 'codex-control') channel.addEventListener = (type, listener, options) => listen(type, type === 'message' ? event => {
            if (!holding) return listener.call(channel, event);
            if (window.releaseCommittedRecheck) throw Error('held activation confirmation limit');
            window.committedReply = record(event.data); window.committedCandidate = owner;
            // The response came from the real server after retiring its old
            // peer. Hold only delivery to the application, never ICE/DTLS.
            window.releaseCommittedRecheck = () => { holding = false; listener.call(channel, event); };
          } : listener, options);
          return channel;
        }
      };
    }, mode);
    await login(page, app);
    const source = await page.locator('#desktop-frame').getAttribute('src');
    const frame = page.frames().find(frame => frame.url().includes(`/${mode}/index.html`));
    await frame.evaluate(() => { window.holdCommittedRecheck = true; });
    await hints(page);
    await expect.poll(() => frame.evaluate(() => typeof window.releaseCommittedRecheck), { timeout: 15000 }).toBe('function');
    expect(await frame.evaluate(() => window.committedReply)).toMatchObject({ ok: true, value: { active: true } });
    await frame.evaluate(hint => {
      if (hint === 'offline') { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); }
      else if (hint === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      else {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
        if (hint === 'visibility-pulse') { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }
      }
      window.releaseCommittedRecheck();
    }, hint);
    await expect(page.locator('#save-direct-hints')).toBeEnabled({ timeout: 3000 });
    if (hint === 'pagehide') {
      await expect.poll(() => frame.evaluate(() => window.committedCandidate.connectionState)).toBe('closed');
      expect(mode === 'terminal' ? app.terminalConnections : app.vncConnections).toBe(1);
    } else {
      await expect(page.locator('#direct-probe-status')).toContainText('新连接已启用');
      expect(await frame.evaluate(() => window.committedCandidate.connectionState)).toBe('connected');
      await expect.poll(() => mode === 'terminal' ? app.terminalConnections : app.vncConnections).toBe(2);
      const pings = await frame.evaluate(() => window.committedCandidate.healthSends);
      await frame.evaluate(hint => {
        if (hint === 'offline') { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); }
        else { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }
      }, hint);
      await expect.poll(() => frame.evaluate(() => window.committedCandidate.healthSends), { timeout: 5000 }).toBeGreaterThan(pings);
      await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
      expect(await frame.evaluate(() => window.committedPeers.length)).toBe(2);
    }
    await expect.poll(() => frame.evaluate(() => window.committedPeers[0].channels.find(c => c.label === 'codex-control').channel.readyState)).toBe('closed');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
    expect(app.terminalInputs).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['terminal', 'desktop']) for (const seamless of [true, false]) test(`healthy ${mode} ${seamless ? 'unified' : 'legacy'} rechecks saved hints and preserves its renderer and input`, async ({ page }) => {
  const app = await fixture({ mode, rfb: true, webrtc: true, fastConnect: seamless, seamless }); const offers = [];
  try {
    page.on('request', request => { if (request.url().endsWith(`/api/${mode}/rtc`)) offers.push(request.postDataJSON()); });
    await page.addInitScript(({ mode, seamless }) => {
      if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode }));
      if (mode === 'terminal' && seamless && location.pathname === '/terminal/index.html') {
        // Give the manual candidate a clear advantage before testing the held
        // key. Leave ICE, DTLS and application messages on their real paths.
        const delayEcho = (target, delay, isEcho) => target.addEventListener('message', event => {
          const { data } = event;
          if (!event.isTrusted || !isEcho(data)) return;
          event.stopImmediatePropagation();
          setTimeout(() => target.dispatchEvent(new MessageEvent('message', { data })), delay);
        });
        const Socket = WebSocket;
        window.WebSocket = class extends Socket {
          constructor(...args) {
            super(...args);
            if (new URL(this.url).pathname === '/session/connect') {
              delayEcho(this, 750, data => typeof data === 'string' && JSON.parse(data).type === 'pong');
            }
          }
        };
        const PC = RTCPeerConnection; let count = 0;
        window.RTCPeerConnection = class extends PC {
          constructor(...args) { super(...args); this.oldTurn = count++ === 0; }
          async getStats(...args) { const stats = await super.getStats(...args); return this.oldTurn && window.mockTurn ? new Map([...stats].map(([id, row]) => [id, row.type === 'remote-candidate' ? { ...row, candidateType: 'relay' } : row])) : stats; }
          createDataChannel(label, options) {
            const channel = super.createDataChannel(label, options);
            if (this.oldTurn && label === 'codex-health') {
              delayEcho(channel, 350, data => data instanceof ArrayBuffer && data.byteLength === 4);
            }
            return channel;
          }
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
        constructor(...args) { super(...args); this.previousPath = window.servicePeers.length === 0; window.servicePeers.push(this); }
        createDataChannel(label, options) {
          const channel = super.createDataChannel(label, options);
          // Make the candidate unambiguously better before testing the file
          // admission fence. Loopback jitter or unknown route diagnostics may
          // otherwise legitimately keep the current peer without a handoff.
          if (label === 'codex-health' && this.previousPath) channel.addEventListener('message', event => {
            if (!event.isTrusted) return;
            event.stopImmediatePropagation(); setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: event.data })), 250);
          });
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
