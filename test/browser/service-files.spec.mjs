import { test,expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fixture } from '../fixture.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function login(app,page){await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});await page.goto(app.config.origin);await page.locator('#username').fill('visitor');await page.locator('#password').fill('temporary-test-password');await page.locator('#login-button').click();await expect(page.locator('#user-label')).toContainText('临时访问');await page.locator('#files-button').click();}
for (const ending of ['complete', 'cancel', 'close']) test(`an offline hint preserves an admitted LAN upload while ${ending} keeps its own outcome`, async ({ page }) => {
 const app=await fixture({webrtc:true});let signals=0;
 page.on('request',request=>{if(request.url().endsWith('/api/service/rtc'))signals++;});
 await page.addInitScript(()=>{
  const read=Blob.prototype.arrayBuffer,send=RTCDataChannel.prototype.send;
  window.filePackets=0;window.fileCancels=0;window.slowFiles=false;
  Blob.prototype.arrayBuffer=async function(){if(window.slowFiles)await new Promise(resolve=>setTimeout(resolve,350));return read.call(this);};
  RTCDataChannel.prototype.send=function(value){if(this.label==='codex-files'){window.fileNative=this;if(typeof value==='string'){if(JSON.parse(value).type==='cancel')window.fileCancels++;}else window.filePackets++;}return send.call(this,value);};
 });
 try{
  await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  const bytes=Buffer.alloc(2*1024*1024,139);await page.evaluate(()=>{window.slowFiles=true;});
  await page.locator('#upload-input').setInputFiles({name:'hint.bin',mimeType:'application/octet-stream',buffer:bytes});
  await expect.poll(()=>page.evaluate(()=>window.filePackets)).toBeGreaterThan(0);
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));});
  await expect(page.locator('#upload-input')).toBeDisabled();
  if(ending==='cancel')await page.locator('#cancel-file-transfer').click();
  if(ending==='close')await page.evaluate(()=>window.fileNative.close());
  await expect(page.locator('#upload-status')).toContainText(ending==='complete'?'上传完成':ending==='cancel'?'结果未知':'结果未确认',{timeout:10000});
  if(ending==='complete'){expect(hash(app.files.get('hint.bin'))).toBe(hash(bytes));expect(await page.evaluate(()=>window.fileCancels)).toBe(0);expect(signals).toBe(1);}
  else{expect(app.files.has('hint.bin')).toBe(false);if(ending==='cancel')expect(await page.evaluate(()=>window.fileCancels)).toBe(1);}
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'));});
  await expect(page.locator('#upload-input')).toBeEnabled();
  await page.waitForTimeout(400);expect(app.received.filter(request=>request.method==='PUT'&&request.url==='/files/hint.bin')).toHaveLength(1);
  expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
test('an offline hint preserves a progressing LAN download without HTTP fallback or an incomplete saved file', async ({ page }) => {
 const app=await fixture({webrtc:true}),bytes=Buffer.alloc(2*1024*1024,141);app.files.set('download.bin',bytes);let bodies=0;
 await page.addInitScript(()=>{
  const listen=RTCDataChannel.prototype.addEventListener;window.downloadChunks=0;
  RTCDataChannel.prototype.addEventListener=function(type,listener,options){if(this.label==='codex-files'&&type==='message')return listen.call(this,type,event=>{
   if(typeof event.data!=='string')setTimeout(()=>{window.downloadChunks++;listener.call(this,event);},300);else listener.call(this,event);
  },options);return listen.call(this,type,listener,options);};
 });
 try{
  await page.route('**/api/files/**',route=>{bodies++;return route.abort();});
  await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  const downloading=page.waitForEvent('download');await page.locator('.file-row a').click();
  await expect.poll(()=>page.evaluate(()=>window.downloadChunks)).toBeGreaterThan(0);
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));});
  const download=await downloading,stream=await download.createReadStream(),parts=[];for await(const chunk of stream)parts.push(chunk);
  expect(hash(Buffer.concat(parts))).toBe(hash(bytes));await expect(page.locator('#upload-status')).toContainText('下载完成');expect(bodies).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
test('blocked native file reads stay bounded across canceled uploads and late reads cannot send file data',async({page})=>{
 const app=await fixture({webrtc:true});
 await page.addInitScript(()=>{
  const read=Blob.prototype.arrayBuffer,create=RTCPeerConnection.prototype.createDataChannel;window.heldFileReads=[];window.pendingFileReads=0;window.blockFileReads=true;window.fileChannelOpens=0;
  RTCPeerConnection.prototype.createDataChannel=function(label,options){const channel=create.call(this,label,options);if(label==='codex-files')channel.addEventListener('open',()=>window.fileChannelOpens++);return channel;};
  Blob.prototype.arrayBuffer=function(){
   if(!window.blockFileReads)return read.call(this);
   window.pendingFileReads++;
   return new Promise((resolve,reject)=>window.heldFileReads.push(()=>read.call(this).then(bytes=>{window.pendingFileReads--;resolve(bytes);},reject)));
  };
 });
 try{
  await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  for(let n=0;n<2;n++){
   await page.locator('#upload-input').setInputFiles({name:`blocked-${n}.bin`,mimeType:'application/octet-stream',buffer:Buffer.alloc(4096,n)});
   await expect.poll(()=>page.evaluate(()=>window.pendingFileReads)).toBe(n+1);
   await page.locator('#cancel-file-transfer').click();
   await expect(page.locator('#upload-input')).toBeEnabled();
   await expect.poll(()=>page.evaluate(()=>window.fileChannelOpens),{timeout:10000}).toBe(n+2);
   await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:10000});
  }
  await page.locator('#upload-input').setInputFiles({name:'refused.bin',mimeType:'application/octet-stream',buffer:Buffer.from('never sent')});
  await expect(page.locator('#upload-status')).toContainText('仍有未结束的本机文件读取');
  expect(await page.evaluate(()=>window.pendingFileReads)).toBe(2);
  expect(app.files.size).toBe(0);
  await page.evaluate(()=>{window.blockFileReads=false;window.heldFileReads.shift()();});
  await expect.poll(()=>page.evaluate(()=>window.pendingFileReads)).toBe(1);
  await page.locator('#upload-input').setInputFiles({name:'fresh.bin',mimeType:'application/octet-stream',buffer:Buffer.from('fresh')});
  await expect(page.locator('#upload-status')).toContainText('上传完成');
  expect([...app.files.keys()]).toEqual(['fresh.bin']);expect(app.files.get('fresh.bin').toString()).toBe('fresh');
  await page.evaluate(()=>window.heldFileReads.shift()());
  await expect.poll(()=>page.evaluate(()=>window.pendingFileReads)).toBe(0);
  expect([...app.files.keys()]).toEqual(['fresh.bin']);expect(app.inputCalls).toEqual([]);
 }finally{await page.evaluate(()=>{for(const release of window.heldFileReads||[])release();}).catch(()=>{});await app.close();}
});
test('temporary uploads and downloads use the dedicated encrypted data channel without browser HTTP file bodies',async({page})=>{
 const app=await fixture({webrtc:true});const requests=[];
 try{
  await page.addInitScript(()=>{
   window.fileWindows=[];window.fileReadSizes=[];const send=RTCDataChannel.prototype.send,read=Blob.prototype.arrayBuffer;
   Blob.prototype.arrayBuffer=async function(){if(window.measureFileReads){window.fileReadSizes.push(this.size);await new Promise(resolve=>setTimeout(resolve,30));}return read.call(this);};
   RTCDataChannel.prototype.send=function(value){if(this.label==='codex-files'&&typeof value==='string'){const record=JSON.parse(value);if(record.type==='start')window.fileWindows.push(record.window??4);}return send.call(this,value);};
  });
  await page.route('**/api/files/**',r=>{requests.push(r.request().method());return r.abort();});await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  const bytes=Buffer.alloc(4479340);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  await page.evaluate(()=>{window.measureFileReads=true;});
  await page.locator('#upload-input').setInputFiles({name:'中文.bin',mimeType:'application/octet-stream',buffer:bytes});await expect(page.locator('#upload-status')).toContainText('上传完成',{timeout:20000});
  expect(hash(app.files.get('中文.bin'))).toBe(hash(bytes));
  const reads=await page.evaluate(()=>{window.measureFileReads=false;return window.fileReadSizes;});
  expect(reads).toHaveLength(18);expect(Math.max(...reads)).toBeLessThanOrEqual(256*1024);expect(reads.reduce((total,size)=>total+size,0)).toBe(bytes.length);
  const downloading=page.waitForEvent('download');await page.locator('.file-row a').click();const download=await downloading;expect(download.suggestedFilename()).toBe('中文.bin');
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);expect(hash(Buffer.concat(chunks))).toBe(hash(bytes));expect(requests).toEqual([]);expect(await page.evaluate(()=>window.fileWindows)).toEqual([16,16]);expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
test('a lost upload completion is reported as uncertain and never retried through HTTP',async({page})=>{
 const app=await fixture({webrtc:true});let contentRequests=0;
 try{
  await page.addInitScript(()=>{
   const original=RTCDataChannel.prototype.addEventListener;
   RTCDataChannel.prototype.addEventListener=function(type,listener,options){
    if(this.label==='codex-files'&&type==='message')return original.call(this,type,event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='done'){this.close();return;}listener.call(this,event);},options);
    return original.call(this,type,listener,options);
   };
  });
  page.on('request',r=>{if(/\/api\/files\//.test(r.url()))contentRequests++;});await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  await page.locator('#upload-input').setInputFiles({name:'once.txt',mimeType:'text/plain',buffer:Buffer.from('commit once')});await expect(page.locator('#upload-status')).toContainText('断开',{timeout:15000});
  await page.waitForTimeout(1500);expect(app.files.get('once.txt').toString()).toBe('commit once');expect(app.received.filter(r=>r.method==='PUT'&&r.url==='/files/once.txt')).toHaveLength(1);expect(contentRequests).toBe(0);
 }finally{await app.close();}
});
test('temporary direct uploads use the same rename and exact-version confirmation without HTTP bodies',async({page})=>{
 const app=await fixture({webrtc:true});app.files.set('shared.txt',Buffer.from('original'));let bodies=0,signals=0;page.on('request',r=>{if(r.url().endsWith('/api/service/rtc'))signals++;});
 try{
  await page.route('**/api/files/**',r=>{bodies++;return r.abort();});await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  const select=()=>page.locator('#upload-input').setInputFiles({name:'shared.txt',mimeType:'text/plain',buffer:Buffer.from('new')});
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();await page.locator('#file-conflict-rename').click();await expect(page.locator('#upload-status')).toContainText('上传完成：shared (2).txt');expect(app.files.get('shared.txt').toString()).toBe('original');
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();await page.locator('#file-conflict-replace').click();await expect(page.locator('#upload-status')).toContainText('上传完成：shared.txt');expect(app.files.get('shared.txt').toString()).toBe('new');
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();app.files.set('shared.txt',Buffer.from('newer'));await page.locator('#file-conflict-replace').click();await expect(page.locator('#upload-status')).toContainText('原文件已变化');expect(app.files.get('shared.txt').toString()).toBe('newer');expect(bodies).toBe(0);
  expect(app.received.filter(r=>r.method==='PUT')).toHaveLength(2);expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
  await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:5000});expect(signals).toBe(1);
  await page.locator('#upload-input').setInputFiles({name:'after-conflict.txt',mimeType:'text/plain',buffer:Buffer.from('same service peer')});await expect(page.locator('#upload-status')).toContainText('上传完成：after-conflict.txt');expect(bodies).toBe(0);expect(signals).toBe(1);
 }finally{await app.close();}
});
test('revoking a temporary account dismisses a pending replacement without uploading',async({page})=>{
 const app=await fixture({webrtc:true});app.files.set('shared.txt',Buffer.from('original'));
 try{
  await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});await page.locator('#upload-input').setInputFiles({name:'shared.txt',mimeType:'text/plain',buffer:Buffer.from('new')});await expect(page.locator('#file-conflict-dialog')).toBeVisible();
  await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:false}});await expect(page.locator('#login-view')).toBeVisible({timeout:15000});await expect(page.locator('#file-conflict-dialog')).toBeHidden();
  expect(app.files.get('shared.txt').toString()).toBe('original');expect(app.received.filter(r=>r.method==='PUT')).toHaveLength(0);
 }finally{await app.close();}
});
test('HTTPS file transfer remains usable when direct signaling is unavailable',async({page})=>{
 const app=await fixture({webrtc:true});
 try{await page.route('**/api/service/rtc',r=>r.fulfill({status:503,json:{error:'injected'}}));await login(app,page);await expect(page.locator('#file-transport')).toContainText('HTTPS');await page.locator('#upload-input').setInputFiles({name:'fallback.txt',mimeType:'text/plain',buffer:Buffer.from('HTTPS fallback')});await expect(page.locator('#upload-status')).toContainText('上传完成');expect(app.files.get('fallback.txt').toString()).toBe('HTTPS fallback');expect(app.inputCalls).toEqual([]);}finally{await app.close();}
});
test('an administrator opens file direct on demand while the original desktop and control remain connected',async({page})=>{
 const app=await fixture({webrtc:true,rfb:true,rfbSize:{width:640,height:480},fastConnect:true,seamless:true});
 try{
  await page.goto(app.config.origin);await page.locator('#password').fill(app.config.password);await page.locator('#login-button').click();await expect(page.locator('#connection-status')).toContainText('桌面在线');
  await expect(page.locator('#diag-transport')).toContainText('WebRTC',{timeout:15000});const source=await page.locator('#desktop-frame').getAttribute('src');
  await page.locator('#files-button').click();await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});await page.locator('#upload-input').setInputFiles({name:'admin.txt',mimeType:'text/plain',buffer:Buffer.from('independent file peer')});await expect(page.locator('#upload-status')).toContainText('上传完成');await page.locator('#close-files').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);expect(app.vncConnections).toBe(1);expect(app.inputCalls).toEqual([]);expect(app.managementStats.restarts).toBe(0);
 }finally{await app.close();}
});

test('a progressing file upload survives service heartbeats queued behind file traffic', async ({ page }) => {
 const app=await fixture({webrtc:true});let signals=0;page.on('request',request=>{if(request.url().endsWith('/api/service/rtc'))signals++;});
 try{
  await page.addInitScript(()=>{
   const send=RTCDataChannel.prototype.send,listen=RTCDataChannel.prototype.addEventListener,read=Blob.prototype.arrayBuffer;
   RTCDataChannel.prototype.send=function(value){if(this.label==='codex-files'&&typeof value==='string'){const record=JSON.parse(value);if(record.type==='start'&&record.direction==='upload')window.uploadTimingActive=true;}return send.call(this,value);};
   RTCDataChannel.prototype.addEventListener=function(type,listener,options){if(this.label==='codex-health'&&type==='message')return listen.call(this,type,event=>{if(window.uploadTimingActive){window.queuedFilePongs=(window.queuedFilePongs||0)+1;setTimeout(()=>listener.call(this,event),2500);}else listener.call(this,event);},options);return listen.call(this,type,listener,options);};
   Blob.prototype.arrayBuffer=async function(){if(window.uploadTimingActive)await new Promise(resolve=>setTimeout(resolve,Math.ceil(this.size/16380)*60));return read.call(this);};
  });
  await login(app,page);await expect(page.locator('#file-transport')).toHaveText(/^文件内容：WebRTC /,{timeout:15000});
  const bytes=Buffer.alloc(2*1024*1024,137);await page.locator('#upload-input').setInputFiles({name:'queued-heartbeat.bin',mimeType:'application/octet-stream',buffer:bytes});
  await expect(page.locator('#upload-status')).toContainText('上传完成',{timeout:20000});
  await page.evaluate(()=>{window.uploadTimingActive=false;});expect(await page.evaluate(()=>window.queuedFilePongs||0)).toBe(0);
  expect(hash(app.files.get('queued-heartbeat.bin'))).toBe(hash(bytes));expect(signals).toBe(1);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
