import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, helper, add } from './forward-support.mjs';
test('reverse rules use the helper target and server loopback, copy explicit connection information, and delete only the chosen rule',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});let peer;
 try{
  await login(page,app);await open(page);const a=await choose(page,1);peer=await helper(app,a.key);
  await add(page,'路由器',{direction:'reverse'});await expect(page.locator('#forward-agent-rules')).toContainText('服务器 127.0.0.1:');await expect(page.locator('#forward-agent-rules')).toContainText('已生效');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.connectionCopy=text;}}}));await page.getByRole('button',{name:'复制连接信息'}).click();const text=await page.evaluate(()=>window.connectionCopy);expect(text).toContain('ssh -o HostKeyAlias=codex-cloud-');expect(text).not.toContain(a.key);
  await page.getByRole('button',{name:'删除规则',exact:true}).click();await expect(page.locator('#forward-agent-confirm-cancel')).toBeFocused();await page.locator('#forward-agent-confirm-accept').click();await expect(page.locator('#forward-agent-rules')).toContainText('尚无规则');await expect(page.locator('#forward-agent-connection')).toContainText('助手在线');
  expect(app.managementStats.restarts).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{peer?.close();await app.close();}
});
