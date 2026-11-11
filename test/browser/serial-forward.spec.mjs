import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, helper, freePort, until } from './forward-support.mjs';
test('serial lists belong to the selected fixed helper; custom paths and serial parameters survive edits and inventory refresh', async ({ page }) => {
  const app=await fixture({rfb:true,forwardPorts:'*'});let peer;
  try {
    await login(page,app);await open(page);const a=await choose(page,1);peer=await helper(app,a.key,['COM3','COM7']);
    await expect(page.locator('#forward-agent-inventory-title')).toContainText('网卡 2 张');await page.locator('#forward-agent-inventory-title').click();
    await expect(page.locator('#forward-agent-inventory-body')).toContainText('192.168.1.23/24（255.255.255.0）');await expect(page.locator('#forward-agent-inventory-body')).toContainText('VPN（停用）');
    await page.locator('#forward-rule-add').click();await page.locator('#forward-rule-name').fill('调试串口');await page.locator('#forward-direction').selectOption('reverse');await page.locator('#forward-protocol').selectOption('serial');await page.locator('#forward-local').fill(String(await freePort()));
    expect(await page.locator('#forward-rule-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);await expect(page.locator('#forward-serial-choice option')).toHaveCount(3);await page.locator('#forward-serial-choice').selectOption('COM7');await expect(page.locator('#forward-serial-path')).toHaveValue('COM7');await page.locator('#forward-create').click();
    await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();await expect(page.locator('#forward-agent-rules')).toContainText('COM7 @ 115200');await expect(page.locator('#forward-agent-rules')).toContainText('已生效');
    await page.getByRole('button',{name:'编辑规则',exact:true}).click();await page.locator('#forward-serial-path').fill('COM99');await page.locator('#forward-serial-baud').selectOption('9600');await page.locator('#forward-create').click();
    await expect(page.locator('#forward-agent-rules')).toContainText('COM99 @ 9600');const count=peer.messages.filter(m=>m.type==='inventory-request').length;await page.locator('#forward-agent-inventory-refresh').click();await until(()=>peer.messages.filter(m=>m.type==='inventory-request').length>count);
    await page.getByRole('button',{name:'编辑规则',exact:true}).click();await expect(page.locator('#forward-serial-path')).toHaveValue('COM99');await page.locator('#forward-rule-cancel').click();
    await choose(page,2);await page.locator('#forward-rule-add').click();await page.locator('#forward-direction').selectOption('reverse');await page.locator('#forward-protocol').selectOption('serial');await expect(page.locator('#forward-serial-choice option')).toHaveCount(1);
    expect(app.inputCalls).toEqual([]);
  } finally {peer?.close();await app.close();}
});
