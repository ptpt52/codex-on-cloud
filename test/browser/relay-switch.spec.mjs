import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { openInput, openTools, closePanels } from './ui.mjs';

test.use({ serviceWorkers: 'block' });

async function login(page, app, { legacy = false } = {}) {
  await page.addInitScript(({ legacy }) => {
    if (window === parent) {
      localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'terminal', zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true, terminalInputCollapsed: true }));
      window.relaySent = []; window.relayConnections = 0; window.legacyRelay = legacy;
    }
    if (location.pathname !== '/terminal/index.html') return;
    window.relaySockets = []; window.relayPeers = [];
    let terminalConstructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => terminalConstructor, set: Native => {
      terminalConstructor = class extends Native { constructor(...args) { super(...args); window.relayTerminal = this; } };
    } });
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname !== '/session/connect') return;
        parent.relayConnections++; window.relaySockets.push(this);
        this.addEventListener('message', event => {
          const value = JSON.parse(event.data);
          if (event.isTrusted && value.type === 'welcome' && parent.legacyRelay) {
            event.stopImmediatePropagation(); delete value.terminalSwitchRelay;
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
          }
          if (value.type === 'switched' && parent.dropSwitchReply) { event.stopImmediatePropagation(); this.close(); }
        });
      }
      send(data) {
        const value = JSON.parse(data);
        if (value.type === 'switch-terminal') { if (parent.relaySent.length >= 16) throw Error('test request bound'); parent.relaySent.push(value.target); }
        super.send(data);
      }
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.relayPeers.push(this); } };
  }, { legacy });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  await expect(page.locator('#terminal-tabs [data-terminal-choice="aux1"]')).toBeAttached();
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
async function create(options = {}) {
  const app = await fixture({ rfb: true, seamless: true, fastConnect: true, ...options });
  await app.controls.manageTerminals({ action: 'create', name: '中转辅助终端', view: 'terminal' }); return app;
}
async function select(page, id) {
  await closePanels(page);
  if (await page.locator('#terminal-session-button').isVisible()) {
    const button = page.locator('#terminal-session-button');
    if (test.info().project.use.hasTouch) await button.tap(); else await button.click();
    await expect(page.locator('#terminal-switch-dialog')).toBeVisible();
    await page.locator(`#terminal-switch-list [data-terminal-choice="${id}"]`).click();
  } else await page.locator(`#terminal-tabs [data-terminal-choice="${id}"]`).click();
}
async function choose(page, id) {
  await select(page, id); await expect(page.locator('#input-terminal')).toHaveValue(id);
  await expect(page.locator('#connection-status')).toContainText('终端在线'); await expect(page.locator('#input-terminal')).toBeEnabled();
}

test('relay target switches retain one WebSocket and iframe, isolate drafts and reconnect to the last confirmed target', async ({ page }) => {
  const app = await create();
  try {
    const frame = await login(page, app), source = await page.locator('#desktop-frame').getAttribute('src'), catalog = await app.controls.listTerminals();
    await openTools(page); await page.locator('#terminal-history-rows').selectOption('5000'); await closePanels(page);
    await expect.poll(() => frame.evaluate(() => window.relayTerminal.options.scrollback)).toBe(5000);
    await page.route('**/terminal/**', route => route.abort()); await page.route('**/desktop/**', route => route.abort());
    await openInput(page); await page.locator('#mobile-input').fill('主终端草稿');
    await choose(page, 'aux1'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('');
    await expect.poll(() => frame.evaluate(() => window.relayTerminal.options.scrollback)).toBe(5000);
    await page.locator('#mobile-input').fill('只粘贴到辅助终端'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await choose(page, 'main'); await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('主终端草稿');
    expect(await page.evaluate(() => window.relayConnections)).toBe(1);
    expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source); expect(page.frames().includes(frame)).toBe(true);
    expect((await app.controls.listTerminals()).terminals).toEqual(catalog.terminals);
    await choose(page, 'aux1'); await frame.evaluate(() => window.relaySockets[0].close());
    await expect.poll(() => page.evaluate(() => window.relayConnections)).toBe(2);
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await page.waitForTimeout(3200); // The old terminal heartbeat must not retire the new target.
    expect(await page.evaluate(() => window.relayConnections)).toBe(2); expect(app.terminalConnections).toBe(4);
    expect(app.terminalChildren).toHaveLength(1); expect(app.managementStats.restarts).toBe(0);
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\x1b[200~只粘贴到辅助终端\x1b[201~' }]);
    expect((await page.evaluate(() => window.relaySent)).map(value => value.terminalId)).toEqual(['aux1', 'main', 'aux1']);
  } finally { await app.close(); }
});

test('a missing relay switch reply preserves the draft and requires manual selection without replaying a switch or input', async ({ page }) => {
  const app = await create();
  try {
    await login(page, app); await openInput(page); await page.locator('#mobile-input').fill('结果未知时保留');
    await page.evaluate(() => { window.dropSwitchReply = true; }); await select(page, 'aux1');
    await expect(page.locator('#choose-terminal-button')).toBeVisible();
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('结果未知时保留'); await expect(page.locator('#paste-button')).toBeDisabled();
    await page.waitForTimeout(700); expect(await page.evaluate(() => window.relayConnections)).toBe(1);
    expect(await page.evaluate(() => window.relaySent.length)).toBe(1); expect(app.terminalInputs).toEqual([]);
    await page.evaluate(() => { window.dropSwitchReply = false; }); await choose(page, 'main');
    await openInput(page); await expect(page.locator('#mobile-input')).toHaveValue('结果未知时保留');
    expect(await page.evaluate(() => window.relayConnections)).toBe(2); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('relay switches reject composition and pending input without queuing a later change', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const app = await create({ terminalHook: async () => hold });
  try {
    const frame = await login(page, app), field = frame.locator('.xterm-helper-textarea');
    await field.dispatchEvent('compositionstart', { data: '中' });
    await page.locator('#input-terminal').evaluate(el => { el.value = 'aux1'; el.dispatchEvent(new Event('change')); });
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(await page.evaluate(() => window.relaySent.length)).toBe(0);
    await field.dispatchEvent('compositionend', { data: '中' });
    await openInput(page); await page.locator('#mobile-input').fill('确认一次'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'pending');
    await page.locator('#input-terminal').evaluate(el => { el.value = 'aux1'; el.dispatchEvent(new Event('change')); });
    release(); await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await expect(page.locator('#input-terminal')).toHaveValue('main'); expect(await page.evaluate(() => window.relaySent.length)).toBe(0);
    await choose(page, 'aux1'); expect(app.terminalInputs).toEqual([{ terminalId: 'main', text: '\x1b[200~确认一次\x1b[201~' }]);
    expect(await page.evaluate(() => window.relayConnections)).toBe(1);
  } finally { release(); await app.close(); }
});

test('switching a relay retires an old pending direct offer and later upgrades only the confirmed new target', async ({ page }) => {
  const app = await create({ webrtc: true }); let release, entered;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }), offers = [];
  try {
    await page.context().route('**/api/terminal/rtc', async route => {
      offers.push(route.request().postDataJSON());
      if (offers.length === 1) { const response = await route.fetch(); entered(); await hold; await route.fulfill({ response }); }
      else await route.continue();
    });
    const frame = await login(page, app); await started; await choose(page, 'aux1'); release();
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 12000 });
    expect(offers[0].terminalId).toBe('main'); expect(offers.at(-1).terminalId).toBe('aux1');
    await openInput(page); await page.locator('#mobile-input').fill('新目标直连'); await page.locator('#paste-button').click();
    await expect(page.locator('#input-status')).toHaveAttribute('data-outcome', 'success');
    await frame.evaluate(() => window.relayPeers.at(-1).close());
    await expect(page.locator('#diag-transport')).toContainText('WebSocket'); await expect(page.locator('#input-terminal')).toHaveValue('aux1');
    expect(await page.evaluate(() => window.relayConnections)).toBe(1); expect(app.terminalConnections).toBe(2);
    expect(app.terminalInputs).toEqual([{ terminalId: 'aux1', text: '\x1b[200~新目标直连\x1b[201~' }]);
  } finally { release(); await app.close(); }
});

test('a relay without the new capability keeps the legacy page reconnect behavior', async ({ page }) => {
  const app = await create();
  try {
    await login(page, app, { legacy: true }); const source = await page.locator('#desktop-frame').getAttribute('src'); await choose(page, 'aux1');
    expect(await page.locator('#desktop-frame').getAttribute('src')).not.toBe(source); expect(await page.evaluate(() => window.relayConnections)).toBe(2);
    expect(await page.evaluate(() => window.relaySent.length)).toBe(0); expect(app.terminalConnections).toBe(2); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

test('a closing relay rejects unsent input before advancing sequence and resumes the same upstream',async({page,context})=>{
 const app=await create();
 try{
  await app.login();await app.claim();const [name,value]=app.cookie.split('=');await context.addCookies([{name,value,url:app.config.origin}]);
  // Use a real loopback navigation so Chromium assigns its local address space.
  // Block only the app entrypoint; this test owns its single logical stream.
  await page.route('**/app.js*',route=>route.abort());await page.goto(app.config.origin);
  const terminal=(await app.controls.listTerminals()).terminals.find(item=>item.id==='main');
  await page.evaluate(async({viewer,csrf,terminal})=>{
   const Native=WebSocket;window.testSockets=[];window.testReady=false;window.testResets=[];window.testMessages=[];
   window.WebSocket=class extends Native{
    constructor(...args){super(...args);window.testSockets.push(this);this.addEventListener('message',event=>{const value=JSON.parse(event.data);if(window.testMessages.length<16)window.testMessages.push(value.type);if(value.type==='reset')window.testResets.push(value.reason);});}
    get readyState(){return this.testClosing?Native.CLOSING:super.readyState;}
    send(data){if(this.testClosing)throw new DOMException('closing relay','InvalidStateError');super.send(data);}
   };
   const {createStreamClient}=await import('/desktop/stream-client.js');window.testStream=createStreamClient({viewer,csrf,terminal:{terminalId:terminal.id,terminalToken:terminal.token},bootstrap:()=>({csrf,webrtc:false,rtcStunUrl:''})});
   window.testStream.socket.addEventListener('message',event=>{if(JSON.parse(event.data).type==='ready')window.testReady=true;});window.testStream.start();
  },{viewer:app.viewer,csrf:app.csrf,terminal});
  await expect.poll(()=>page.evaluate(()=>({ready:window.testReady,messages:window.testMessages,state:window.testStream.socket.readyState,ws:window.testSockets.map(s=>s.readyState)}))).toMatchObject({ready:true});
  await page.evaluate(()=>{window.testSockets[0].testClosing=true;try{window.testStream.socket.send(JSON.stringify({type:'health',nonce:1}));}catch{}});
  await expect.poll(()=>page.evaluate(()=>({connections:window.testSockets.length,state:window.testStream.socket.readyState,idle:window.testStream.idle,resets:window.testResets})),{timeout:8000}).toEqual({connections:2,state:1,idle:true,resets:[]});
  expect(app.terminalConnections).toBe(1);expect(app.terminalChildren).toHaveLength(1);expect(app.terminalInputs).toEqual([]);
 }finally{await app.close();}
});
