import { test,expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
test.use({ serviceWorkers: 'block' });
async function startIsolatedService(page,app) {
 await page.goto(app.config.origin);
 await page.evaluate(async credentials => {
  const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials)});
  if(!response.ok)throw Error('isolated service login failed');
  const settings=await(await fetch('/api/me')).json(),{createServiceLink}=await import('/service-link.js');
  window.auditService=createServiceLink({viewer:crypto.randomUUID(),options:()=>settings,changed(){}});window.auditService.start();
 },{username:app.config.username,password:app.config.password});
 await expect.poll(()=>page.evaluate(()=>!!window.auditService?.files),{timeout:15000}).toBe(true);
}
test('real service RPC cancellation drains its delayed HTTP reply while an independent DTLS upload completes once',async({page})=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const app=await fixture({webrtc:true,serviceDiagnostics:async()=>{entered();await gate;return{available:false};}});
 try{
  await startIsolatedService(page,app);
  await page.evaluate(()=>{
   window.auditCancel=new AbortController();
   window.auditReply=window.auditService.request('diagnostics',{},window.auditCancel.signal).catch(error=>({outcome:error.outcome}));
   window.auditUpload=window.auditService.files.upload({name:'real-boundary.bin',size:4,slice(){return{arrayBuffer:()=>new Promise(resolve=>{window.releaseAuditRead=()=>resolve(new TextEncoder().encode('safe').buffer);})};}});void window.auditUpload.catch(()=>{});
  });
  await started;await expect.poll(()=>page.evaluate(()=>typeof window.releaseAuditRead)).toBe('function');
  await page.evaluate(()=>window.auditCancel.abort());release();
  expect(await page.evaluate(async()=>({reply:await window.auditReply,ready:window.auditService.ready,fileBusy:window.auditService.files?.busy}))).toEqual({reply:{outcome:'unknown'},ready:true,fileBusy:true});
  await page.evaluate(async()=>{window.releaseAuditRead();await window.auditUpload;await window.auditService.request('files',{});window.auditService.stop();});
  expect(app.files.get('real-boundary.bin').toString()).toBe('safe');expect(app.received.filter(value=>value.method==='PUT'&&value.url==='/files/real-boundary.bin')).toHaveLength(1);
  expect(app.inputCalls).toEqual([]);expect(app.vncConnections).toBe(0);
 }finally{release();await app.close();}
});
test('a real server promotion retires the old peer before a hidden page receives and adopts its held confirmation',async({page})=>{
 const app=await fixture({webrtc:true});
 try{
  await page.addInitScript(()=>{
   const create=RTCPeerConnection.prototype.createDataChannel;let services=0;
   RTCPeerConnection.prototype.createDataChannel=function(label,...args){
    const channel=create.call(this,label,...args);if(label!=='codex-service'||++services!==2)return channel;
    const send=channel.send.bind(channel),listen=channel.addEventListener.bind(channel);let holding=false;const held=[];
    channel.send=bytes=>{try{const value=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes.buffer||bytes,bytes.byteOffset||0,bytes.byteLength).subarray(4)));if(value.action==='promote')holding=true;}catch{}return send(bytes);};
    channel.addEventListener=(type,listener,options)=>listen(type,type==='message'?event=>{if(holding){if(held.length>=2)throw Error('held confirmation bound');held.push(()=>listener.call(channel,event));window.releaseRealPromotion=()=>{holding=false;for(const reply of held.splice(0))reply();};}else listener.call(channel,event);}:listener,options);
    return channel;
   };
  });
  await startIsolatedService(page,app);
  await page.evaluate(()=>{
   window.auditOld=window.auditService.transport;
   // Select the real candidate independently of runner RTT jitter; only the
   // admission score is fixed, never the HTTP/DTLS/promotion result under test.
   Object.defineProperty(window.auditOld.health,'rttMs',{get:()=>1000});
   window.auditRecheck=window.auditService.recheck();
  });
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseRealPromotion),{timeout:15000}).toBe('function');
  await expect.poll(()=>page.evaluate(()=>window.auditOld.control.ready)).toBe(false);
  const result=await page.evaluate(async()=>{
   Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
   window.releaseRealPromotion();await window.auditRecheck;
   const result={ready:window.auditService.ready,replaced:window.auditService.transport!==window.auditOld,files:(await window.auditService.request('files',{})).files};window.auditService.stop();return result;
  });
  expect(result).toEqual({ready:true,replaced:true,files:[]});expect(app.inputCalls).toEqual([]);expect(app.vncConnections).toBe(0);
 }finally{await app.close();}
});
for (const action of ['state', 'file-delete']) test(`a late successful ${action} after caller cancellation preserves the service and its active file`, async ({ page }) => {
 const app = await fixture();
 try {
  await page.route('**/rtc-transport.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function desktopTransport(...args) { return window.nextServiceTransport(...args); }' }));
  await page.goto(app.config.origin);
  await page.evaluate(async () => {
   const { createServiceLink } = await import('/service-link.js');
   const channel = new EventTarget(); Object.assign(channel, { readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); } });
   window.auditFileChannel = channel; window.auditCalls = []; window.auditCloses = 0;
   window.nextServiceTransport = async () => ({ features: { filesProtocol: 1 }, health: { async ping() {}, cancel() {} }, async start() {}, async stats() { return null; }, fileChannel: () => channel,
    control: { request(action) { window.auditCalls.push(action); return new Promise(resolve => { window.releaseAuditRPC = resolve; }); } }, close() { window.auditCloses++; channel.close(); } });
   window.auditService = createServiceLink({ viewer: 'isolated-cancelled-rpc', options: () => ({}), changed() {} }); window.auditService.start();
  });
  await expect.poll(() => page.evaluate(() => window.auditService.ready)).toBe(true);
  const result = await page.evaluate(async action => {
   const service = window.auditService, channel = window.auditFileChannel, controller = new AbortController();
   let delivered; const progress = new Promise(resolve => { delivered = resolve; });
   const download = service.files.download('isolated.bin', 4, undefined, loaded => { if (loaded === 4) delivered(); }); void download.catch(() => {});
   const request = service.request(action, {}, controller.signal).catch(error => error); controller.abort();
   const busyBeforeReply = service.busy; window.releaseAuditRPC({ ok: true }); const error = await request;
   const preserved = service.ready && service.files?.busy;
   channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ready', id: 1, size: 4 }) }));
   const bytes = new Uint8Array([0, 0, 0, 1, 115, 97, 102, 101]); channel.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
   await progress; channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'done', id: 1, size: 4 }) }));
   const text = await (await download).text();
   const next = service.request('state', {}); window.releaseAuditRPC({ fresh: true }); const value = await next;
   const result = { busyBeforeReply, outcome: error.outcome, preserved, text, value, closes: window.auditCloses, calls: window.auditCalls };
   service.stop(); return result;
  }, action);
  expect(result).toEqual({ busyBeforeReply: true, outcome: 'unknown', preserved: true, text: 'safe', value: { fresh: true }, closes: 0, calls: [action, 'state'] });
  expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
 } finally { await app.close(); }
});
for (const cause of ['hidden', 'offline']) test(`service heartbeat pauses across ${cause} without retiring the peer or accepting an old nonce`, async ({ page }) => {
 const app = await fixture();
 try {
  await page.route('**/rtc-transport.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function desktopTransport(...args) { return window.nextServiceTransport(...args); }' }));
  await page.goto(app.config.origin); await page.clock.install();
  await page.evaluate(async () => {
   const { createHealthClient } = await import('/health.js'), { createServiceLink } = await import('/service-link.js');
   const channel = new EventTarget(); channel.readyState = 'open'; channel.bufferedAmount = 0;
   window.servicePings = []; window.serviceEvents = []; window.serviceClosed = false;
   const reply = bytes => channel.dispatchEvent(new MessageEvent('message', { data: bytes.slice(0) }));
   channel.send = bytes => { window.servicePings.push(bytes); if (window.servicePings.length === 1) queueMicrotask(() => reply(bytes)); };
   channel.close = () => {};
   window.serviceReply = index => reply(window.servicePings[index]);
   window.nextServiceTransport = async () => ({ features: {}, health: createHealthClient(channel), async start() {}, async stats() { return null; }, close() { window.serviceClosed = true; } });
   window.auditService = createServiceLink({ viewer: 'isolated-lifecycle-test', options: () => ({}), changed() {}, trace: type => window.serviceEvents.push(type) });
   window.auditService.start();
  });
  await expect.poll(() => page.evaluate(() => window.auditService.ready)).toBe(true);
  await page.clock.runFor(3100);
  expect(await page.evaluate(() => window.servicePings.length)).toBe(2);
  await page.evaluate(cause => {
   if (cause === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
   else { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); }
  }, cause);
  await page.clock.runFor(10000);
  expect(await page.evaluate(() => ({ ready: window.auditService.ready, closed: window.serviceClosed, pings: window.servicePings.length }))).toEqual({ ready: true, closed: false, pings: 2 });
  await page.evaluate(cause => {
   if (cause === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }
   else { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); }
  }, cause);
  await page.clock.runFor(110);
  expect(await page.evaluate(() => window.servicePings.length)).toBe(3);
  await page.evaluate(() => window.serviceReply(1));
  await page.clock.runFor(300);
  const result = await page.evaluate(() => {
   window.serviceReply(2);
   const result = { ready: window.auditService.ready, lost: window.serviceEvents.includes('path-lost'), closed: window.serviceClosed };
   window.auditService.stop(); return result;
  });
  expect(result).toEqual({ ready: true, lost: false, closed: false });
  expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
 } finally { await app.close(); }
});
test('a retired monitor cannot clear the new foreground check while its stats resolve late', async ({ page }) => {
 const app = await fixture();
 try {
  await page.route('**/rtc-transport.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function desktopTransport(...args) { return window.nextServiceTransport(...args); }' }));
  await page.goto(app.config.origin); await page.clock.install();
  await page.evaluate(async () => {
   const { createServiceLink } = await import('/service-link.js'); let stats = 0;
   window.monitorPings = 0; window.monitorClosed = false;
   window.nextServiceTransport = async () => ({ features: {}, health: { cancel() {}, ping() {
    if (++window.monitorPings < 3) return Promise.resolve();
    return new Promise(resolve => { window.releaseForegroundPing = resolve; });
   } }, async start() {}, stats() {
    if (++stats === 2) return new Promise(resolve => { window.releaseRetiredStats = resolve; });
    return Promise.resolve(null);
   }, close() { window.monitorClosed = true; } });
   window.auditService = createServiceLink({ viewer: 'isolated-generation-test', options: () => ({}), changed() {} }); window.auditService.start();
  });
  await expect.poll(() => page.evaluate(() => window.auditService.ready)).toBe(true);
  await page.clock.runFor(3100);
  await page.evaluate(() => {
   Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
   Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(110);
  expect(await page.evaluate(() => window.monitorPings)).toBe(3);
  await page.evaluate(async () => { window.releaseRetiredStats(null); await Promise.resolve(); await Promise.resolve(); window.dispatchEvent(new Event('online')); });
  await page.clock.runFor(200);
  expect(await page.evaluate(() => ({ pings: window.monitorPings, closed: window.monitorClosed, ready: window.auditService.ready }))).toEqual({ pings: 3, closed: false, ready: true });
  await page.evaluate(() => { window.releaseForegroundPing(); window.auditService.stop(); });
 } finally { await app.close(); }
});

for (const cause of ['hidden', 'busy', 'monitor', 'stop']) test(`a service promotion handles ${cause} after its commit boundary without losing the adopted peer`, async ({ page }) => {
 const app = await fixture();
 try {
  await page.route('**/rtc-transport.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function desktopTransport(...args) { return window.nextServiceTransport(...args); }' }));
  await page.goto(app.config.origin); await page.clock.install();
  await page.evaluate(async () => {
   const { createServiceLink } = await import('/service-link.js'); let opened = 0;
   window.auditPeers = []; window.auditCanReplace = true;
   window.nextServiceTransport = async (_viewer, _changed, options) => {
    const index = opened++, peer = { features: {}, closed: false, promotions: 0, pings: 0,
     async start() {}, async stats() { return null; }, health: { rttMs: index ? 1 : 100, async ping() { peer.pings++; }, cancel() {} },
     close() { peer.closed = true; }, control: { request(action) { if (action !== 'promote') throw Error('unexpected RPC'); peer.promotions++;
      window.auditPeers[0].serverClosed = true; return new Promise((resolve, reject) => { window.releasePromotion = () => resolve({ promoted: true }); options.signal.addEventListener('abort', () => reject(Error('shutdown')), { once: true }); }); } } };
    options.signal.addEventListener('abort', () => peer.close(), { once: true }); window.auditPeers.push(peer); return peer;
   };
   window.auditService = createServiceLink({ viewer: 'isolated-committed-service', options: () => ({}), changed() {}, canReplace: () => window.auditCanReplace }); window.auditService.start();
  });
  await expect.poll(() => page.evaluate(() => window.auditService.ready)).toBe(true);
  await page.evaluate(() => { window.auditRecheck = window.auditService.recheck(); });
  await expect.poll(() => page.evaluate(() => typeof window.releasePromotion)).toBe('function');
  await page.evaluate(cause => {
   if (cause === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
   if (cause === 'busy') window.auditCanReplace = false;
   if (cause === 'monitor') window.dispatchEvent(new Event('online'));
   if (cause === 'stop') window.auditService.stop();
  }, cause);
  if (cause === 'monitor') await page.clock.runFor(3100);
  const result = await page.evaluate(async () => {
   window.releasePromotion(); await window.auditRecheck;
   const [old, next] = window.auditPeers, result = { ready: window.auditService.ready, adopted: window.auditService.transport === next, oldClosed: old.closed, serverClosed: old.serverClosed, nextClosed: next.closed, promotions: next.promotions, oldPings: old.pings };
   window.auditService.stop(); return result;
  });
  expect(result).toEqual({ ready: cause !== 'stop', adopted: cause !== 'stop', oldClosed: true, serverClosed: true, nextClosed: cause === 'stop', promotions: 1, oldPings: 1 });
  expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
 } finally { await app.close(); }
});
for (const cause of ['stop', 'busy']) test(`mocked delayed service stats cannot enable a recheck after ${cause}`, async ({ page }) => {
 const app = await fixture();
 try {
  // Only the transport is mocked: exercise the published lifecycle controller
  // with a stats Promise that still resolves after its native peer is closed.
  await page.route('**/rtc-transport.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function desktopTransport(...args) { return window.nextServiceTransport(...args); }' }));
  await page.goto(app.config.origin);
  await page.evaluate(async () => {
   const { createServiceLink } = await import('/service-link.js');
   let probes = 0, stats = 0;
   window.serviceReplaceAllowed = true;
   window.nextServiceTransport = async (viewer, changed, options) => {
    if (++probes === 1) return null;
    const candidate = { features: {}, health: { rttMs: 10, async ping() {} }, async start() {}, close() { window.serviceCandidateClosed = true; },
     stats() { if (++stats === 2) return new Promise(resolve => { window.releaseServiceStats = () => resolve(null); }); return Promise.resolve(null); } };
    options.signal.addEventListener('abort', () => candidate.close(), { once: true }); return candidate;
   };
   window.auditService = createServiceLink({ viewer: 'isolated-audit-viewer', options: () => ({}), changed() {}, canReplace: () => window.serviceReplaceAllowed });
   window.auditService.start(); await new Promise(resolve => setTimeout(resolve, 0));
   window.serviceRecheck = window.auditService.recheck();
  });
  await expect.poll(() => page.evaluate(() => typeof window.releaseServiceStats)).toBe('function');
  const result = await page.evaluate(async cause => {
   if (cause === 'stop') window.auditService.stop(); else window.serviceReplaceAllowed = false;
   window.releaseServiceStats(); await window.serviceRecheck;
   const result = { ready: window.auditService.ready, transport: !!window.auditService.transport, stateReady: window.auditService.state.ready, closed: window.serviceCandidateClosed };
   window.auditService.stop(); return result;
  }, cause);
  expect(result).toEqual({ ready: false, transport: false, stateReady: false, closed: true });
  expect(app.vncConnections).toBe(0); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
 } finally { await app.close(); }
});
async function setup(app,page){
 await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});
 await page.goto(app.config.origin);await page.locator('#username').fill('visitor');await page.locator('#password').fill('temporary-test-password');await page.locator('#login-button').click();await expect(page.locator('#user-label')).toContainText('临时访问');
}
test('temporary browser establishes independent direct services with saved hints and never claims desktop',async({page})=>{
 const app=await fixture({webrtc:true,forwardPorts:'*'}),offers=[],claims=[];
 try{
  await page.addInitScript(()=>localStorage.setItem('codex-cloud.rtc-hints.v2',JSON.stringify({version:2,entries:[{scope:'path:/',at:Date.now(),hints:{server:'10.123.254.253',browser:'10.123.254.252'}}]})));
  page.on('request',r=>{if(r.url().endsWith('/api/service/rtc'))offers.push(r.postDataJSON());if(/\/api\/(desktop\/claim|desktop\/rtc|terminal\/rtc)$/.test(r.url()))claims.push(r.url());});
  await setup(app,page);await expect(page.locator('#diag-transport')).toContainText('WebRTC', {timeout:15000});expect(offers[0].hints).toEqual({server:'10.123.254.253',browser:'10.123.254.252'});expect(claims).toEqual([]);
  await page.route('**/api/files',route=>route.abort());await page.locator('#files-button').click();await expect(page.locator('#file-list')).toContainText('还没有');await page.locator('#close-files').click();
  await page.locator('#forward-button').click();await expect(page.locator('#forward-agent-section')).toBeHidden();await expect(page.locator('#forward-permission')).toBeVisible();
  expect((await(await app.request('/api/state')).json()).mine).toBe(true);expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
test('failed service probes preserve HTTPS and saving new hints retries without a desktop or task',async({page})=>{
 const app=await fixture({webrtc:true}),offers=[];let first=true;
 try{
  await page.route('**/api/service/rtc',route=>{offers.push(route.request().postDataJSON());if(first){first=false;return route.fulfill({status:503,json:{error:'injected'}});}return route.continue();});
  await setup(app,page);await expect.poll(()=>offers.length).toBe(1);await page.locator('#files-button').click();await expect(page.locator('#file-list')).toContainText('还没有');await page.locator('#close-files').click();
  await page.locator('#connection-button').click();await page.locator('.direct-hints summary').click();await page.locator('#direct-server-ip').fill('10.123.254.253');await page.locator('#save-direct-hints').click();
  await expect(page.locator('#diag-transport')).toContainText('WebRTC',{timeout:15000});expect(offers.at(-1).hints.server).toBe('10.123.254.253');expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});

test('temporary service confirms a missing heartbeat promptly and falls back without replaying an operation', async ({ page }) => {
 const app = await fixture({ webrtc: true }); const offers = [], claims = [];
 try {
  await page.addInitScript(() => {
   window.serviceHealthPings = [];
   const create = RTCPeerConnection.prototype.createDataChannel;
   RTCPeerConnection.prototype.createDataChannel = function(label, options) {
    const channel = create.call(this, label, options);
    if (label === 'codex-health') {
     const send = channel.send.bind(channel);
     channel.send = bytes => { window.serviceHealthPings.push(performance.now()); send(bytes); };
     channel.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer && new DataView(event.data).getUint32(0) >= 2) event.stopImmediatePropagation();
     });
    }
    return channel;
   };
  });
  page.on('request', request => {
   if (request.url().endsWith('/api/service/rtc')) offers.push(request.url());
   if (/\/api\/(desktop\/claim|desktop\/rtc|terminal\/rtc)$/.test(request.url())) claims.push(request.url());
  });
  await setup(app, page); await expect(page.locator('#diag-transport')).toContainText('WebRTC', { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.serviceHealthPings.length), { timeout: 10000 }).toBe(3);
  await expect(page.locator('#diag-transport')).toContainText('HTTPS', { timeout: 2500 });
  expect(offers).toHaveLength(1); expect(claims).toEqual([]); expect(app.vncConnections).toBe(0); expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
 } finally { await app.close(); }
});
