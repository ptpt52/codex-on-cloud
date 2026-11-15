import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, closePanels } from './ui.mjs';
async function setup(page, app, mode = 'desktop') {
  await page.addInitScript(mode => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode }));
  }, mode);
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('在线');
  await openInput(page); await page.locator('#mobile-input').fill('缓存返回保留的草稿'); await closePanels(page);
  return page.frames().find(frame => frame.url().includes(`/${mode}/index.html`));
}
async function hide(page, frame) {
  await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#desktop-frame')).toHaveJSProperty('inert', true);
}
async function show(page, frame, terminal = false) {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  if (terminal) await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
}
for (const mode of ['desktop', 'terminal']) test(`${mode}: repeated persisted returns verify the session, retain drafts and never replay input or focus`, async ({ page }) => {
  const writes = []; let release;
  const app = await fixture({ rfb: true, seamless: true });
  page.on('request', request => { if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname); });
  try {
    let frame = await setup(page, app, mode); writes.length = 0;
    const terminalSource = await page.locator('#desktop-frame').getAttribute('src');
    if (mode === 'terminal') {
      await frame.locator('.xterm-screen').evaluate(el => { window.retainedCacheTerminal = el; });
      app.terminalChildren[0].stdout.write(JSON.stringify({ type: 'output', data: Buffer.from('\r\nCACHE-HISTORY-MARKER\r\n').toString('base64') }) + '\n');
      await expect(frame.locator('.xterm-screen')).toContainText('CACHE-HISTORY-MARKER');
    }
    for (let round = 0; round < 2; round++) {
      const source = await page.locator('#desktop-frame').getAttribute('src');
      await page.locator('#desktop-frame').evaluate(element => { window.previousCacheFrame = element; });
      await hide(page, frame);
      await page.route('**/api/state', async route => {
        await new Promise(resolve => { release = resolve; });
        await route.continue().catch(() => {});
      });
      await show(page, frame, mode === 'terminal');
      await expect.poll(() => typeof release).toBe('function');
      await expect(page.locator('#connection-status')).toHaveText('正在核对会话');
      await expect(page.locator(mode === 'desktop' ? '#terminal-mode' : '#desktop-mode')).toBeDisabled();
      await openInput(page); await expect(page.locator('#paste-button')).toBeDisabled();
      await page.locator('[data-key=Enter]').dispatchEvent('click'); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
      release(); release = undefined; await page.unroute('**/api/state');
      await expect(page.locator('#connection-status')).toContainText(mode === 'terminal' ? '终端在线' : '桌面在线');
      await expect(page.locator('#paste-button')).toBeEnabled(); await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
      frame = page.frames().find(frame => frame.url().includes(`/${mode}/index.html`));
      expect(await page.locator('#desktop-frame').evaluate(element => element === window.previousCacheFrame)).toBe(mode === 'terminal');
      if (mode === 'desktop') { expect(await page.locator('#desktop-frame').getAttribute('src')).not.toBe(source); await expect(frame.locator('#screen canvas')).toHaveCount(1); }
      else { expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(terminalSource); expect(await frame.locator('.xterm-screen').evaluate(el => el === window.retainedCacheTerminal)).toBe(true); }
      await closePanels(page);
    }
    expect(writes).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release?.(); await app.close(); }
});
for (const cause of ['takeover', 'logout', 'node', 'network', 'lock', 'malformed']) test(`persisted desktop return stays blocked after ${cause}`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await setup(page, app); const connections = app.vncConnections; await hide(page, frame);
    if (cause === 'takeover') { await app.login(); await app.claim('22222222-2222-4222-8222-222222222222'); }
    if (cause === 'lock') {
      await app.login(); await app.claim();
      expect((await app.request('/api/security/screen-lock', { method: 'POST', body: { enabled: true, password: 'cache_test_lock_123' } })).status).toBe(200);
    }
    if (cause === 'malformed') await page.route('**/api/state', route => route.fulfill({ json: { mine: true } }));
    if (cause === 'logout') await page.context().clearCookies();
    if (cause === 'node') await page.route('**/api/state', route => route.fulfill({ status: 409, json: { code: 'node_changed', error: '入口已切换' } }));
    if (cause === 'network') await page.route('**/api/state', route => route.abort());
    await show(page, frame);
    if (cause === 'logout') await expect(page.locator('#login-view')).toBeVisible();
    else {
      await expect(page.locator('#connection-status')).toContainText({ takeover: '等待接管', node: '入口已切换', network: '等待网络', lock: '屏幕已锁定', malformed: '等待网络' }[cause]);
      await expect(page.locator('#paste-button')).toBeDisabled();
      await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
    }
    expect(app.vncConnections).toBe(connections); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('actual browser back navigation restores a usable viewer whether Chrome reloads or caches the document', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    await setup(page, app); await page.goto('about:blank'); await page.goBack();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toHaveCount(1);
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿'); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});


test('a pending accepted paste stays unknown across cached return and its late result never clears or resends the draft', async ({ page }) => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, seamless: true, inputHook: () => gate });
  try {
    const frame = await setup(page, app); await openInput(page); await page.locator('#paste-button').click();
    await expect.poll(() => app.inputCalls.length).toBe(1);
    await hide(page, frame); await show(page, frame); release();
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'unknown');
    await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
    expect(app.inputCalls).toHaveLength(1); expect(app.terminalInputs).toEqual([]);
  } finally { release(); await app.close(); }
});

test('a late blank navigation from the retired desktop cannot replace its restored viewer', async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true });
  try {
    const frame = await setup(page, app);
    await page.locator('#desktop-frame').evaluate(element => { window.retiredCacheFrame = element; });
    await hide(page, frame); await show(page, frame);
    await expect(page.locator('#connection-status')).toContainText('桌面在线');
    await page.evaluate(() => { window.retiredCacheFrame.src = 'about:blank'; });
    await expect(page.locator('#desktop-frame')).toHaveAttribute('src', /\/desktop\/index\.html/);
    await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toHaveCount(1);
    await openInput(page); await expect(page.locator('#paste-button')).toBeEnabled();
    await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

for (const mode of ['desktop', 'terminal']) test(`${mode}: cached return cancels unfinished assistant composition without sending or blocking its draft`, async ({ page }) => {
  const app = await fixture({ rfb: true, seamless: true, rfbSize: { width: 640, height: 480 } });
  try {
    const frame = await setup(page, app, mode); await openInput(page);
    await expect(page.locator('#input-terminal option[value=main]')).toHaveCount(1);
    await page.locator('#mobile-input').focus();
    await page.locator('#mobile-input').dispatchEvent('compositionstart', { data: '输入中' });
    await expect(page.locator('#paste-button')).toBeDisabled();
    await hide(page, frame); await show(page, frame, mode === 'terminal');
    await expect(page.locator('#connection-status')).toContainText(mode === 'desktop' ? '桌面在线' : '终端在线');
    await expect(page.locator('#paste-button')).toBeEnabled();
    await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('cached return re-reads an interrupted initial terminal catalog before enabling its preserved draft', async ({ page }) => {
  let hold = true, release, reads = 0; const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture({ rfb: true, seamless: true, rfbSize: { width: 640, height: 480 } });
  await page.route('**/api/terminals', async route => {
    if (route.request().method() === 'GET') { reads++; if (hold) await gate; }
    await route.continue().catch(() => {});
  });
  try {
    const frame = await setup(page, app); await expect.poll(() => reads).toBe(1);
    await hide(page, frame); hold = false; release(); await show(page, frame);
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(page.locator('#input-terminal option[value=main]')).toHaveCount(1);
    await expect(page.locator('#paste-button')).toBeEnabled();
    await expect(page.locator('#mobile-input')).toHaveValue('缓存返回保留的草稿');
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { release(); await app.close(); }
});
