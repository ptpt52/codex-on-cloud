import { test,expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fixture } from '../fixture.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function login(app,page){await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});await page.goto(app.config.origin);await page.locator('#username').fill('visitor');await page.locator('#password').fill('temporary-test-password');await page.locator('#login-button').click();await expect(page.locator('#user-label')).toContainText('临时访问');await page.locator('#files-button').click();}
test('temporary uploads and downloads use the dedicated encrypted data channel without browser HTTP file bodies',async({page})=>{
 const app=await fixture({webrtc:true});const requests=[];
 try{
  await page.route('**/api/files/**',r=>{requests.push(r.request().method());return r.abort();});await login(app,page);await expect(page.locator('#file-transport')).toContainText('WebRTC',{timeout:15000});
  const bytes=Buffer.alloc(1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  await page.locator('#upload-input').setInputFiles({name:'中文.bin',mimeType:'application/octet-stream',buffer:bytes});await expect(page.locator('#upload-status')).toContainText('上传完成',{timeout:20000});
  expect(hash(app.files.get('中文.bin'))).toBe(hash(bytes));
  const downloading=page.waitForEvent('download');await page.locator('.file-row a').click();const download=await downloading;expect(download.suggestedFilename()).toBe('中文.bin');
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);expect(hash(Buffer.concat(chunks))).toBe(hash(bytes));expect(requests).toEqual([]);expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
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
  page.on('request',r=>{if(/\/api\/files\//.test(r.url()))contentRequests++;});await login(app,page);await expect(page.locator('#file-transport')).toContainText('WebRTC',{timeout:15000});
  await page.locator('#upload-input').setInputFiles({name:'once.txt',mimeType:'text/plain',buffer:Buffer.from('commit once')});await expect(page.locator('#upload-status')).toContainText('断开',{timeout:15000});
  await page.waitForTimeout(1500);expect(app.files.get('once.txt').toString()).toBe('commit once');expect(app.received.filter(r=>r.method==='PUT'&&r.url==='/files/once.txt')).toHaveLength(1);expect(contentRequests).toBe(0);
 }finally{await app.close();}
});
test('temporary direct uploads use the same rename and exact-version confirmation without HTTP bodies',async({page})=>{
 const app=await fixture({webrtc:true});app.files.set('shared.txt',Buffer.from('original'));let bodies=0;
 try{
  await page.route('**/api/files/**',r=>{bodies++;return r.abort();});await login(app,page);await expect(page.locator('#file-transport')).toContainText('WebRTC',{timeout:15000});
  const select=()=>page.locator('#upload-input').setInputFiles({name:'shared.txt',mimeType:'text/plain',buffer:Buffer.from('new')});
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();await page.locator('#file-conflict-rename').click();await expect(page.locator('#upload-status')).toContainText('上传完成：shared (2).txt');expect(app.files.get('shared.txt').toString()).toBe('original');
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();await page.locator('#file-conflict-replace').click();await expect(page.locator('#upload-status')).toContainText('上传完成：shared.txt');expect(app.files.get('shared.txt').toString()).toBe('new');
  await select();await expect(page.locator('#file-conflict-dialog')).toBeVisible();app.files.set('shared.txt',Buffer.from('newer'));await page.locator('#file-conflict-replace').click();await expect(page.locator('#upload-status')).toContainText('原文件已变化');expect(app.files.get('shared.txt').toString()).toBe('newer');expect(bodies).toBe(0);
  expect(app.received.filter(r=>r.method==='PUT')).toHaveLength(2);expect(app.vncConnections).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});
test('revoking a temporary account dismisses a pending replacement without uploading',async({page})=>{
 const app=await fixture({webrtc:true});app.files.set('shared.txt',Buffer.from('original'));
 try{
  await login(app,page);await expect(page.locator('#file-transport')).toContainText('WebRTC',{timeout:15000});await page.locator('#upload-input').setInputFiles({name:'shared.txt',mimeType:'text/plain',buffer:Buffer.from('new')});await expect(page.locator('#file-conflict-dialog')).toBeVisible();
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
  await page.locator('#files-button').click();await expect(page.locator('#file-transport')).toContainText('WebRTC',{timeout:15000});await page.locator('#upload-input').setInputFiles({name:'admin.txt',mimeType:'text/plain',buffer:Buffer.from('independent file peer')});await expect(page.locator('#upload-status')).toContainText('上传完成');await page.locator('#close-files').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线');expect(await page.locator('#desktop-frame').getAttribute('src')).toBe(source);expect(app.vncConnections).toBe(1);expect(app.inputCalls).toEqual([]);expect(app.managementStats.restarts).toBe(0);
 }finally{await app.close();}
});
