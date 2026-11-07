import { test,expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
async function setup(app,page){
 await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});
 await page.goto(app.config.origin);await page.locator('#username').fill('visitor');await page.locator('#password').fill('temporary-test-password');await page.locator('#login-button').click();await expect(page.locator('#user-label')).toContainText('临时访问');
}
test('temporary browser establishes independent direct services with saved hints and never claims desktop',async({page})=>{
 const app=await fixture({webrtc:true,forwardPorts:'*'}),offers=[],claims=[];
 try{
  await page.addInitScript(()=>localStorage.setItem('codex-cloud.rtc-hints.v1',JSON.stringify({server:'10.123.254.253',browser:'10.123.254.252'})));
  page.on('request',r=>{if(r.url().endsWith('/api/service/rtc'))offers.push(r.postDataJSON());if(/\/api\/(desktop\/claim|desktop\/rtc|terminal\/rtc)$/.test(r.url()))claims.push(r.url());});
  await setup(app,page);await expect(page.locator('#diag-transport')).toContainText('WebRTC', {timeout:15000});expect(offers[0].hints).toEqual({server:'10.123.254.253',browser:'10.123.254.252'});expect(claims).toEqual([]);
  await page.route('**/api/files',route=>route.abort());await page.locator('#files-button').click();await expect(page.locator('#file-list')).toContainText('还没有');await page.locator('#close-files').click();
  await page.locator('#forward-button').click();await expect(page.locator('#forward-direction')).toHaveValue('reverse');await page.locator('#forward-device-name').fill('router');await page.locator('#forward-create').click();await expect(page.locator('#forward-code')).not.toHaveValue('');
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
