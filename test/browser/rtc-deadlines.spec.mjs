import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
test('native stats stay bounded across closed peers and recover admission only after actual settlement', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  try {
    await page.route('**/stats-budget.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stats admission</title>' }));
    await page.goto(app.config.origin + '/stats-budget.html');
    const result = await page.evaluate(async () => {
      const { desktopTransport } = await import('/rtc-transport.js');
      const original = RTCPeerConnection.prototype.getStats, releases = [], events = [];
      let pending = 0, calls = 0, peak = 0;
      RTCPeerConnection.prototype.getStats = () => { calls++; pending++; peak = Math.max(peak, pending); return new Promise(resolve => releases.push(() => { pending--; resolve(new Map()); })); };
      const open = () => desktopTransport('stats-budget', () => {}, { service: true, probe: true, bootstrap: () => ({ webrtc: true, csrf: 'test-only-stats', rtcStunUrl: '' }), trace: (type, detail) => events.push({ type, ...detail }) });
      try {
        for (let n = 0; n < 7; n++) { const peer = await open(); await peer.stats(); peer.close(); }
        const saturated = { calls, pending, peak, skipped: events.filter(event => event.type === 'rtc-stats-busy') };
        releases.shift()(); await new Promise(resolve => setTimeout(resolve, 0));
        const fresh = await open(); await fresh.stats(); fresh.close();
        return { saturated, afterSettlement: { calls, pending, peak } };
      } finally { for (const release of releases) release(); RTCPeerConnection.prototype.getStats = original; }
    });
    expect(result.saturated).toMatchObject({ calls: 4, pending: 4, peak: 4 });
    expect(result.saturated.skipped).toHaveLength(3); expect(result.saturated.skipped.every(event => event.pendingStats === 4)).toBe(true);
    expect(result.afterSettlement).toEqual({ calls: 5, pending: 4, peak: 4 });
  } finally { await app.close(); }
});

test('real service rechecks keep controls usable with saturated stats and can read again after a closed candidate settles', async ({ page }) => {
  const app = await fixture({ webrtc: true });
  try {
    await page.route('**/service-stats-budget.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Service stats admission</title>' }));
    await page.goto(app.config.origin + '/service-stats-budget.html');
    await page.evaluate(async ({ username, password }) => {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }), settings = await response.json();
      window.originalStats = RTCPeerConnection.prototype.getStats; window.pendingStats = 0; window.statsCalls = 0; window.peakStats = 0; window.statsReleases = [];
      RTCPeerConnection.prototype.getStats = () => { window.statsCalls++; window.pendingStats++; window.peakStats = Math.max(window.peakStats, window.pendingStats); return new Promise(resolve => window.statsReleases.push(() => { window.pendingStats--; resolve(new Map()); })); };
      const { createServiceLink } = await import('/service-link.js');
      window.statsService = createServiceLink({ viewer: 'b'.repeat(32), options: () => settings, changed() {} }); window.statsService.start();
    }, { username: app.config.username, password: app.config.password });
    await expect.poll(() => page.evaluate(() => window.statsService.ready), { timeout: 10000 }).toBe(true);
    for (let n = 0; n < 4; n++) await page.evaluate(() => window.statsService.recheck());
    expect(await page.evaluate(() => ({ calls: window.statsCalls, pending: window.pendingStats, peak: window.peakStats, ready: window.statsService.ready }))).toEqual({ calls: 4, pending: 4, peak: 4, ready: true });
    expect(await page.evaluate(async () => (await window.statsService.request('files', {})).files)).toEqual([]);
    await page.evaluate(async () => { window.statsReleases.splice(1, 1)[0](); await new Promise(resolve => setTimeout(resolve, 0)); await window.statsService.recheck(); });
    expect(await page.evaluate(() => ({ calls: window.statsCalls, pending: window.pendingStats, peak: window.peakStats, ready: window.statsService.ready }))).toEqual({ calls: 5, pending: 4, peak: 4, ready: true });
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally {
    await page.evaluate(() => { window.statsService?.stop(); for (const release of window.statsReleases || []) release(); if (window.originalStats) RTCPeerConnection.prototype.getStats = window.originalStats; }).catch(() => {});
    await app.close();
  }
});

async function queued(page, app) {
  await page.route('**/deadline-audit.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>RTC deadline regression</title>' }));
  await page.goto(app.config.origin + '/deadline-audit.html'); await page.clock.install();
  await page.evaluate(async ({ username, password }) => {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!response.ok) throw Error('Login failed');
    const settings = await response.json();
    const { requestRTCOffer } = await import('/rtc-offers.js');
    const { desktopTransport } = await import('/rtc-transport.js');
    window.events = []; window.releasePermit = await requestRTCOffer();
    window.transport = await desktopTransport('deadline-audit', () => {}, { service: true, probe: true, bootstrap: () => settings,
      trace: (type, detail) => window.events.push({ type, ...detail }) });
    window.negotiation = window.transport.start().then(() => { window.result = 'ready'; }, error => { window.result = error.reason; });
  }, { username: app.config.username, password: app.config.password });
  await expect.poll(() => page.evaluate(() => window.events.some(event => event.type === 'rtc-stage' && event.stage === 'queued'))).toBe(true);
}
async function close(page, app) {
  await page.evaluate(() => { window.releasePermit?.(); window.transport?.close(); }).catch(() => {}); await app.close();
}
test('an offer admitted near the queue deadline still receives a fresh HTTP signaling budget', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let received = false, release;
  const response = new Promise(resolve => { release = resolve; });
  await page.route('**/api/service/rtc', async route => { received = true; await response; await route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }).catch(() => {}); });
  try {
    await queued(page, app); await page.clock.runFor(11000); await page.evaluate(() => window.releasePermit());
    await expect.poll(() => received).toBe(true); await page.clock.runFor(3000);
    expect(await page.evaluate(() => window.result)).toBeUndefined(); release();
    await expect.poll(() => page.evaluate(() => window.result)).toBe('auth');
    expect(await page.evaluate(() => window.events.some(event => event.reason?.endsWith('timeout')))).toBe(false);
  } finally { release(); await close(page, app); }
});
test('queue expiry reports local admission timeout without sending an SDP request', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let offers = 0;
  await page.route('**/api/service/rtc', route => { offers++; return route.fulfill({ status: 403, body: '{}' }); });
  try {
    await queued(page, app); await page.clock.runFor(12000);
    await expect.poll(() => page.evaluate(() => window.result)).toBe('queue-timeout'); expect(offers).toBe(0);
    expect(await page.evaluate(() => window.events.find(event => event.type === 'path-lost'))).toMatchObject({ stage: 'queued', reason: 'queue-timeout' });
  } finally { await close(page, app); }
});
test('separate phase budgets cannot extend the total negotiation lifetime', async ({ page }) => {
  const app = await fixture({ webrtc: true }); let received = false, release;
  const response = new Promise(resolve => { release = resolve; });
  await page.addInitScript(() => {
    RTCPeerConnection.prototype.setRemoteDescription = () => new Promise(() => {});
  });
  await page.route('**/api/service/rtc', async route => { received = true; await response; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'answer', sdp: '' }) }).catch(() => {}); });
  try {
    await queued(page, app); await page.clock.runFor(11000); await page.evaluate(() => window.releasePermit());
    await expect.poll(() => received).toBe(true); await page.clock.runFor(11000); release();
    await expect.poll(() => page.evaluate(() => window.events.some(event => event.stage === 'connecting'))).toBe(true);
    await page.clock.runFor(10000);
    await expect.poll(() => page.evaluate(() => window.result)).toBe('negotiation-timeout');
    expect(await page.evaluate(() => window.events.filter(event => event.type === 'path-lost'))).toEqual([expect.objectContaining({ stage: 'connecting', reason: 'negotiation-timeout' })]);
  } finally { release(); await close(page, app); }
});
