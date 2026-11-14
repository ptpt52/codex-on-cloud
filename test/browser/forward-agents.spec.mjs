import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, helper, add, until } from './forward-support.mjs';
test.use({ serviceWorkers: 'block' });

test('a helper becoming online during a save press does not cancel the click or submit twice', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let peer, release;
  let saved = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/forward/agents/rule') saved++; });
  try {
    await login(page, app); await open(page); const agent = await choose(page, 1);
    await page.locator('#forward-rule-add').click(); await page.locator('#forward-rule-name').fill('上线时保存');
    const gate = new Promise(resolve => { release = resolve; }); let started;
    const waiting = new Promise(resolve => { started = resolve; });
    await page.route('**/api/forward/agents', async route => { started(); await gate; await route.continue(); });
    peer = await helper(app, agent.key);
    await page.locator('#forward-refresh').dispatchEvent('click'); await waiting;
    const button = page.locator('#forward-create'); await expect(button).toBeEnabled(); await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    release(); await expect(page.locator('#forward-agent-connection')).toHaveText('助手在线'); await page.mouse.up();
    await expect(page.locator('#forward-rule-dialog')).toBeHidden();
    await expect(page.locator('#forward-agent-rules')).toContainText('上线时保存'); expect(saved).toBe(1);
    expect(app.inputCalls).toEqual([]);
  } finally { release?.(); peer?.close(); await app.close(); }
});

test('eight fixed slots show stable keys and only the selected helper rules; modal edits and refresh isolate helpers', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }), peers = [];
  try {
    await login(page, app); await open(page); expect(await page.locator('#forward-agent-tabs [role=tab]').count()).toBe(8);
    expect(await page.locator('#forward-agent-create-form').count()).toBe(0); expect(await page.locator('#forward-code').count()).toBe(0);
    const a = await choose(page, 1); peers.push(await helper(app, a.key)); await add(page, 'A 的 SSH'); await expect(page.locator('#forward-agent-rules')).toContainText('已生效');
    const b = await choose(page, 2); peers.push(await helper(app, b.key)); await add(page, 'B 的 SSH');
    await expect(page.locator('#forward-agent-rules')).not.toContainText('A 的 SSH'); expect((await choose(page, 1)).key).toBe(a.key);
    await page.getByRole('button', { name: '编辑规则', exact: true }).click(); await page.locator('#forward-rule-name').fill('A 新名称'); await page.locator('#forward-create').click();
    await expect(page.locator('#forward-rule-dialog')).not.toBeVisible(); await expect(page.locator('#forward-agent-rules')).toContainText('A 新名称');
    await page.getByRole('button', { name: '停用规则', exact: true }).click(); await page.locator('#forward-agent-confirm-accept').click(); await expect(page.locator('#forward-agent-rules')).toContainText('已停用');
    await page.getByRole('button', { name: '启用规则', exact: true }).click(); await expect(page.locator('#forward-agent-rules')).toContainText('已生效');
    await page.locator('#forward-agent-rekey').click(); await expect(page.locator('#forward-agent-confirm-cancel')).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('#forward-agent-confirm')).not.toBeVisible(); expect(await page.locator('#forward-agent-key').inputValue()).toBe(a.key);
    await page.locator('#forward-agent-rekey').click(); await page.locator('#forward-agent-confirm-accept').click(); await expect(page.locator('#forward-agent-key')).not.toHaveValue(a.key); await until(() => peers[0].ws.readyState === 3);
    await expect(page.locator('#forward-agent-rules')).toContainText('A 新名称'); expect((await choose(page, 2)).key).toBe(b.key); await expect(page.locator('#forward-agent-rules')).toContainText('B 的 SSH'); expect(peers[1].ws.readyState).toBe(1);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]);
  } finally { for (const peer of peers) peer.close(); await app.close(); }
});

test('keys include node scope, clear on close or takeover, and are readable again without being regenerated', async ({ page, context }) => {
  const app = await fixture({ rfb: true, nodeId: 'a'.repeat(32), entryBasePath: '/node/office/' });
  try {
    await login(page, app); await open(page); const a = await choose(page, 8); expect(a.server).toBe(app.config.origin + '/node/office/'); expect(a.node).toBe('a'.repeat(32));
    await page.locator('#forward-close').click(); await expect(page.locator('#forward-agent-key')).toHaveValue(''); await open(page); expect((await choose(page, 8)).key).toBe(a.key);
    const other = await context.newPage(); await other.goto(app.config.origin + '/node/office/'); await expect(other.locator('#connection-status')).toContainText('在线');
    await expect(page.locator('#forward-agent-key')).toHaveValue('', { timeout: 10000 }); await expect(page.locator('#forward-agent-section')).toBeHidden(); await other.close();
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('tabs keep the longest visible prefix and put only the remaining assistants in a final dropdown', async ({ page }) => {
  const app = await fixture({ rfb: true });
  try {
    await page.setViewportSize({ width: 1280, height: 900 }); await login(page, app); await open(page);
    await expect(page.locator('#forward-agent-tab-8')).toBeVisible(); await expect(page.locator('#forward-agent-overflow')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#forward-agent-overflow')).toBeVisible();
    const slots = await page.locator('#forward-agent-tabs button').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => n.dataset.slot));
    expect(slots.length).toBeGreaterThan(0); expect(slots.length).toBeLessThan(8); expect(slots).toEqual(Array.from({ length: slots.length }, (_, i) => String(i + 1)));
    const options = await page.locator('#forward-agent-overflow option').evaluateAll(nodes => nodes.map(n => n.value).filter(Boolean)); expect(options).toEqual(Array.from({ length: 8 - slots.length }, (_, i) => String(slots.length + i + 1)));
    const a = await choose(page, 8); expect(a.agent).toBeTruthy(); await expect(page.locator('#forward-agent-overflow')).toHaveValue('8');
    expect(await page.locator('#forward-agent-bar').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 }); await expect(page.locator('#forward-agent-overflow')).toBeHidden(); await expect(page.locator('#forward-agent-tab-8')).toHaveAttribute('aria-selected', 'true');
  } finally { await app.close(); }
});

test('later connections using the same key cannot replace the online helper', async ({ page }) => {
  const app = await fixture({ rfb: true }); let peer;
  try {
    await login(page, app); await open(page); const a = await choose(page, 1); peer = await helper(app, a.key);
    await expect(page.locator('#forward-agent-connection')).toContainText('助手在线'); await expect(helper(app, a.key)).rejects.toThrow(/409/);
    expect(peer.ws.readyState).toBe(1); await expect(page.locator('#forward-agent-connection')).toContainText('助手在线');
  } finally { peer?.close(); await app.close(); }
});

test('helper status refreshes after disconnect even when the download list fails', async ({ page }) => {
  const app = await fixture({ rfb: true }); let peer;
  try {
    await login(page, app); await open(page); const a = await choose(page, 1); peer = await helper(app, a.key);
    await expect(page.locator('#forward-agent-connection')).toHaveText('助手在线');
    await page.route('**/api/forward', route => route.fulfill({ status: 503, json: { error: '下载列表暂不可用' } }));
    peer.close();
    await until(() => peer.ws.readyState === 3);
    await expect(page.locator('#forward-agent-connection')).toHaveText('助手离线', { timeout: 10000 });
    await expect(page.locator('#forward-agent-tab-1')).toHaveAttribute('data-online', 'false');
    await expect(page.locator('#forward-agent-inventory-refresh')).toBeDisabled();
    expect(app.inputCalls).toEqual([]);
  } finally { peer?.close(); await app.close(); }
});

test('failed helper status reads show unconfirmed status and recover without retaining a stale online badge', async ({ page }) => {
  const app = await fixture({ rfb: true }); let peer;
  try {
    await login(page, app); await open(page); const a = await choose(page, 1); peer = await helper(app, a.key);
    await expect(page.locator('#forward-agent-connection')).toHaveText('助手在线');
    await page.route('**/api/forward/agents', route => route.fulfill({ status: 503, json: { error: '助手状态暂不可用' } }));
    await page.locator('#forward-refresh').click();
    await expect(page.locator('#forward-agent-connection')).toHaveText('助手状态未确认');
    await expect(page.locator('#forward-agent-tab-1')).toHaveAttribute('data-online', 'unknown');
    await expect(page.locator('#forward-agent-inventory-refresh')).toBeDisabled();
    await expect(page.locator('#forward-agent-key')).toHaveValue(a.key);
    await page.unroute('**/api/forward/agents'); peer.close();
    await expect(page.locator('#forward-agent-connection')).toHaveText('助手离线', { timeout: 10000 });
    await expect(page.locator('#forward-agent-tab-1')).toHaveAttribute('data-online', 'false');
    await expect(page.locator('#forward-agent-key')).toHaveValue(a.key);
  } finally { peer?.close(); await app.close(); }
});

test('per-helper mock diagnostics distinguish new routes from existing mixed connections and never copy keys or addresses', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let peer;
  try {
    await page.route('**/api/forward/agents', async route => { const response = await route.fetch(), data = await response.json();
      for (const a of data.agents) for (const r of a.rules) if (r.mapping?.state === 'active') { r.mapping.direct = { available: r.name === '直连规则', family: 'IPv6', rttMs: 23 }; r.mapping.connections = 2; r.mapping.directConnections = r.name === '直连规则' ? 1 : 0; if(r.name==='中转规则'){r.mapping.errorCode='target_unavailable';r.mapping.error='目标服务连接失败';r.mapping.targetStatus={state:'failed'};} }
      await route.fulfill({ response, json: data });
    });
    await login(page, app); await open(page); const a = await choose(page, 1); peer = await helper(app, a.key); await add(page, '直连规则'); await add(page, '中转规则');
    await expect(page.locator('#forward-agent-network')).toContainText('直连 1 / 中转 3');await expect(page.locator('#forward-agent-rules')).toContainText('最近连接错误：目标服务连接失败'); await expect(page.locator('#forward-agent-rules')).toContainText('IPv6 / UDP 加密直连 · 23 ms');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.managedReport = value; } } }));
    await page.locator('#forward-diagnostics-copy').click(); const report = await page.evaluate(() => window.managedReport); expect(report).toContain('新连接 直连');
    for (const value of [a.key, a.agent, '192.168.1.23', 'COM3', '直连规则']) expect(report).not.toContain(value);
    await choose(page, 2); await expect(page.locator('#forward-agent-network')).toContainText('直连 0 / 中转 0'); await expect(page.locator('#forward-agent-rules')).not.toContainText('直连规则');
  } finally { peer?.close(); await app.close(); }
});

test('a delayed key response cannot replace the key belonging to a subsequently selected assistant', async ({ page }) => {
 const app=await fixture({rfb:true});let release;
 try {
  await login(page,app);await open(page);const first=await choose(page,1);const second=await choose(page,2);const third=await choose(page,3);await choose(page,1);
  const gate=new Promise(resolve=>{release=resolve;});let intercepted=false;
  await page.route('**/api/forward/agents/key?id='+second.agent,async route=>{intercepted=true;const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>{});});
  await page.locator('#forward-agent-tab-2').click();await until(()=>intercepted);await expect(page.locator('#forward-agent-key')).toHaveValue('');
  expect((await choose(page,3)).key).toBe(third.key);release();await expect(page.locator('#forward-agent-key')).toHaveValue(third.key);expect(first.key).not.toBe(third.key);
 } finally {release?.();await app.close();}
});
