import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, add, discard } from './forward-support.mjs';

test('offline rules persist and modal cancellation cannot change the configuration',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});
 try{
  await login(page,app);await open(page);const a=await choose(page,1);await add(page,'离线 SSH');await expect(page.locator('#forward-agent-rules')).toContainText('等待助手上线');
  await page.getByRole('button',{name:'编辑规则',exact:true}).click();await page.locator('#forward-rule-name').fill('未保存的名称');await discard(page);await expect(page.locator('#forward-agent-rules')).toContainText('离线 SSH');await expect(page.locator('#forward-agent-rules')).not.toContainText('未保存的名称');
  await page.locator('#forward-close').click();await open(page);expect((await choose(page,1)).key).toBe(a.key);await expect(page.locator('#forward-agent-rules')).toContainText('离线 SSH');expect(app.inputCalls).toEqual([]);
 }finally{await app.close();}
});

test('a stale modal cannot overwrite another page rule edit',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});
 try{
  await login(page,app);await open(page);await choose(page,1);
  const sent=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/api/forward/agents/rule'));await add(page,'原规则');const headers=await(await sent).allHeaders();
  await page.getByRole('button',{name:'编辑规则',exact:true}).click();await page.locator('#forward-rule-name').fill('本页草稿');
  const contextHeaders={origin:app.config.origin,'x-viewer-id':headers['x-viewer-id'],'x-csrf-token':headers['x-csrf-token']};
  const state=await(await page.request.get(app.config.origin+'/api/forward/agents',{headers:contextHeaders})).json(),agent=state.agents[0],rule=agent.rules[0];
  const response=await page.request.post(app.config.origin+'/api/forward/agents/rule',{headers:contextHeaders,data:{agentId:agent.id,id:rule.id,revision:rule.revision,name:'并发修改',enabled:rule.enabled,config:rule.config}});expect(response.status()).toBe(200);
  await expect(page.locator('#forward-rule-error')).toContainText('规则已被其他页面修改');await expect(page.locator('#forward-create')).toBeDisabled();await expect(page.locator('#forward-rule-name')).toHaveValue('本页草稿');
  await discard(page);await expect(page.locator('#forward-agent-rules')).toContainText('并发修改');
 }finally{await app.close();}
});

test('server validation errors retain the editor and never create a hidden one-time authorization',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});
 try{
  await login(page,app);await open(page);await choose(page,1);await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-name').fill('错误地址');await page.locator('#forward-host').fill('example.test');await page.locator('#forward-create').click();
  await expect(page.locator('#forward-rule-error')).toContainText('目标 IP');await expect(page.locator('#forward-rule-dialog')).toBeVisible();expect(await page.locator('#forward-code').count()).toBe(0);await discard(page);await expect(page.locator('#forward-agent-rules')).toContainText('尚无规则');
 }finally{await app.close();}
});

test('a lost save response is not replayed and its committed rule can be reconciled from the list',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});let saves=0;
 try{
  await page.route('**/api/forward/agents/rule',async route=>{saves++;await route.fetch();await route.abort();});
  await login(page,app);await open(page);await choose(page,1);await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-name').fill('结果未知的规则');await page.locator('#forward-create').click();await expect(page.locator('#forward-rule-error')).toContainText('结果未确认');await discard(page);
  await expect(page.locator('#forward-agent-rules article')).toHaveCount(1);await expect(page.locator('#forward-agent-rules')).toContainText('结果未知的规则');expect(saves).toBe(1);
 }finally{await app.close();}
});
