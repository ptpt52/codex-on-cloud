import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, helper } from './forward-support.mjs';
for(const override of ['', '10.2.3.4'])test(`fixed helper rules preserve their direct address hints with helper override '${override}'`,async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'}),writes=[];
 try{
  await page.addInitScript(()=>localStorage.setItem('codex-cloud.rtc-hints.v2',JSON.stringify({version:2,entries:[{scope:'path:/',at:Date.now(),hints:{server:'10.1.1.1',browser:'192.168.1.2'}}]})));
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/api/forward/agents/rule'))writes.push(request.postDataJSON());});
  await login(page,app);await open(page);await choose(page,1);await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-name').fill('地址提示');if(override){await page.locator('#forward-rule-advanced > summary').click();await page.locator('#forward-helper-ip').fill(override);}await page.locator('#forward-create').click();await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
  expect(writes[0].config.hints).toEqual({server:'10.1.1.1',browser:override||''});
  await page.getByRole('button',{name:'编辑规则',exact:true}).click();await page.locator('#forward-rule-advanced > summary').click();await page.locator('#forward-helper-ip').fill('10.3.4.5');await page.locator('#forward-create').click();await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();expect(writes.at(-1).config.hints.browser).toBe('10.3.4.5');expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});

test('new rules keep helper IP automatic and allow an explicit choice from the enrolled helper inventory', async ({ page }) => {
 const app=await fixture({rfb:true,forwardPorts:'*'}),writes=[];let remote;
 try {
  await login(page,app);await open(page);const grant=await choose(page,1);remote=await helper(app,grant.key);
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/api/forward/agents/rule'))writes.push(request.postDataJSON());});
  await page.locator('#forward-refresh').click();await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-advanced > summary').click();
  await expect(page.locator('#forward-helper-ip')).toHaveValue('');
  await expect(page.locator('#forward-helper-ip-choice')).toBeEnabled();
  await page.locator('#forward-helper-ip-choice').selectOption('192.168.1.23');
  await expect(page.locator('#forward-helper-ip')).toHaveValue('192.168.1.23');
  await page.locator('#forward-helper-ip').fill('10.2.3.4');await expect(page.locator('#forward-helper-ip-choice')).toHaveValue('');
  await page.locator('#forward-create').click();await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
  expect(writes[0].config.hints.browser).toBe('10.2.3.4');
  await page.getByRole('button',{name:'编辑规则',exact:true}).click();await page.locator('#forward-rule-advanced > summary').click();
  await expect(page.locator('#forward-helper-ip')).toHaveValue('10.2.3.4');
  expect(app.inputCalls).toEqual([]);
 } finally {remote?.close();await app.close();}
});
