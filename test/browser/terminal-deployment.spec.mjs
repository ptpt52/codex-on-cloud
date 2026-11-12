import {test,expect} from '@playwright/test';
import {fixture} from '../fixture.mjs';
import {openInput,openTools} from './ui.mjs';

test('terminal-only login overrides a saved desktop preference, hides unavailable controls and restores the same target',async({page},info)=>{
  const app=await fixture({mode:'terminal'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.addInitScript(()=>localStorage.setItem('codex-cloud.display.v1',JSON.stringify({layout:2,mode:'desktop',autoResolution:true})));
    await page.goto(app.config.origin);await page.locator('#password').fill(app.config.password);await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.frameLocator('#desktop-frame').locator('.xterm-screen')).toBeVisible();
    await expect(page.locator('#desktop-mode')).toBeHidden();await expect(page.locator('#terminal-mode')).toBeHidden();
    await openTools(page);await expect(page.locator('#desktop-settings-button')).toBeHidden();await expect(page.locator('#terminal-view-controls')).toBeVisible();
    await openInput(page);await expect(page.locator('#clipboard-button')).toBeHidden();
    await page.locator('#mobile-input').fill('纯终端草稿');await page.locator('#paste-button').click();await expect.poll(()=>app.terminalInputs.length).toBe(1);
    expect(app.terminalInputs[0].text).toBe('\x1b[200~纯终端草稿\x1b[201~');expect(app.inputCalls).toEqual([]);
    await openInput(page);await page.locator('#shortcuts-button').click();await expect(page.locator('[data-shortcut="Ctrl+Shift+V"]')).toBeHidden();await page.keyboard.press('Escape');
    await openTools(page);await page.locator('#terminal-view-manage').click();await page.locator('#new-terminal-name').fill('纯终端辅助会话');
    await page.locator('#create-terminal').click();await expect(page.locator('#action-confirmation')).toContainText('新建终端');await page.locator('#accept-confirmation').click();
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');await page.locator('#close-terminals').click();
    await page.reload();await expect(page.locator('#connection-status')).toContainText('终端在线');
    await expect(page.locator('#input-terminal')).toHaveValue('aux1');expect(app.terminalInputs.length).toBe(1);
    expect(app.managementStats.restarts).toBe(0);expect(app.terminalConnections).toBeGreaterThanOrEqual(2);expect(errors).toEqual([]);
    await page.screenshot({path:`test-results/${info.project.name}-terminal-only.png`});
  }finally{await app.close();}
});

test('terminal-only deployment retains encrypted direct terminal transport and protected helper input',async({page})=>{
  const app=await fixture({mode:'terminal',webrtc:true});
  try{
    await page.goto(app.config.origin);await page.locator('#password').fill(app.config.password);await page.locator('#login-button').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线',{timeout:20000});
    await page.locator('#connection-button').click();await expect(page.locator('#diag-transport')).toHaveText(/^WebRTC 加密直连(?:（局域网）)? · 文字终端$/);
    await expect(page.locator('#diag-network')).toHaveText('IPv4 / UDP');await page.locator('#close-connection').click();
    await openInput(page);await page.locator('#mobile-input').fill('直连纯终端');await page.locator('#paste-button').click();
    await expect.poll(()=>app.terminalInputs.length).toBe(1);expect(app.terminalInputs[0].text).toBe('\x1b[200~直连纯终端\x1b[201~');expect(app.inputCalls).toEqual([]);
  }finally{await app.close();}
});
