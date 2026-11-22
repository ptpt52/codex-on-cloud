import { test, expect } from '@playwright/test';
import { gatewayHTTPFixture } from '../gateway-http-fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });
async function control(page, h) {
  if (!page.url().includes('/__nodes/')) await page.goto(h.origin + '/__nodes/');
  await expect.poll(async () => await page.locator('#login').isVisible() || await page.locator('#workspace').isVisible()).toBe(true);
  if (await page.locator('#login').isVisible()) { await expect(page.locator('#gateway-username')).toHaveValue('admin@gateway'); await page.locator('#password').fill(h.password); await page.locator('#login-submit').click(); }
  await expect(page.locator('#workspace')).toBeVisible();
}
async function choose(page, node) {
  await page.locator(`[data-node-id="${node.gatewayEntry.id}"] [data-action="select"]`).click(); await expect(page.locator('#confirmation')).toBeVisible();
  await expect(page.locator('#cancel')).toBeFocused(); await page.locator('#accept').click();
}
async function nodeLogin(page, app) {
  await expect(page.locator('#login-view')).toBeVisible(); await expect(page.locator('#username')).toHaveValue('admin@' + app.gatewayEntry.name.replace(' ', '-') + '-' + app.config.nodeId.slice(0, 8)); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
}
async function leaveNode(page) { if (await page.locator('#files-dialog').isVisible()) await page.locator('#close-files').click(); await closePanels(page); await openTools(page); await page.locator('#gateway-switch-button').click(); await expect(page).toHaveURL(/\/__nodes\//); }

// Keep an actual HTTP response pending even if pagehide aborts its controller,
// so these cases also exercise late success/401 callbacks after restoration.
async function holdGatewayResponse(page, path, method = 'POST') {
  await page.evaluate(({ path, method }) => {
    const original = window.fetch.bind(window); let held = false;
    window.gatewayResponseReady = window.gatewayResponseRead = false;
    window.fetch = async (url, options = {}) => {
      if (held || url !== '/__nodes/api/' + path || (options.method || 'GET') !== method) return original(url, options);
      held = true;
      const response = await original(url, { ...options, signal: undefined });
      const text = await response.text();
      await new Promise(resolve => { window.releaseGatewayResponse = resolve; window.gatewayResponseReady = true; });
      return { status: response.status, ok: response.ok, async json() { window.gatewayResponseRead = true; return JSON.parse(text); } };
    };
  }, { path, method });
}
async function cachedHide(page) { await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); }
async function cachedShow(page) { await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); }
async function releaseGatewayResponse(page) {
  await page.evaluate(() => window.releaseGatewayResponse());
  await page.waitForFunction(() => window.gatewayResponseRead);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

test('refresh retires the previous node probes and ignores a late unauthorized reply', async ({ page }) => {
  const h = await gatewayHTTPFixture(); await h.add(1); await h.add(2);
  try {
    await page.addInitScript(() => {
      const fetchOriginal = window.fetch.bind(window);
      window.gatewayProbes = [];
      window.fetch = (url, options) => {
        if (url !== '/__nodes/api/probe') return fetchOriginal(url, options);
        return new Promise(resolve => window.gatewayProbes.push({ signal: options.signal, resolve }));
      };
    });
    await control(page, h);
    await expect.poll(() => page.evaluate(() => window.gatewayProbes.length)).toBe(2);
    await page.locator('#refresh').click();
    await expect.poll(() => page.evaluate(() => window.gatewayProbes.length)).toBe(4);
    expect(await page.evaluate(() => window.gatewayProbes.map(probe => probe.signal.aborted))).toEqual([true, true, false, false]);

    await page.evaluate(() => {
      window.gatewayProbes[0].resolve(new Response('{}', { status: 401 }));
      window.gatewayProbes[1].resolve(Response.json({ ready: true }));
      for (const probe of window.gatewayProbes.slice(2)) probe.resolve(Response.json({ ready: false, checkedAt: null }));
    });
    await expect(page.locator('.node-health')).toHaveText(['当前不可用', '当前不可用']);
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#login')).toBeHidden();
  } finally { await h.close(); }
});

test('an unsuccessful refresh keeps the previous node list and shows the read error', async ({ page }) => {
  const h = await gatewayHTTPFixture(); await h.add(1); await h.add(2);
  try {
    await control(page, h);
    await page.route('**/__nodes/api/nodes?offset=0', route => route.fulfill({ status: 503, json: { error: '节点列表暂不可用' } }), { times: 1 });
    await page.locator('#refresh').click();
    await expect(page.locator('#refresh')).toBeEnabled();
    await expect(page.locator('#status')).toHaveText('节点列表暂不可用');
    await expect(page.locator('#nodes .node-row')).toHaveCount(2);
  } finally { await h.close(); }
});

test('cached gateway returns recover interrupted loads and ignore retired success and 401 responses', async ({ page }) => {
  const h = await gatewayHTTPFixture(); await h.add(1); const b = await h.add(2);
  try {
    await control(page, h); await expect(page.locator('#refresh')).toBeEnabled();
    for (const status of [200, 401]) {
      if (status === 401) await page.route('**/__nodes/api/nodes?offset=0', route => route.fulfill({ status: 401, json: { error: 'retired session' } }), { times: 1 });
      await holdGatewayResponse(page, 'nodes?offset=0', 'GET');
      await page.locator('#refresh').click(); await page.waitForFunction(() => window.gatewayResponseReady);
      await cachedHide(page); await cachedShow(page);
      await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#refresh')).toBeEnabled();
      await releaseGatewayResponse(page);
      await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#refresh')).toBeEnabled();
      await expect(page.locator('#login')).toBeHidden(); await expect(page.locator('#status')).toContainText('已重新核对');
    }
    await page.locator(`[data-node-id="${b.gatewayEntry.id}"] [data-action="select"]`).click();
    await expect(page.locator('#confirmation')).toBeVisible(); await cachedHide(page); await cachedShow(page);
    await expect(page.locator('#confirmation')).toBeHidden(); await expect(page.locator('#refresh')).toBeEnabled();
    h.storage.value.sessions = [];
    await cachedHide(page); await cachedShow(page);
    await expect(page.locator('#login')).toBeVisible(); await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#login-submit')).toBeEnabled();
  } finally { await h.close(); }
});

for (const kind of ['switch', 'remove', 'code', 'login']) test(`cached gateway retires a pending ${kind} without replay, stale navigation or restored secrets`, async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  const path = kind === 'code' ? 'codes' : kind === 'remove' ? 'nodes/' + b.gatewayEntry.id : kind;
  const method = kind === 'remove' ? 'DELETE' : 'POST'; let writes = 0, afterRestore = false, resumedWrites = 0;
  let releaseRead;
  try {
    if (kind === 'login') { await page.goto(h.origin + '/__nodes/'); await expect(page.locator('#login')).toBeVisible(); }
    else { await control(page, h); await expect(page.locator('#refresh')).toBeEnabled(); }
    await holdGatewayResponse(page, path, method);
    page.on('request', request => {
      if (!request.url().includes('/__nodes/api/') || request.method() === 'GET') return;
      if (afterRestore) resumedWrites++;
      if (new URL(request.url()).pathname === '/__nodes/api/' + path && request.method() === method) writes++;
    });
    if (kind === 'login') { await page.locator('#password').fill(h.password); await page.locator('#login-submit').click(); }
    else if (kind === 'code') { await page.locator('#enrollment summary').click(); await page.locator('#code-name').fill('缓存恢复测试'); await page.locator('#create-code').click(); }
    else if (kind === 'switch') await choose(page, b);
    else { await page.locator(`[data-node-id="${b.gatewayEntry.id}"] [data-action="remove"]`).click(); await page.locator('#accept').click(); }
    await page.waitForFunction(() => window.gatewayResponseReady);
    const readHeld = new Promise(resolve => { releaseRead = resolve; });
    await page.route('**/__nodes/api/nodes?offset=0', async route => { await readHeld; await route.continue().catch(() => {}); });
    await cachedHide(page); afterRestore = true; await cachedShow(page);
    await releaseGatewayResponse(page);
    await expect(page.locator('#refresh')).toBeDisabled(); await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#password')).toHaveValue(''); await expect(page.locator('#code-value')).toHaveValue('');
    releaseRead(); await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#refresh')).toBeEnabled();
    await expect(page.locator('#new-code')).toBeHidden(); await expect(page).toHaveURL(/\/__nodes\//);
    expect(writes).toBe(1); expect(resumedWrites).toBe(0);
    if (kind === 'switch') expect(h.storage.value.activeId).toBe(b.gatewayEntry.id);
    if (kind === 'remove') await expect(page.locator(`[data-node-id="${b.gatewayEntry.id}"]`)).toHaveCount(0);
    expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
  } finally { releaseRead?.(); await h.close(); }
});

test('web selection keeps one URL while independent logins and same-pane drafts survive A to B to A', async ({ page, context }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2);
  try {
    await control(page, h); await expect(page.locator('#nodes .node-row')).toHaveCount(2); await choose(page, a); await nodeLogin(page, a);
    await expect(page.locator('#portal-settings-button, #servers-button, #portal-settings-dialog, #servers-dialog')).toHaveCount(0);
    await openInput(page); await page.locator('#mobile-input').fill('节点 A 的草稿'); await leaveNode(page);
    await control(page, h); await choose(page, b); await nodeLogin(page, b); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await page.locator('#mobile-input').fill('节点 B 的草稿'); await leaveNode(page); await control(page, h); await choose(page, a);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('节点 A 的草稿');
    const cookies = await context.cookies(h.origin); expect(cookies.filter(cookie => cookie.name.startsWith('coc_session_'))).toHaveLength(2);
    expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]); expect(a.managementStats.restarts + b.managementStats.restarts).toBe(0);
  } finally { await h.close(); }
});

test('an unavailable active node leaves the independent selector reachable and an unavailable target cannot replace it', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    a.backendOnline = false; await page.goto(h.origin); await expect(page).toHaveURL(/\/__nodes\//); await control(page, h);
    b.backendOnline = false; await choose(page, b); await expect(page.locator('#status')).toContainText('未就绪');
    expect(h.storage.value.activeId).toBe(a.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
    b.backendOnline = true; await choose(page, b); await nodeLogin(page, b); expect(h.storage.value.activeId).toBe(b.gatewayEntry.id);
  } finally { await h.close(); }
});

test('file bytes stream to the selected node and a stale download cannot read another node with a valid login', async ({ page, context }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    await page.goto(h.origin); await nodeLogin(page, a); await page.locator('#files-button').click();
    await page.locator('#upload-input').setInputFiles({ name: 'node.txt', mimeType: 'text/plain', buffer: Buffer.from('content A') }); await expect(page.locator('#upload-status')).toContainText('上传完成：node.txt');
    const oldLink = await page.locator('#file-list a').getAttribute('href'); const first = await context.request.get(h.origin + oldLink); expect(first.status()).toBe(200); expect(await first.text()).toBe('content A');
    await leaveNode(page); await control(page, h); await choose(page, b); await nodeLogin(page, b); await page.locator('#files-button').click();
    await page.locator('#upload-input').setInputFiles({ name: 'node.txt', mimeType: 'text/plain', buffer: Buffer.from('content B') }); await expect(page.locator('#upload-status')).toContainText('上传完成：node.txt');
    const fresh = await context.request.get(h.origin + await page.locator('#file-list a').getAttribute('href')); expect(await fresh.text()).toBe('content B');
    const stale = await context.request.get(h.origin + oldLink); expect(stale.status()).toBe(409); expect(await stale.json()).toMatchObject({ code: 'node_changed', outcome: 'rejected' });
    expect(a.files.get('node.txt').toString()).toBe('content A'); expect(b.files.get('node.txt').toString()).toBe('content B');
  } finally { await h.close(); }
});

test('a lost switch acknowledgement is read back without resubmission or automatic navigation', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id); let writes = 0;
  try {
    await control(page, h);
    await page.route('**/__nodes/api/switch', async route => { writes++; await route.fetch(); await route.abort('failed'); });
    await choose(page, b); await expect(page.locator('#status')).toContainText('已核对入口是'); await expect(page).toHaveURL(/\/__nodes\//);
    expect(writes).toBe(1); expect(h.storage.value.activeId).toBe(b.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
    await page.locator('#enter').click(); await nodeLogin(page, b); expect(writes).toBe(1);
  } finally { await h.close(); }
});

test('cancel preserves the default node and reusable enrollment codes can be created and revoked from the web', async ({ page }) => {
  const h = await gatewayHTTPFixture(), a = await h.add(1), b = await h.add(2); await h.select(a.gatewayEntry.id);
  try {
    await control(page, h);
    await page.locator(`[data-node-id="${b.gatewayEntry.id}"] [data-action="select"]`).click(); await page.locator('#cancel').click();
    await expect(page.locator('#confirmation')).not.toBeVisible(); expect(h.storage.value.activeId).toBe(a.gatewayEntry.id);
    await page.locator('#enrollment summary').click(); await page.locator('#code-name').fill('动态设备'); await page.locator('#create-code').click();
    await expect(page.locator('#code-value')).toHaveValue(/^cog1\./);
    const row = page.locator('#codes li').filter({ hasText: '动态设备' }); await expect(row).toBeVisible();
    await row.getByRole('button', { name: '撤销' }).click(); await expect(row).toHaveCount(0);
    expect(h.storage.value.activeId).toBe(a.gatewayEntry.id); expect(a.terminalInputs).toEqual([]); expect(b.terminalInputs).toEqual([]);
  } finally { await h.close(); }
});

test('terminal and file WebRTC remain direct through the fixed gateway without HTTP upload bodies', async ({ page }) => {
  const h = await gatewayHTTPFixture({ webrtc: true }), a = await h.add(1); await h.select(a.gatewayEntry.id); let bodies = 0;
  try {
    await page.route('**/api/files/**', route => { bodies++; return route.abort(); }); await page.goto(h.origin); await nodeLogin(page, a);
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
    await page.locator('#files-button').click(); await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /, { timeout: 15000 });
    await page.locator('#upload-input').setInputFiles({ name: 'direct.txt', mimeType: 'text/plain', buffer: Buffer.from('direct through gateway') }); await expect(page.locator('#upload-status')).toContainText('上传完成：direct.txt');
    expect(a.files.get('direct.txt').toString()).toBe('direct through gateway'); expect(bodies).toBe(0); expect(a.terminalInputs).toEqual([]);
  } finally { await h.close(); }
});
