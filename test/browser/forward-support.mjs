import { expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
export const until = async probe => { const end = Date.now() + 8000; while (!await probe()) { if (Date.now() > end) throw Error('helper fixture deadline'); await new Promise(r => setTimeout(r, 20)); } };
export const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
export async function login(page, app) { await page.goto(app.config.origin + app.config.entryBasePath); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click(); await expect(page.locator('#connection-status')).toContainText('在线'); }
export async function open(page) { await page.locator('#forward-button').click(); await expect(page.locator('#forward-agent-section')).toBeVisible(); await expect(page.locator('#forward-agent-key')).not.toHaveValue(''); }
export async function choose(page, slot) {
  const tab = page.locator('#forward-agent-tab-' + slot);
  if (await tab.isVisible()) await tab.click(); else await page.locator('#forward-agent-overflow').selectOption(String(slot));
  await expect(page.locator('#forward-agent-heading')).toHaveText('助手' + slot); await expect(page.locator('#forward-agent-key')).not.toHaveValue('');
  const key = await page.locator('#forward-agent-key').inputValue(); return { key, ...JSON.parse(Buffer.from(key.slice(6), 'base64url')) };
}
// Real control/per-rule sockets; devices are mocks. Actual Go/Pion is covered
// by test:forward:agents, with no production desktop or serial device.
export async function helper(app, key, ports = ['COM3']) {
  const grant = JSON.parse(Buffer.from(key.slice(6), 'base64url')), maps = new Map(), messages = [];
  const path = suffix => app.config.origin.replace('http:', 'ws:') + (app.config.entryBasePath === '/' ? '' : app.config.entryBasePath.replace(/\/$/, '')) + suffix;
  const headers = { origin: app.config.origin, ...(grant.node ? { 'x-codex-forward-node': grant.node } : {}) };
  const ws = new WebSocket(path('/forward/agent'), 'codex-agent-v2', { headers: { ...headers, authorization: 'Bearer ' + grant.agent + '.' + grant.secret, 'x-codex-agent-instance': randomBytes(16).toString('hex') } });
  const value = { ws, maps, messages, inventory: { type: 'inventory', serialPorts: ports, interfaces: [{ name: 'Ethernet', index: 1, up: true, error: false, addresses: [{ address: '192.168.1.23', prefix: 24 }, { address: '10.0.0.23', prefix: 8 }] }, { name: 'VPN', index: 2, up: false, error: false, addresses: [] }], error: '', truncated: false }, close() { ws.terminate(); for (const socket of maps.values()) socket.terminate(); } };
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const message = JSON.parse(bytes); if (messages.length < 128) messages.push(message);
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
export async function add(page, name, { port, direction = 'forward', protocol = 'ssh', serial = '' } = {}) {
  await page.locator('#forward-rule-add').click(); await expect(page.locator('#forward-rule-dialog')).toBeVisible();
  await page.locator('#forward-rule-name').fill(name); await page.locator('#forward-local').fill(String(port || await freePort()));
  await page.locator('#forward-direction').selectOption(direction);
  if (direction === 'reverse') await page.locator('#forward-protocol').selectOption(protocol);
  if (serial) await page.locator('#forward-serial-path').fill(serial);
  await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
  await expect(page.locator('#forward-agent-rules')).toContainText(name);
}
