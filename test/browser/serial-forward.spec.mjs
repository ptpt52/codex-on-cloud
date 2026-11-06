import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { fixture } from '../fixture.mjs';

test('serial form binds exact parameters, hides TCP fields, requires helper capability, copies a raw-byte entry and preserves the draft',async({page})=>{
 const app=await fixture({rfb:true,rfbSize:{width:640,height:480},forwardPorts:[]});let helper;
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const bodies=[];page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/forward')bodies.push(req.postDataJSON());});
 try{
  await page.goto(app.config.origin);await page.locator('#password').fill(app.config.password);await page.locator('#login-button').click();await expect(page.locator('#forward-button')).toBeEnabled();
  await page.locator('#forward-button').click();await page.locator('#forward-direction').selectOption('reverse');await page.locator('#forward-protocol').selectOption('serial');
  await expect(page.locator('#forward-serial-fields')).toBeVisible();await expect(page.locator('#forward-host')).toBeHidden();await expect(page.locator('#forward-device-save')).toBeHidden();
  await page.locator('#forward-device-name').fill('lab console');await page.locator('#forward-local').fill(String(port));await page.locator('#forward-serial-path').fill('COM3');await page.locator('#forward-serial-baud').selectOption('9600');await page.locator('#forward-serial-dtr').check();
  await expect(page.locator('#forward-create')).toBeEnabled();await page.locator('#forward-create').click();await expect(page.locator('#forward-code')).not.toHaveValue('');
  expect(bodies).toEqual([{direction:'reverse',protocol:'serial',deviceName:'lab console',localPort:port,serial:{path:'COM3',baud:9600,dataBits:8,parity:'none',stopBits:1,dtr:true,rts:false}}]);
  const code=await page.locator('#forward-code').inputValue();
  helper=new WebSocket(app.config.origin.replace('http:','ws:')+'/forward/helper','codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+code,'x-codex-forward-reverse':'1','x-codex-forward-serial':'1'}});helper.on('error',()=>{});helper.on('message',data=>{if(JSON.parse(data).type==='ready')helper.send('{"type":"listening"}');});await once(helper,'open');
  await expect(page.locator('.forward-row')).toContainText('已连接');await expect(page.locator('.forward-row')).toContainText('/1 条连接');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.serialCopied=text;}}}));
  await page.getByRole('button',{name:'复制给 Codex',exact:true}).click();expect(await page.evaluate(()=>window.serialCopied)).toContain('nc 127.0.0.1 '+port);expect(await page.evaluate(()=>window.serialCopied)).not.toContain('telnet');
  await page.locator('#forward-diagnostics-copy').click();expect(await page.locator('#forward-diagnostics-text').inputValue()).not.toContain('COM3');
  await page.locator('#forward-close').click();expect(helper.readyState).toBe(WebSocket.OPEN);await page.locator('#forward-button').click();await expect(page.locator('#forward-serial-path')).toHaveValue('COM3');
  await page.locator('#forward-protocol').selectOption('ssh');await expect(page.locator('#forward-host')).toBeVisible();await expect(page.locator('#forward-serial-fields')).toBeHidden();
  expect(bodies).toHaveLength(1);expect(app.inputCalls).toEqual([]);expect(app.managementStats.restarts).toBe(0);
 }finally{helper?.terminate();await app.close();}
});
