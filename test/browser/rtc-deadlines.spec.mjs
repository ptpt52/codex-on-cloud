import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
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
