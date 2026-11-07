import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
for(const override of ['', '10.2.3.4'])test(`temporary mappings inherit hints with helper override '${override}'`,async({page})=>{
 const app=await fixture({forwardPorts:'*',webrtc:true});
 try{
  await app.login();await app.claim();await app.request('/api/security/temporary-account',{method:'POST',body:{enabled:true,username:'visitor',password:'temporary-test-password',durationMs:3600000}});
  await page.addInitScript(()=>localStorage.setItem('codex-cloud.rtc-hints.v1',JSON.stringify({server:'10.1.1.1',browser:'192.168.1.2'})));
  await page.goto(app.config.origin);await page.locator('#username').fill('visitor');await page.locator('#password').fill('temporary-test-password');await page.locator('#login-button').click();
  await expect(page.locator('#user-label')).toContainText('临时访问');await page.locator('#forward-button').click();
  await expect(page.locator('#forward-direction')).toHaveValue('reverse');await page.locator('#forward-device-name').fill('router');await page.locator('#forward-helper-ip').fill(override);
  const request=page.waitForRequest(r=>r.url().endsWith('/api/forward')&&r.method()==='POST');await page.locator('#forward-create').click();
  expect((await request).postDataJSON().hints).toEqual({server:'10.1.1.1',browser:override||'192.168.1.2'});
  await expect(page.locator('#forward-code')).not.toHaveValue('');await page.locator('#forward-helper-ip').fill('10.3.4.5');
  await page.getByRole('button',{name:'应用当前直连提示'}).click();await expect(page.locator('#forward-status')).toContainText('已更新');
  expect((await(await app.request('/api/forward')).json()).mappings[0].hints.browser).toBe('10.3.4.5');
  expect(app.inputCalls).toEqual([]);expect(app.managementStats.restarts).toBe(0);
 }finally{await app.close();}
});
