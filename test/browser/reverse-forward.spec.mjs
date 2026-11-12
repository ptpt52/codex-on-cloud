import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { login, open, choose, helper, add } from './forward-support.mjs';

test('late clipboard failures cannot target replaced rows or overwrite the result of a newer copy', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  try {
    await login(page, app); await open(page); await add(page, '复制测试', { direction: 'reverse' });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return new Promise((_resolve, reject) => { window.rejectOldCopy = reject; }); } } }));
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    await choose(page, 2); await choose(page, 1);
    await page.evaluate(() => window.rejectOldCopy(Error('synthetic clipboard failure')));
    await expect(page.locator('.forward-copy-text')).toBeHidden();
    await expect(page.locator('#forward-agent-status')).not.toContainText('剪贴板不可用');
    await page.evaluate(() => {
      window.copyResults = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return new Promise((resolve, reject) => window.copyResults.push({ resolve, reject })); } } });
    });
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    await page.evaluate(() => window.copyResults[1].resolve());
    await expect(page.locator('#forward-agent-status')).toContainText('AI 提示词已复制');
    await page.evaluate(() => window.copyResults[0].reject(Error('synthetic older copy failure')));
    await expect(page.locator('.forward-copy-text')).toBeHidden();
    await expect(page.locator('#forward-agent-status')).toContainText('AI 提示词已复制');
  } finally { await app.close(); }
});

test('reverse Web prompts explain the scoped topology, fall back to selectable text and clear on edits or hiding; forward rules keep connection information', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*', nodeId: 'b'.repeat(32), entryBasePath: '/node/prompt-test/' });
  try {
    await login(page, app); await open(page);
    const key = await page.locator('#forward-agent-key').inputValue();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw Error('synthetic clipboard denied'); } } }));
    await page.locator('#forward-rule-add').click(); await page.locator('#forward-rule-name').fill('助手 Web 服务');
    await page.locator('#forward-host').fill('192.168.50.3'); await page.locator('#forward-protocol').selectOption('https');
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    const text = page.locator('.forward-copy-text'); await expect(text).toBeVisible(); await expect(text).toBeFocused();
    expect(await text.inputValue()).toContain('工作台入口：' + app.config.origin + '/node/prompt-test/');
    expect(await text.inputValue()).toContain('节点标识：' + 'b'.repeat(32));
    expect(await text.inputValue()).toContain('TCP 127.0.0.1:22001 → 端口映射链路 → 助手电脑 "助手1" → 目标 192.168.50.3:443');
    expect(await text.inputValue()).toContain('助手离线'); expect(await text.inputValue()).toContain("--connect-to 'SERVICE_HOST:443:127.0.0.1:22001'");
    expect(await text.inputValue()).not.toContain(key); expect(await text.inputValue()).not.toContain(app.config.password);
    expect(await text.evaluate(n => n.selectionStart === 0 && n.selectionEnd === n.value.length && n.readOnly && n.maxLength === 8192)).toBe(true);
    await page.getByRole('button', { name: '编辑规则', exact: true }).click(); await page.locator('#forward-host').fill('192.168.50.4');
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible(); await expect(text).toBeHidden(); await expect(text).toHaveValue('');
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click(); expect(await text.inputValue()).toContain('192.168.50.4:443');
    await page.evaluate(() => { window.promptTestHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.promptTestHidden }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(text).toBeHidden(); await expect(text).toHaveValue('');
    await page.evaluate(() => { window.promptTestHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#forward-agent-key')).not.toHaveValue('');
    await page.getByRole('button', { name: '编辑规则', exact: true }).click(); await page.locator('#forward-direction').selectOption('forward');
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '复制 AI 提示词', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '复制连接信息', exact: true }).click(); expect(await text.inputValue()).toContain('连接位置：助手电脑');
    expect(await text.inputValue()).not.toContain('请根据以下端口映射拓扑'); expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('serial AI prompts describe the helper device and full parameters without sending terminal input', async ({ page }) => {
  const app = await fixture({ rfb: true, forwardPorts: '*' });
  try {
    await login(page, app); await open(page);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text) { window.serialPrompt = text; } } }));
    await page.locator('#forward-rule-add').click(); await page.locator('#forward-rule-name').fill('助手串口');
    await page.locator('#forward-protocol').selectOption('serial'); await page.locator('#forward-serial-path').fill('COM7');
    await page.locator('#forward-serial-baud').selectOption('9600'); await page.locator('#forward-serial-dtr').check();
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-rule-dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    const text = await page.evaluate(() => window.serialPrompt);
    expect(text).toContain('助手电脑 "助手1" → 串口 "COM7"'); expect(text).toContain('波特率 9600，数据位 8，校验 无，停止位 1，DTR 高，RTS 低');
    expect(text).toContain('nc 127.0.0.1 22001'); expect(text).toContain('不是节点主机上的设备文件');
    expect(text).not.toContain('ssh -o'); await expect(page.locator('.forward-copy-text')).toBeHidden();
    expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});
test('reverse rules use the helper target and server loopback, copy explicit connection information, and delete only the chosen rule',async({page})=>{
 const app=await fixture({rfb:true,forwardPorts:'*'});let peer;
 try{
  await login(page,app);await open(page);const a=await choose(page,1);peer=await helper(app,a.key);
  await add(page,'路由器',{direction:'reverse'});await expect(page.locator('#forward-agent-rules')).toContainText('节点主机 127.0.0.1:');await expect(page.locator('#forward-agent-rules')).toContainText('已生效');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.connectionCopy=text;}}}));await page.getByRole('button',{name:'复制 AI 提示词'}).click();const text=await page.evaluate(()=>window.connectionCopy);expect(text).toContain('ssh -o HostKeyAlias=codex-cloud-');expect(text).not.toContain(a.key);
  await page.getByRole('button',{name:'删除规则',exact:true}).click();await expect(page.locator('#forward-agent-confirm-cancel')).toBeFocused();await page.locator('#forward-agent-confirm-accept').click();await expect(page.locator('#forward-agent-rules')).toContainText('尚无规则');await expect(page.locator('#forward-agent-connection')).toContainText('助手在线');
  expect(app.managementStats.restarts).toBe(0);expect(app.inputCalls).toEqual([]);
 }finally{peer?.close();await app.close();}
});
