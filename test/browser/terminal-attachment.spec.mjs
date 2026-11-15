import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { closePanels, openTools, waitForTerminalLayout } from './ui.mjs';
test.use({ serviceWorkers: 'block' });
async function setup(page, { direct = false, backup = false, count = 1 } = {}) {
  await page.addInitScript(({ backup }) => {
    if (window === parent) { localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, workspaceLayout: 'top', mode: 'terminal' })); window.attachmentPaths = { peers: 0, sockets: 0 }; window.attachmentEvents = []; window.keepAttachmentRelay = backup; return; }
    if (!location.pathname.endsWith('/terminal/index.html')) return;
    const record = (path, value) => { if (['welcome', 'target-sync', 'switched'].includes(value.type)) { if (parent.attachmentEvents.length >= 64) throw Error('test event bound'); parent.attachmentEvents.push({ path, type: value.type }); } };
    const P = RTCPeerConnection; window.RTCPeerConnection = class extends P {
      constructor(...args) { super(...args); parent.attachmentPaths.peers++; window.attachmentPeer = this; }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        if (label === 'codex-stream') {
          const send = channel.send.bind(channel);
          channel.send = data => {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            let value; try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(4))); } catch {}
            if (value?.type === 'target-synced' && parent.failAttachmentSync) throw Error('injected backup send failure');
            send(data);
          };
        }
        channel.addEventListener('message', event => {
          if (label === 'codex-health' && event.isTrusted && parent.keepAttachmentRelay) {
            event.stopImmediatePropagation(); setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: event.data })), 300); return;
          }
          if (label !== 'codex-stream' || !(event.data instanceof ArrayBuffer)) return;
          try {
            const value = JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 4)));
            if (value.type === 'switched' && parent.dropAttachmentSwitch) { event.stopImmediatePropagation(); this.close(); return; }
            record('direct', value);
          } catch {}
        }); return channel;
      }
    };
    const S = WebSocket; window.WebSocket = class extends S { constructor(...args) {
      super(...args); if (new URL(this.url).pathname !== '/session/connect') return;
      parent.attachmentPaths.sockets++; window.attachmentSocket = this;
      this.addEventListener('message', event => {
        if (event.isTrusted && this.heldAttachmentMessages) {
          if (this.heldAttachmentMessages.length >= 64) throw Error('test delayed stream bound');
          this.heldAttachmentMessages.push(event.data); event.stopImmediatePropagation(); return;
        }
        const value = JSON.parse(event.data);
        if (value.type === 'target-sync' && parent.dropAttachmentSync) { event.stopImmediatePropagation(); return; }
        if (value.type === 'switched' && event.isTrusted && parent.delayAttachmentSwitch) {
          event.stopImmediatePropagation(); this.heldAttachmentMessages = [];
          setTimeout(() => {
            const held = this.heldAttachmentMessages; this.heldAttachmentMessages = undefined;
            this.dispatchEvent(new MessageEvent('message', { data: event.data }));
            for (const data of held) this.dispatchEvent(new MessageEvent('message', { data }));
          }, 200); return;
        }
        record('relay', value);
      });
    } };
  }, { backup });
  const app = await fixture({ mode: 'terminal', seamless: true, fastConnect: true, webrtc: direct || backup });
  for (let n = 1; n < count; n++) await app.controls.manageTerminals({ action: 'create', name: 'Attachment ' + n, view: 'terminal' });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  await expect.poll(() => page.frameLocator('#desktop-frame').locator('html').evaluate(() => document.querySelector('.xterm-helper-textarea')?.disabled !== true)).toBe(true);
  if (direct) { await page.locator('#connection-button').click(); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 }); await page.locator('#close-connection').click(); }
  if (direct || backup) await expect.poll(() => page.evaluate(() => window.attachmentEvents.filter(e => e.type === 'welcome').map(e => e.path).sort()), { timeout: 15000 }).toEqual(['direct', 'relay']);
  return app;
}
async function choose(page, id) {
  await closePanels(page); await waitForTerminalLayout(page);
  const tab = page.locator(`#terminal-tabs [data-terminal-choice=${id}]`);
  if (await tab.isVisible()) await tab.click(); else { await page.locator('#terminal-session-button').click(); await page.locator(`#terminal-switch-list [data-terminal-choice=${id}]`).click(); }
}
async function closeCurrent(page) {
  await closePanels(page); await waitForTerminalLayout(page);
  const action = page.locator('#terminal-tabs [data-terminal-actions=main]');
  if (await action.isVisible()) await action.click(); else await page.locator('#terminal-session-actions').click();
  await page.locator('#terminal-action-end').click(); await page.locator('#accept-confirmation').click();
}
const paths = page => page.evaluate(() => ({ ...window.attachmentPaths }));
const output = (app, text) => app.terminalChildren.at(-1).stdout.write(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }) + '\n');
for (const direct of [false, true]) {
  test(`${direct ? 'direct' : 'relay'}: closing the active terminal selects its neighbor on the retained connection`, async ({ page }) => {
    const app = await setup(page, { direct, count: 3 });
    try {
      const before = await paths(page), src = await page.locator('#desktop-frame').getAttribute('src');
      await closeCurrent(page); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
      await choose(page, 'aux2'); await expect(page.locator('#input-terminal')).toHaveValue('aux2'); await expect(page.locator('#paste-button')).toBeEnabled();
      expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src); const after = await paths(page);
      expect(direct ? after.peers : after.sockets).toBe(direct ? before.peers : before.sockets); expect(app.terminalInputs).toEqual([]);
    } finally { await app.close(); }
  });
  test(`${direct ? 'direct' : 'relay'}: closing the last terminal preserves readonly output and creates a fresh identity on the same connection`, async ({ page }) => {
    const app = await setup(page, { direct });
    try {
      output(app, 'FINAL-ATTACHMENT-SCREEN\r\n'); const frame = page.frameLocator('#desktop-frame');
      await expect(frame.locator('.xterm-rows')).toContainText('FINAL-ATTACHMENT-SCREEN');
      const before = await paths(page), src = await page.locator('#desktop-frame').getAttribute('src'), old = (await app.controls.listTerminals()).terminals[0];
      await closeCurrent(page); await expect(page.locator('#connection-status')).toContainText('终端已关闭'); await expect(frame.locator('#terminal-status')).toContainText('终端已结束');
      await expect(page.locator('#desktop-overlay')).toBeHidden(); await expect(frame.locator('.xterm-rows')).toContainText('FINAL-ATTACHMENT-SCREEN');
      await frame.locator('.xterm-helper-textarea').dispatchEvent('input', { data: 'must not send' }); expect(app.terminalInputs).toEqual([]);
      await choose(page, 'new'); await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#input-terminal')).toHaveValue('main');
      expect((await app.controls.listTerminals()).terminals[0].token).not.toBe(old.token); expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src);
      await expect(frame.locator('.xterm-rows')).not.toContainText('FINAL-ATTACHMENT-SCREEN');
      const after = await paths(page); expect(direct ? after.peers : after.sockets).toBe(direct ? before.peers : before.sockets); expect(app.terminalInputs).toEqual([]);
    } finally { await app.close(); }
  });
}
test('natural exit and helper failure retain the viewer, and only an explicit selection attaches again', async ({ page }) => {
  const app = await setup(page, { count: 2 });
  try {
    const src = await page.locator('#desktop-frame').getAttribute('src'), main = (await app.controls.listTerminals()).terminals[0];
    app.terminalChildren.at(-1).kill(); await expect(page.locator('#connection-status')).toContainText('终端附加失败');
    const attachments = app.terminalConnections; await page.waitForTimeout(1200); expect(app.terminalConnections).toBe(attachments);
    await choose(page, 'main'); await expect(page.locator('#connection-status')).toContainText('终端在线'); expect(app.terminalConnections).toBe(attachments + 1);
    await app.controls.manageTerminals({ action: 'close', terminalId: main.id, terminalToken: main.token, confirm: true, view: 'terminal' });
    await expect(page.frameLocator('#desktop-frame').locator('#terminal-status')).toContainText('终端已结束', { timeout: 7000 });
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src);
    await choose(page, 'aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect((await paths(page)).sockets).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('an unknown close result retains output without selecting or retrying until the list is verified', async ({ page }) => {
  const app = await setup(page, { count: 2 }); let closes = 0;
  try {
    output(app, 'CLOSE-UNKNOWN-SCREEN');
    const src = await page.locator('#desktop-frame').getAttribute('src');
    await page.route('**/api/terminals', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'close') return route.continue();
      closes++; await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await closeCurrent(page); await expect(page.locator('#terminals-status')).toContainText('结果未知');
    await expect(page.frameLocator('#desktop-frame').locator('.xterm-rows')).toContainText('CLOSE-UNKNOWN-SCREEN');
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(src); expect(app.terminalConnections).toBe(1);
    await openTools(page); await page.locator('#terminal-view-manage').click(); await page.locator('#refresh-terminals').click(); await page.locator('#close-terminals').click();
    await choose(page, 'aux1'); await expect(page.locator('#connection-status')).toContainText('终端在线');
    expect(closes).toBe(1); expect((await paths(page)).sockets).toBe(1); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('logout revokes a detached connection without reopening the ended task', async ({ page }) => {
  const app = await setup(page);
  try {
    await closeCurrent(page); await expect(page.frameLocator('#desktop-frame').locator('#terminal-status')).toContainText('终端已结束');
    await page.locator('#logout-button').click(); await page.locator('#accept-confirmation').click(); await expect(page.locator('#login-view')).toBeVisible();
    await page.waitForTimeout(1100); expect(app.terminalConnections).toBe(1); expect((await app.controls.listTerminals()).terminals).toEqual([]);
    expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
for (const direct of [false, true]) test(`${direct ? 'direct' : 'relay'}: both established paths survive repeated selections and recover the confirmed target`, async ({ page }) => {
  const app = await setup(page, { direct, backup: !direct, count: 3 });
  try {
    const before = await paths(page), frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    if (!direct) await page.evaluate(() => { window.delayAttachmentSwitch = true; });
    for (const id of ['aux1', 'aux2', 'main']) {
      await choose(page, id); await expect(page.locator('#input-terminal')).toHaveValue(id); await expect(page.locator('#paste-button')).toBeEnabled();
    }
    await expect.poll(() => page.evaluate(() => window.attachmentEvents.filter(e => e.type === 'target-sync').length)).toBe(3);
    if (!direct) {
      const records = await page.evaluate(() => window.attachmentEvents);
      expect(records.findIndex(e => e.type === 'target-sync')).toBeLessThan(records.findIndex(e => e.type === 'switched'));
    }
    expect(await paths(page)).toEqual(before);
    await closeCurrent(page); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#paste-button')).toBeEnabled();
    expect(await paths(page)).toEqual(before);
    await frame.evaluate(direct => { if (direct) window.attachmentPeer.close(); else window.attachmentSocket.close(); }, direct);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#paste-button')).toBeEnabled();
    await frame.locator('.xterm-helper-textarea').press('z'); await expect.poll(() => app.terminalInputs).toEqual([{ terminalId: 'aux1', text: 'z' }]);
    expect(app.terminalConnections).toBe(5); expect((await paths(page)).peers).toBe(before.peers);
    if (direct) expect((await paths(page)).sockets).toBe(before.sockets);
  } finally { await app.close(); }
});
test('a silent target synchronization replaces only the backup path', async ({ page }) => {
  const app = await setup(page, { direct: true, count: 2 });
  try {
    const before = await paths(page); await page.evaluate(() => { window.dropAttachmentSync = true; });
    await choose(page, 'aux1'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    await expect.poll(async () => (await paths(page)).sockets, { timeout: 6000 }).toBe(before.sockets + 1);
    await expect(page.locator('#connection-status')).toContainText('终端在线'); expect((await paths(page)).peers).toBe(before.peers);
    expect(app.terminalConnections).toBe(2); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('a failed early backup acknowledgement cannot close the active path', async ({ page }) => {
  const app = await setup(page, { backup: true, count: 2 });
  try {
    const before = await paths(page);
    await page.evaluate(() => { window.delayAttachmentSwitch = window.failAttachmentSync = true; });
    await choose(page, 'aux1'); await expect(page.locator('#input-terminal')).toHaveValue('aux1'); await expect(page.locator('#paste-button')).toBeEnabled();
    const frame = page.frames().find(frame => frame.url().includes('/terminal/index.html'));
    await expect.poll(() => frame.evaluate(() => window.attachmentPeer.connectionState)).toBe('closed');
    await frame.locator('.xterm-helper-textarea').press('q'); await expect.poll(() => app.terminalInputs).toEqual([{ terminalId: 'aux1', text: 'q' }]);
    expect((await paths(page)).sockets).toBe(before.sockets); expect(app.terminalConnections).toBe(2);
  } finally { await app.close(); }
});
test('backup metadata cannot resolve a target switch whose active reply was lost', async ({ page }) => {
  const app = await setup(page, { direct: true, count: 2 });
  try {
    await page.evaluate(() => { window.dropAttachmentSwitch = true; });
    await choose(page, 'aux1'); await expect(page.locator('#toast')).toContainText('结果未知', { timeout: 10000 });
    await expect(page.locator('#input-terminal')).toHaveValue('main'); const attachments = app.terminalConnections;
    await page.waitForTimeout(1200); expect(app.terminalConnections).toBe(attachments);
    expect((await app.controls.listTerminals()).terminals).toHaveLength(2); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
