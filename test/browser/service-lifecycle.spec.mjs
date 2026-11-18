import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
// Exercise the real service client and RTC backend without an application
// viewer starting an unrelated service association in the same login.
async function isolatedService(page, app, instrument = false, clock = false) {
  await page.route('**/service-audit.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body>Isolated service regression</body></html>' }));
  await page.goto(app.config.origin + '/service-audit.html');
  if (clock) await page.clock.install();
  await page.evaluate(async ({ username, password, instrument }) => {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!response.ok) throw Error('Isolated login failed');
    const settings = await response.json(); window.serviceEvents = []; window.healthTimes = [];
    if (instrument) {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function(label, options) {
        const channel = create.call(this, label, options);
        if (label === 'codex-health') { const send = channel.send.bind(channel); channel.send = value => { if (window.healthTimes.length < 64) window.healthTimes.push(performance.now()); send(value); }; }
        return channel;
      };
    }
    const { createServiceLink } = await import('/service-link.js');
    window.serviceLink = createServiceLink({ viewer: crypto.randomUUID(), options: () => settings, changed() {}, trace(type, detail) { if (window.serviceEvents.length < 64) window.serviceEvents.push({ type, ...detail }); } });
    window.serviceLink.start();
  }, { username: app.config.username, password: app.config.password, instrument });
}
async function stop(page, app) { await page.evaluate(() => window.serviceLink?.stop()).catch(() => {}); await app.close(); }

test('hiding during a manual heartbeat releases the candidate promptly and preserves the live service', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  try {
    await isolatedService(page, app);
    await expect.poll(() => page.evaluate(() => window.serviceLink.ready)).toBe(true);
    await page.evaluate(() => {
      window.originalService = window.serviceLink.transport;
      const create = RTCPeerConnection.prototype.createDataChannel;
      window.candidatePings = 0;
      RTCPeerConnection.prototype.createDataChannel = function(label, options) {
        const channel = create.call(this, label, options);
        if (label === 'codex-health') {
          const send = channel.send.bind(channel);
          channel.send = data => { window.candidatePings++; send(data); };
          channel.addEventListener('message', event => event.stopImmediatePropagation());
        }
        return channel;
      };
      window.manualRecheck = window.serviceLink.recheck().then(() => { window.manualEnded = true; });
    });
    await expect.poll(() => page.evaluate(() => window.candidatePings), { timeout: 10000 }).toBe(1);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => page.evaluate(() => window.manualEnded), { timeout: 1000 }).toBe(true);
    expect(await page.evaluate(() => ({ same: window.originalService === window.serviceLink.transport, ready: window.serviceLink.ready, pings: window.candidatePings }))).toEqual({ same: true, ready: true, pings: 1 });
  } finally { await stop(page, app); }
});

for (const operation of ['offer', 'remote-description']) test(`a never-settling native ${operation} times out, permits foreground recovery and ignores its late result`, async ({ page }) => {
  const app = await fixture({ webrtc: true });
  await page.addInitScript(operation => {
    const method = operation === 'offer' ? 'createOffer' : 'setRemoteDescription';
    const original = RTCPeerConnection.prototype[method], local = RTCPeerConnection.prototype.setLocalDescription;
    window.nativeCalls = 0; window.retiredLocalCalls = 0;
    RTCPeerConnection.prototype[method] = async function(...args) {
      const value = await original.apply(this, args);
      if (++window.nativeCalls === 1) { if (operation === 'offer') this.retiredAuditPeer = true; await new Promise(resolve => { window.releaseNative = resolve; }); }
      return value;
    };
    RTCPeerConnection.prototype.setLocalDescription = function(...args) { if (this.retiredAuditPeer) window.retiredLocalCalls++; return local.apply(this, args); };
  }, operation);
  try {
    await isolatedService(page, app, false, true);
    await expect.poll(() => page.evaluate(() => typeof window.releaseNative)).toBe('function');
    // Native ICE uses real time. Let the held description open its channels
    // before advancing browser timers, so this does not strand an unrelated
    // server-side ICE candidate during the simulated twelve-second pause.
    if (operation === 'remote-description') await expect.poll(() => page.evaluate(() => window.serviceEvents.some(event => event.phase === 'peer' && event.state === 'connected'))).toBe(true);
    await page.clock.runFor(operation === 'offer' ? 5000 : 13000);
    expect(await page.evaluate(() => window.serviceEvents.find(event => event.type === 'path-lost' && event.stage))).toMatchObject({
      stage: operation === 'offer' ? 'gathering' : 'connecting',
      reason: operation === 'offer' ? 'gathering-timeout' : 'channel-timeout',
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(200); await page.clock.resume();
    await expect.poll(() => page.evaluate(() => window.serviceLink.ready), { timeout: 10000 }).toBe(true);
    await page.evaluate(() => { window.recoveredService = window.serviceLink.transport; window.releaseNative(); });
    await expect.poll(() => page.evaluate(() => window.nativeCalls)).toBe(2);
    expect(await page.evaluate(() => ({ stale: window.retiredLocalCalls, same: window.recoveredService === window.serviceLink.transport, ready: window.serviceLink.ready }))).toEqual({ stale: 0, same: true, ready: true });
  } finally { await page.evaluate(() => window.releaseNative?.()).catch(() => {}); await stop(page, app); }
});

test('network hint storms coalesce service probes without retiring a healthy RTC association', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  try {
    await isolatedService(page, app, true); await expect.poll(() => page.evaluate(() => window.serviceLink.ready)).toBe(true);
    await page.evaluate(() => { window.initialService = window.serviceLink.transport; });
    await page.evaluate(() => new Promise(resolve => { let n = 0; const timer = setInterval(() => { window.dispatchEvent(new Event('online')); if (++n === 20) { clearInterval(timer); resolve(); } }, 110); }));
    const state = await page.evaluate(() => ({ ready: window.serviceLink.ready, same: window.serviceLink.transport === window.initialService, lost: window.serviceEvents.filter(value => value.type === 'path-lost').length, times: window.healthTimes }));
    expect(state.ready).toBe(true); expect(state.same).toBe(true); expect(state.lost).toBe(0);
    for (let n = 2; n < state.times.length; n++) expect(state.times[n] - state.times[n - 1]).toBeGreaterThan(950);
  } finally { await stop(page, app); }
});

test('foreground service recovery survives an aborted native offer settling after the wake timer', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createOffer; window.offerCalls = 0;
    RTCPeerConnection.prototype.createOffer = async function(...args) {
      const offer = await create.apply(this, args);
      if (++window.offerCalls === 1) await new Promise(resolve => { window.releaseOffer = resolve; });
      return offer;
    };
  });
  try {
    await isolatedService(page, app); await expect.poll(() => page.evaluate(() => typeof window.releaseOffer)).toBe('function');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(5500); await page.evaluate(() => window.releaseOffer());
    await expect.poll(() => page.evaluate(() => window.serviceLink.ready), { timeout: 10000 }).toBe(true);
    expect(await page.evaluate(() => window.offerCalls)).toBe(2);
  } finally { await page.evaluate(() => window.releaseOffer?.()).catch(() => {}); await stop(page, app); }
});

test('a verified manual service recovery clears the hard stop for subsequent automatic recovery', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let deny = true, offers = 0;
  await page.route('**/api/service/rtc', route => { offers++; return deny ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'injected authorization failure' }) }) : route.continue(); });
  try {
    await isolatedService(page, app);
    await expect.poll(() => page.evaluate(() => window.serviceEvents.some(value => value.type === 'probe-stopped' && value.reason === 'auth'))).toBe(true);
    await page.evaluate(() => window.serviceLink.recheck());
    expect(await page.evaluate(() => window.serviceEvents.at(-1))).toMatchObject({ type: 'recheck-ended', result: 'failed', probe: 'stopped', probeReason: 'auth' });
    const deniedOffers = offers; await page.waitForTimeout(1200); expect(offers).toBe(deniedOffers);
    deny = false; await page.evaluate(() => window.serviceLink.recheck()); await expect.poll(() => page.evaluate(() => window.serviceLink.ready)).toBe(true);
    expect(await page.evaluate(() => window.serviceEvents.at(-1))).toMatchObject({ type: 'recheck-ended', result: 'selected', probe: 'ready' });
    const recoveredOffers = offers; await page.evaluate(() => window.serviceLink.transport.close());
    await expect.poll(() => offers, { timeout: 10000 }).toBeGreaterThan(recoveredOffers);
    await expect.poll(() => page.evaluate(() => window.serviceLink.ready)).toBe(true);
  } finally { await stop(page, app); }
});
