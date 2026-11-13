import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { rtcAddress } from '../../panel/rtc.mjs';
import { RTC_HINTS_KEY } from '../../panel/public/rtc-hints.js';
import { openInput } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
async function settings(page) {
  await page.locator('#connection-button').click();
  if (await page.locator('.direct-hints').getAttribute('open') === null) await page.locator('.direct-hints summary').click();
}
async function save(page, server, browser) {
  await page.locator('#direct-server-ip').fill(server); await page.locator('#direct-browser-ip').fill(browser);
  await page.locator('#save-direct-hints').click();
}

test('legacy global hints require explicit import and clearing affects only the current node', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', webrtc: true, fastConnect: true, seamless: true, nodeId: 'a'.repeat(32) });
  const offers = [];
  try {
    await page.addInitScript(() => {
      localStorage.setItem('codex-cloud.rtc-hints.v1', JSON.stringify({ server: '10.0.0.1' }));
      localStorage.setItem('codex-cloud.rtc-hints.v2', JSON.stringify({ version: 2, entries: [{ scope: 'node:' + 'b'.repeat(32), at: Date.now(), hints: { server: '10.0.0.2', browser: '' } }] }));
    });
    await page.route('**/api/terminal/rtc', route => { offers.push(route.request().postDataJSON()); return route.fulfill({ status: 503, json: { error: 'isolated probe unavailable' } }); });
    await login(page, app); await expect.poll(() => offers.length).toBe(1); expect(offers[0].hints).toBeUndefined();
    await settings(page); await expect(page.locator('#direct-server-ip')).toHaveValue('');
    await page.locator('#import-direct-hints').click(); await expect(page.locator('#direct-server-ip')).toHaveValue('10.0.0.1');
    await page.locator('#clear-direct-hints').click(); await expect(page.locator('#direct-server-ip')).toHaveValue('');
    const entries = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).entries, RTC_HINTS_KEY);
    expect(entries.find(item => item.scope === 'node:' + 'a'.repeat(32)).hints.server).toBe('');
    expect(entries.find(item => item.scope === 'node:' + 'b'.repeat(32)).hints.server).toBe('10.0.0.2');
    expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('optional IP hints are sent on a new probe, preserve automatic discovery and the existing terminal stream, and survive reload', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', webrtc: true, fastConnect: true, seamless: true });
  const offers = [], answers = []; let first = true;
  try {
    await page.route('**/api/terminal/rtc', async route => {
      const body = route.request().postDataJSON(); offers.push(body);
      if (first) { first = false; return route.fulfill({ status: 503, json: { error: 'initial probe unavailable' } }); }
      // Simulate an mDNS name that cannot resolve across this routed network.
      // Keep the gathered UDP ports and all authenticated ICE credentials.
      body.sdp = body.sdp.replace(/^(a=candidate:\S+ 1 udp \d+) \S+( \d+ typ host.*)$/gm, '$1 unresolved-browser-hint.local$2');
      const response = await route.fetch({ postData: JSON.stringify(body) });
      answers.push(await response.json()); await route.fulfill({ response });
    });
    await login(page, app); await expect.poll(() => offers.length).toBe(1);
    expect(offers[0].hints).toBeUndefined(); await expect(page.locator('#diag-transport')).toContainText('WebSocket');
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await openInput(page); await page.locator('#mobile-input').fill('地址更新时保留的草稿');
    await settings(page);
    await save(page, '10.123.254.253', rtcAddress());
    await expect(page.locator('#direct-hints-status')).toContainText('已保存到当前浏览器');
    await page.locator('#close-connection').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    expect(offers.at(-1).hints).toEqual({ server: '10.123.254.253', browser: rtcAddress() });
    expect(answers.at(-1).sdp).toContain(' 127.0.0.1 '); expect(answers.at(-1).sdp).toContain(' 10.123.254.253 ');
    await expect(page.locator('#mobile-input')).toHaveValue('地址更新时保留的草稿');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.terminalChildren).toHaveLength(1);
    const count = offers.length;
    await settings(page); await save(page, '10.123.254.252', '');
    await page.locator('#close-connection').click();
    await page.waitForTimeout(1300);
    expect(offers).toHaveLength(count); await expect(page.locator('#diag-transport')).toContainText('WebRTC');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(app.terminalChildren).toHaveLength(1);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).entries.find(item => item.scope === 'path:/').hints, RTC_HINTS_KEY)).toEqual({ server: '10.123.254.252', browser: '' });
    await page.reload(); await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect.poll(() => offers.length).toBe(count + 1);
    expect(offers.at(-1).hints).toEqual({ server: '10.123.254.252', browser: '' });
    await settings(page); await expect(page.locator('#direct-server-ip')).toHaveValue('10.123.254.252'); await expect(page.locator('#direct-browser-ip')).toHaveValue('');
    await save(page, '', '');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).entries.find(item => item.scope === 'path:/').hints, RTC_HINTS_KEY)).toEqual({ server: '', browser: '' });
    expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('IP hints validate locally, stay independent of display preferences, and still work when browser storage is denied', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', webrtc: true, fastConnect: true, seamless: true });
  const offers = [];
  try {
    await page.addInitScript(() => { if (window === parent) Storage.prototype.setItem = () => { throw Error('denied'); }; });
    await page.route('**/api/terminal/rtc', route => { offers.push(route.request().postDataJSON()); return route.fulfill({ status: 503, json: { error: 'probe unavailable' } }); });
    await login(page, app); await expect.poll(() => offers.length).toBe(1); await settings(page);
    await save(page, 'https://192.168.1.1', ''); await expect(page.locator('#direct-hints-status')).toContainText('节点主机 IP');
    expect(offers).toHaveLength(1);
    await save(page, '', '192.168.1.22'); await expect(page.locator('#direct-hints-status')).toContainText('仅当前页面生效');
    await page.locator('#close-connection').click();
    await expect.poll(() => offers.length, { timeout: 10000 }).toBe(2);
    expect(offers[1].hints).toEqual({ server: '', browser: '192.168.1.22' });
    expect(app.terminalChildren).toHaveLength(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

for (const seamless of [false, true]) test(`desktop ${seamless ? 'unified' : 'legacy'} negotiation sends saved hints and bad addresses preserve automatic UDP discovery`, async ({ page }) => {
  const app = await fixture({ webrtc: true, rfb: true, fastConnect: seamless, seamless });
  const offers = [];
  try {
    await page.addInitScript(({ key }) => {
      if (window === parent) localStorage.setItem(key, JSON.stringify({ version: 2, entries: [{ scope: 'path:/', at: Date.now(), hints: { server: '10.123.254.253', browser: '10.123.254.252' } }] }));
    }, { key: RTC_HINTS_KEY });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/desktop/rtc') offers.push(request.postDataJSON()); });
    await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    expect(offers).toHaveLength(1); expect(offers[0].hints).toEqual({ server: '10.123.254.253', browser: '10.123.254.252' });
    expect(app.vncConnections).toBe(1); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('updating hints during signaling leaves that negotiation snapshot and its stream intact', async ({ page }) => {
  const app = await fixture({ mode: 'terminal', webrtc: true, fastConnect: true, seamless: true });
  const offers = []; let entered, release;
  const pending = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/api/terminal/rtc', async route => {
      offers.push(route.request().postDataJSON()); entered(); await gate; await route.continue();
    });
    await login(page, app); await pending;
    const source = await page.locator('#desktop-frame').getAttribute('src');
    await settings(page); await save(page, '10.123.254.253', ''); await page.locator('#close-connection').click();
    expect(offers).toHaveLength(1); expect(offers[0].hints).toBeUndefined();
    release(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    expect(offers).toHaveLength(1); expect(app.terminalChildren).toHaveLength(1); expect(app.terminalInputs).toEqual([]);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);
  } finally { release(); await app.close(); }
});
