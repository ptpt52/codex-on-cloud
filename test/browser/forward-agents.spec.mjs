import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fixture } from '../fixture.mjs';

test.use({ serviceWorkers: 'block' });
const until = async condition => { const end = Date.now() + 7000; while (!condition()) { if (Date.now() > end) throw Error('helper fixture deadline'); await new Promise(r => setTimeout(r, 20)); } };
const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const card = (page, id) => page.locator(`[data-agent-id="${id}"]`);
async function login(page, app) { await page.goto(app.config.origin + (app.config.entryBasePath || '/')); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('在线'); }
async function open(page) { await page.locator('#forward-button').click(); await expect(page.locator('#forward-agent-section')).toBeVisible(); }
async function create(page, name) {
  await page.locator('#forward-agent-name').fill(name); await page.locator('#forward-agent-create').click();
  await expect(page.locator('#forward-agent-key-label')).toContainText(name);
  const key = await page.locator('#forward-agent-key').inputValue(), grant = JSON.parse(Buffer.from(key.slice(6), 'base64url'));
  await expect(page.locator('#forward-agent-select')).toHaveValue(grant.agent);
  return { key, id: grant.agent };
}

// Management and rule sockets are real. The helper and its devices are mocked;
// actual multi-process Go/Pion forwarding is verified by test:forward:agents.
async function helper(app, key, ports = ['COM3']) {
  const grant = JSON.parse(Buffer.from(key.slice(6), 'base64url')), maps = new Map(), messages = [];
  const path = suffix => app.config.origin.replace('http:', 'ws:') + (app.config.entryBasePath === '/' ? '' : app.config.entryBasePath.replace(/\/$/, '')) + suffix;
  const headers = { origin: app.config.origin, ...(grant.node ? { 'x-codex-forward-node': grant.node } : {}) };
  const ws = new WebSocket(path('/forward/agent'), 'codex-agent-v1', { headers: { ...headers, authorization: 'Bearer ' + grant.agent + '.' + grant.secret, 'x-codex-agent-instance': randomBytes(16).toString('hex') } });
  const value = { ws, maps, messages, inventory: { type: 'inventory', serialPorts: ports, interfaces: [{ name: 'Ethernet', index: 1, up: true, error: false, addresses: [{ address: '192.168.1.23', prefix: 24 }, { address: '10.0.0.23', prefix: 8 }] }, { name: 'VPN', index: 2, up: false, error: false, addresses: [] }], error: '', truncated: false }, close() { ws.terminate(); for (const m of maps.values()) m.terminate(); } };
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const message = JSON.parse(bytes); if (messages.length < 64) messages.push(message);
    if (message.type === 'inventory-request') ws.send(JSON.stringify(value.inventory));
    if (message.type !== 'rules') return;
    const wanted = new Set(message.rules.map(r => r.mappingId));
    for (const [id, socket] of maps) if (!wanted.has(id)) { socket.terminate(); maps.delete(id); }
    for (const rule of message.rules) {
      if (maps.has(rule.mappingId)) continue;
      const socket = new WebSocket(path('/forward/helper'), 'codex-forward-v1', { headers: { ...headers, authorization: 'Bearer ' + rule.code, 'x-codex-forward-resume': '1', 'x-codex-forward-keep-streams': '1', 'x-codex-forward-reverse': '1', 'x-codex-forward-serial': '1' } }); maps.set(rule.mappingId, socket);
      socket.on('error', () => {}); socket.on('message', bytes => { const packet = JSON.parse(bytes); if (packet.type === 'ready') socket.send(JSON.stringify({ type: 'listening' })); });
    }
  });
  await once(ws, 'open'); await until(() => messages.some(m => m.type === 'agent-ready')); return value;
}
async function addForward(page, id, name, port) {
  await page.locator('#forward-agent-select').selectOption(id); await page.locator('#forward-rule-name').fill(name); await page.locator('#forward-local').fill(String(port)); await page.locator('#forward-create').click();
  await expect(card(page, id)).toContainText(name); await expect(card(page, id)).toContainText('已生效');
}

test('two helpers keep independent rules, apply edits and revocation without restarting the desktop', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }), helpers = [];
  try {
    await login(page, app); await open(page); const a = await create(page, '电脑 A'); helpers.push(await helper(app, a.key));
    await addForward(page, a.id, 'A 的 SSH', await freePort());
    const b = await create(page, '电脑 B'); helpers.push(await helper(app, b.key, ['COM8']));
    await addForward(page, b.id, 'B 的 SSH', await freePort());
    expect(await card(page, a.id).textContent()).not.toContain('B 的 SSH'); expect(await card(page, b.id).textContent()).not.toContain('A 的 SSH');
    await card(page, a.id).getByRole('button', { name: '编辑规则', exact: true }).click();
    await page.locator('#forward-local').fill(String(await freePort())); await page.locator('#forward-rule-name').fill('A 新入口'); await page.locator('#forward-create').click();
    await expect(card(page, a.id)).toContainText('A 新入口'); await expect(card(page, b.id)).toContainText('B 的 SSH');
    await card(page, a.id).getByRole('button', { name: '停用规则', exact: true }).click(); await page.locator('#forward-agent-confirm-accept').click();
    await expect(card(page, a.id)).toContainText('已停用'); await expect(card(page, b.id)).toContainText('已生效');
    await card(page, a.id).getByRole('button', { name: '启用规则', exact: true }).click(); await expect(card(page, a.id)).toContainText('已生效');
    await card(page, a.id).getByRole('button', { name: '撤销并移除助手' }).click(); await expect(page.locator('#forward-agent-confirm-cancel')).toBeFocused();
    await page.locator('#forward-agent-confirm-accept').click(); await expect(card(page, a.id)).toHaveCount(0);
    await expect(card(page, b.id)).toContainText('助手在线'); expect(helpers[1].ws.readyState).toBe(1);
    expect(app.managementStats.restarts).toBe(0); expect(app.inputCalls).toEqual([]); expect(app.vncConnections).toBe(1);
  } finally { for (const h of helpers) h.close(); await app.close(); }
});

test('serial choices and custom paths follow the selected helper while all IPv4 addresses remain visible', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let peer;
  try {
    await login(page, app); await open(page); const a = await create(page, '串口主机'); peer = await helper(app, a.key, ['COM3', 'COM7']);
    await expect(card(page, a.id).locator('summary')).toContainText('网卡 2 张'); await card(page, a.id).locator('summary').click();
    await expect(card(page, a.id)).toContainText('192.168.1.23/24（255.255.255.0）'); await expect(card(page, a.id)).toContainText('10.0.0.23/8（255.0.0.0）'); await expect(card(page, a.id)).toContainText('VPN（停用）');
    await page.locator('#forward-direction').selectOption('reverse'); await page.locator('#forward-device-name').fill('调试设备'); await page.locator('#forward-protocol').selectOption('serial');
    await expect(page.locator('#forward-serial-choice option')).toHaveCount(3); await page.locator('#forward-serial-choice').selectOption('COM7'); await expect(page.locator('#forward-serial-path')).toHaveValue('COM7');
    await page.locator('#forward-rule-name').fill('调试串口'); await page.locator('#forward-local').fill(String(await freePort())); await page.locator('#forward-create').click();
    await expect(card(page, a.id)).toContainText('COM7 @ 115200'); await expect(card(page, a.id)).toContainText('已生效');
    await card(page, a.id).getByRole('button', { name: '编辑规则' }).click(); await page.locator('#forward-serial-path').fill('COM99'); await page.locator('#forward-create').click();
    await expect(card(page, a.id)).toContainText('COM99 @ 115200');
    const count = peer.messages.filter(m => m.type === 'inventory-request').length; await card(page, a.id).getByRole('button', { name: '刷新设备信息' }).click();
    await until(() => peer.messages.filter(m => m.type === 'inventory-request').length > count); await expect(page.locator('#forward-serial-path')).toHaveValue('COM99');
    expect(app.inputCalls).toEqual([]);
  } finally { peer?.close(); await app.close(); }
});

test('keys include the node path, clear on dialog close and remain independent of browser takeover', async ({ page, context }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*', nodeId: 'a'.repeat(32), entryBasePath: '/node/office/' }); let peer;
  try {
    await login(page, app); await open(page); const a = await create(page, '保密 key'); const grant = JSON.parse(Buffer.from(a.key.slice(6), 'base64url'));
    expect(grant.server).toBe(app.config.origin + '/node/office/'); expect(grant.node).toBe('a'.repeat(32)); peer = await helper(app, a.key);
    await page.locator('#forward-close').click(); await expect(page.locator('#forward-agent-key')).toHaveValue(''); await open(page); await expect(card(page, a.id)).toContainText('助手在线');
    await card(page, a.id).getByRole('button', { name: '重新生成 key' }).click(); await page.locator('#forward-agent-confirm-accept').click(); await expect(page.locator('#forward-agent-key')).not.toHaveValue('');
    peer.close(); peer = await helper(app, await page.locator('#forward-agent-key').inputValue());
    const other = await context.newPage(); await other.goto(app.config.origin + '/node/office/'); await expect(other.locator('#connection-status')).toContainText('在线'); await expect(page.locator('#forward-agent-key')).toHaveValue('', { timeout: 10000 });
    await expect(page.locator('#forward-agent-section')).toBeHidden(); await other.close();
    expect(peer.ws.readyState).toBe(1);
    expect(app.inputCalls).toEqual([]);
  } finally { peer?.close(); await app.close(); }
});

test('mock diagnostics distinguish direct and relayed rules within each helper instead of sharing another helper path', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' }); let peer;
  try {
    await page.route('**/api/forward/agents', async route => {
      const response = await route.fetch(), data = await response.json();
      for (const agent of data.agents) for (const rule of agent.rules) if (rule.mapping?.state === 'active') {
        rule.mapping.direct = { available: rule.name === '直连规则', family: 'IPv6', rttMs: 23 };
        rule.mapping.connections = 2; rule.mapping.directConnections = rule.name === '直连规则' ? 1 : 0;
      }
      await route.fulfill({ response, json: data });
    });
    await login(page, app); await open(page); const a = await create(page, '混合路径主机'); peer = await helper(app, a.key);
    await addForward(page, a.id, '直连规则', await freePort()); await addForward(page, a.id, '中转规则', await freePort());
    await expect(card(page, a.id)).toContainText('已有数据连接：直连 1 / 中转 3'); await expect(card(page, a.id)).toContainText('1 条规则优先直连，1 条规则走中转');
    await expect(card(page, a.id)).toContainText('IPv6 / UDP 加密直连 · 23 ms'); await expect(card(page, a.id)).toContainText('WSS 加密中转');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.managedReport = value; } } }));
    await page.locator('#forward-diagnostics-copy').click();
    const report = await page.evaluate(() => window.managedReport); expect(report).toContain('常驻助手诊断'); expect(report).toContain('新连接 直连');
    for (const privateValue of [a.key, a.id, '混合路径主机', '192.168.1.23', 'COM3']) expect(report).not.toContain(privateValue);
    expect(app.inputCalls).toEqual([]);
  } finally { peer?.close(); await app.close(); }
});

test('older cached HTML without the helper management section retains explicit legacy pairing', async ({ page }) => {
  const app = await fixture({ rfb: true }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(app.config.origin + '/', async route => {
      const response = await route.fetch(), html = await response.text();
      await route.fulfill({ response, body: html.replace(/<section id="forward-agent-section"[^]*?<\/section>/, '').replace(/<label id="forward-agent-select-label"[^]*?<\/label>/, '').replace(/<dialog id="forward-agent-confirm"[^]*?<\/dialog>/, '') });
    });
    await login(page, app); await page.locator('#forward-button').click(); await expect(page.locator('#forward-create')).toBeEnabled();
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-code')).not.toHaveValue(''); expect(errors).toEqual([]);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});
