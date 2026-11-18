import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
// Exercise the real service client and RTC backend without an application
// viewer starting an unrelated service association in the same login.
async function isolatedService(page, app, instrument = false) {
  await page.route('**/service-audit.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body>Isolated service regression</body></html>' }));
  await page.goto(app.config.origin + '/service-audit.html');
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
