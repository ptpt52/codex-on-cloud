import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fixture } from '../fixture.mjs';
import { FORWARD_ERRORS } from '../../panel/forward-errors.mjs';
import { FORWARD_CLIENTS } from '../../panel/public/forward-platform.js';

async function login(page, app) {
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('桌面在线'); await expect(page.locator('#forward-button')).toBeEnabled();
}
async function paired(app, code, path = '/forward/helper', resume = false) {
  const ws=new WebSocket(app.config.origin.replace('http','ws')+path,'codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+code,...(resume?{'x-codex-forward-resume':'1'}:{})}});
  ws.on('error',()=>{});let ready;ws.on('message',data=>{const value=JSON.parse(data);if(value.type==='ready'){ready=value;ws.send('{"type":"listening"}');}});
  await once(ws,'open');return {ws,get ready(){return ready;}};
}

test('Windows helper download, explicit pairing, status and default-cancel stop work without terminal input or restarting the desktop',async({page},info)=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-forward-browser-')),name='codex-cloud-forward-windows-amd64.exe',bytes=Buffer.from('MZ MOCK browser download, not an executable');
  await writeFile(join(directory,name),bytes);await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,files:[{arch:'windows-amd64',name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),build:'browser-test'}]}));
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480},forwardDownloadDir:directory});let helper;
  try{
    await login(page,app);await page.locator('#forward-button').click();await expect(page.locator('#forward-dialog')).toBeVisible();
    const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'下载 Windows x64 助手'}).click();const download=await downloading;expect(download.suggestedFilename()).toBe(name);
    await page.locator('#forward-create').click();await expect(page.locator('#forward-code')).not.toHaveValue('');
    const code=await page.locator('#forward-code').inputValue();expect(code).toHaveLength(43);
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.forwardCopied=text;}}});});
    await page.locator('#forward-copy').click();expect(await page.evaluate(()=>window.forwardCopied)).toBe(code);
    helper=await paired(app,code);await expect(page.locator('.forward-row')).toContainText('已连接');
    await page.screenshot({path:'test-results/'+info.project.name+'-tcp-forward.png'});
    await page.locator('.forward-row button').click();await expect(page.locator('#forward-cancel-stop')).toBeFocused();await page.keyboard.press('Enter');
    await expect(page.locator('#forward-confirm')).not.toBeVisible();expect(helper.ws.readyState).toBe(WebSocket.OPEN);
    await page.locator('#forward-close').click();expect(helper.ws.readyState).toBe(WebSocket.OPEN);
    await page.locator('#terminal-mode').click();await page.locator('#accept-confirmation').click();
    await expect(page.locator('#connection-status')).toContainText('终端在线');expect(helper.ws.readyState).toBe(WebSocket.OPEN);
    await page.locator('#forward-button').click();await expect(page.locator('.forward-row')).toContainText('已连接');
    await expect(page.locator('#forward-code')).toHaveValue('');await page.locator('.forward-row button').click();const stopped=once(helper.ws,'close');await page.locator('#forward-accept-stop').click();await stopped;
    await expect(page.locator('#forward-list')).toContainText('尚未创建映射');
    expect(app.inputCalls).toEqual([]);expect(app.terminalInputs).toEqual([]);expect(app.managementStats.restarts).toBe(0);
  }finally{helper?.ws.terminate();await app.close();await rm(directory,{recursive:true,force:true});}
});

test('recovering mappings display their deadline, preserve stop confirmation and return to the same active row without a new pairing',async({page})=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480}});let helper,resumed,creates=0;
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/forward')creates++;});
  try{
    await login(page,app);await page.locator('#forward-button').click();await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).not.toHaveValue('');
    helper=await paired(app,await page.locator('#forward-code').inputValue(),'/forward/helper',true);
    await expect(page.locator('.forward-row')).toContainText('已连接');const token=helper.ready.resumeToken,id=helper.ready.id;
    const closed=once(helper.ws,'close');helper.ws.terminate();await closed;await page.locator('#forward-refresh').click();
    await expect(page.locator('.forward-row')).toContainText('正在自动恢复');await expect(page.locator('.forward-row')).toContainText('剩余');
    await expect(page.locator('.forward-row')).toHaveAttribute('data-forward',id);await expect(page.locator('#forward-code')).toHaveValue('');
    await page.locator('.forward-row button').click();await expect(page.locator('#forward-cancel-stop')).toBeFocused();await page.keyboard.press('Enter');
    await expect(page.locator('#forward-confirm')).toBeHidden();await expect(page.locator('.forward-row')).toContainText('正在自动恢复');
    resumed=await paired(app,token,'/forward/resume',true);await page.locator('#forward-refresh').click();
    await expect(page.locator('.forward-row')).toContainText('已连接');await expect(page.locator('.forward-row')).toHaveAttribute('data-forward',id);
    expect(creates).toBe(1);expect(app.inputCalls).toEqual([]);expect(app.terminalInputs).toEqual([]);expect(app.managementStats.restarts).toBe(0);
    const disconnected=once(resumed.ws,'close');resumed.ws.terminate();await disconnected;await page.locator('#forward-refresh').click();
    await expect(page.locator('.forward-row')).toContainText('正在自动恢复');await page.locator('.forward-row button').click();await page.locator('#forward-accept-stop').click();
    await expect(page.locator('#forward-recent')).toContainText('映射已由网页明确停止');await expect(page.locator('.forward-row')).toHaveCount(0);
  }finally{helper?.ws.terminate();resumed?.ws.terminate();await app.close();}
});

test('reload and takeover retain helper authorization; only the current owner manages server-forward mappings',async({page,context},info)=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480}});let helper;
  try{
    if(info.project.name==='mobile')await page.setViewportSize({width:320,height:700});
    await login(page,app);await page.locator('#forward-button').click();await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).not.toHaveValue('');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('#forward-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    for(const id of ['forward-create','forward-local','forward-host','forward-target','forward-copy']){
      const box=await page.locator('#'+id).boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
    }
    helper=await paired(app,await page.locator('#forward-code').inputValue());await expect(page.locator('.forward-row')).toContainText('已连接');
    await page.reload();await expect(page.locator('#connection-status')).toContainText('桌面在线');expect(helper.ws.readyState).toBe(WebSocket.OPEN);
    await page.locator('#forward-button').click();await expect(page.locator('.forward-row')).toContainText('已连接');await expect(page.locator('#forward-code')).toHaveValue('');
    const second=await context.newPage();
    await second.goto(app.config.origin);await expect(second.locator('#connection-status')).toContainText('桌面在线');
    await expect(page.locator('#takeover-button')).toBeVisible({timeout:10000});await expect(page.locator('#forward-dialog')).toBeVisible();expect(helper.ws.readyState).toBe(WebSocket.OPEN);
    await second.locator('#forward-button').click();await expect(second.locator('.forward-row')).toContainText('已连接');
    await expect(page.locator('.forward-row')).toHaveCount(0);await expect(page.locator('#forward-direction')).toHaveValue('reverse');
    await second.locator('.forward-row button').click();const closed=once(helper.ws,'close');await second.locator('#forward-accept-stop').click();await closed;
    await expect(page.locator('#forward-recent')).not.toContainText('映射已由网页明确停止');await expect(second.locator('#forward-recent')).toContainText('映射已由网页明确停止');
    expect(app.managementStats.restarts).toBe(0);await second.close();
  }finally{helper?.ws.terminate();await app.close();}
});

test('helper startup and target failures stay visible after refresh and lost pairing text is never restored',async({page})=>{
  const closedTarget=net.createServer();closedTarget.listen(0,'127.0.0.1');await once(closedTarget,'listening');const port=closedTarget.address().port;await new Promise(resolve=>closedTarget.close(resolve));
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480},forwardPorts:[port]});let helper,data;
  try{
    await login(page,app);await page.locator('#forward-button').click();await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).not.toHaveValue('');const code=await page.locator('#forward-code').inputValue();
    helper=new WebSocket(app.config.origin.replace('http','ws')+'/forward/helper','codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+code}});helper.on('error',()=>{});
    helper.on('message',bytes=>{if(JSON.parse(bytes).type==='ready')helper.send('{"type":"error","code":"local_port_in_use"}');});const failed=once(helper,'close');await failed;
    await expect(page.locator('#forward-status')).toContainText('端口已被占用');await expect(page.locator('#forward-code')).toHaveValue('');
    await page.reload();await expect(page.locator('#forward-button')).toBeEnabled();await page.locator('#forward-button').click();
    await expect(page.locator('#forward-recent')).toContainText('端口已被占用');await expect(page.locator('#forward-code')).toHaveValue('');
    await page.locator('#forward-create').click();await expect(page.locator('#forward-code')).not.toHaveValue('');const active=await paired(app,await page.locator('#forward-code').inputValue());helper=active.ws;
    await expect(page.locator('.forward-row')).toContainText('已连接');
    data=new WebSocket(app.config.origin.replace('http','ws')+'/forward/data','codex-forward-v1',{headers:{origin:app.config.origin,authorization:'Bearer '+active.ready.streamToken}});data.on('error',()=>{});await once(data,'close');
    await expect(page.locator('.forward-row')).toContainText('目标端口无法连接');expect(helper.readyState).toBe(WebSocket.OPEN);
  }finally{helper?.terminate();data?.terminate();await app.close();}
});

for (const failure of ['lost', 'truncated']) test(`a ${failure} create response is not retried and can be reconciled through the mapping list`,async({page})=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480}});let creates=0;
  try{
    await login(page,app);
    await page.route('**/api/forward',async route=>{
      if(route.request().method()==='POST'){creates++;await route.fetch();if(failure==='lost')await route.abort('failed');else await route.fulfill({status:200,contentType:'application/json',body:'{"id":'});}
      else await route.continue();
    });
    await page.locator('#forward-button').click();await page.locator('#forward-create').click();
    await expect(page.locator('#forward-status')).toContainText('结果未知');
    await expect(page.locator('#forward-list .forward-row')).toHaveCount(1);await expect(page.locator('#forward-code')).toHaveValue('');
    await page.locator('#forward-refresh').click();await expect(page.locator('#forward-list .forward-row')).toHaveCount(1);expect(creates).toBe(1);
    expect(app.inputCalls).toEqual([]);expect(app.managementStats.restarts).toBe(0);
  }finally{await app.close();}
});

test('a cached page from before the Mac notice still loads and updates port mappings with newer scripts', async ({ page }) => {
  const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(app.config.origin + '/', async route => {
      const response = await route.fetch(), html = await response.text();
      await route.fulfill({ response, body: html.replace(/<p id="forward-mac-notice"[^]*?<\/p>/, '') });
    });
    await login(page, app); await page.locator('#forward-button').click(); await expect(page.locator('#forward-create')).toBeEnabled();
    await page.locator('#forward-create').click(); await expect(page.locator('#forward-code')).not.toHaveValue('');
    await page.locator('#forward-refresh').click(); await expect(page.locator('#forward-list .forward-row')).toHaveCount(1);
    expect(errors).toEqual([]); expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('a late clipboard denial cannot focus a cleared code or overwrite the connected status',async({page})=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480}});let helper;
  try{
    await login(page,app);await page.locator('#forward-button').click();await page.locator('#forward-create').click();
    await expect(page.locator('#forward-code')).not.toHaveValue('');const code=await page.locator('#forward-code').inputValue();
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((_resolve,reject)=>{window.rejectForwardCopy=reject;})}}));
    await page.locator('#forward-copy').click();helper=await paired(app,code);
    await expect(page.locator('#forward-status')).toContainText('助手已连接');await expect(page.locator('#forward-pair')).toBeHidden();
    await page.evaluate(()=>window.rejectForwardCopy(new Error('denied')));
    await expect(page.locator('#forward-status')).toContainText('助手已连接');await expect(page.locator('#forward-code')).not.toBeFocused();
  }finally{helper?.ws.terminate();await app.close();}
});

test('route diagnostics distinguish new-connection preference from mixed existing streams and explain fallback',async({page},info)=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480}});let helper,available=true;
  try{
    if(info.project.name==='mobile')await page.setViewportSize({width:320,height:800});
    await page.route('**/api/forward',async route=>{
      if(route.request().method()!=='GET')return route.continue();
      const response=await route.fetch(),data=await response.json();
      if(data.mappings[0])Object.assign(data.mappings[0],{connections:2,directConnections:1,direct:{available,family:available?'IPv6':null,rttMs:available?9:null,reason:available?'':'rtc_health_timeout',note:available?'':FORWARD_ERRORS.rtc_health_timeout}});
      await route.fulfill({response,json:data});
    });
    await login(page,app);await page.locator('#forward-button').click();await page.locator('#forward-create').click();await expect(page.locator('#forward-code')).not.toHaveValue('');
    helper=await paired(app,await page.locator('#forward-code').inputValue());
    await expect(page.locator('.forward-row')).toContainText('新连接：IPv6 / UDP 加密直连');await expect(page.locator('.forward-network')).toContainText('直连 1 / 中转 1');await expect(page.locator('.forward-network')).toContainText('9 ms');
    expect(await page.locator('#forward-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.screenshot({path:'test-results/'+info.project.name+'-tcp-direct.png'});
    available=false;await page.locator('#forward-refresh').click();await expect(page.locator('.forward-row')).toContainText('新连接：本机 WebSocket 测试');
    await expect(page.locator('.forward-network')).toContainText('直连心跳超时');await expect(page.locator('.forward-network')).toContainText('直连 1 / 中转 1');
    expect(helper.ws.readyState).toBe(WebSocket.OPEN);expect(app.inputCalls).toEqual([]);expect(app.terminalInputs).toEqual([]);expect(app.managementStats.restarts).toBe(0);
  }finally{helper?.ws.terminate();await app.close();}
});

for (const host of ['192.168.1.10', '2001:db8:1234:5678:9abc:def0:1234:5678']) {
  test(`custom ${host} target stays bound across form edits, polling and recovery`, async ({page},info) => {
    const app=await fixture({rfb:true,rfbSize:{width:640,height:480},forwardPorts:'*'}); let helper,resumed;
    const destination=(host.includes(':')?'['+host+']':host)+':5432';
    try {
      if(info.project.name==='mobile')await page.setViewportSize({width:320,height:800});
      await login(page,app);await page.locator('#forward-button').click();
      await expect(page.locator('#forward-port-policy')).toContainText('可自定义目标端口');
      await page.locator('#forward-host').fill(host);await page.locator('#forward-target').fill('5432');
      const create=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/forward');
      await page.locator('#forward-create').click();expect((await create).postDataJSON()).toEqual({localPort:2222,targetHost:host,targetPort:5432});
      await expect(page.locator('#forward-code')).not.toHaveValue('');const code=await page.locator('#forward-code').inputValue();
      await expect(page.locator('.forward-row')).toContainText(destination);
      await page.locator('#forward-host').fill('192.168.1.20');await page.locator('#forward-target').fill('3306');await page.locator('#forward-refresh').click();
      await expect(page.locator('#forward-host')).toHaveValue('192.168.1.20');await expect(page.locator('#forward-target')).toHaveValue('3306');
      helper=await paired(app,code,'/forward/helper',true);await expect(page.locator('.forward-row')).toContainText('已连接');
      expect(helper.ready.targetHost).toBe(host);expect(helper.ready.targetPort).toBe(5432);
      const closed=once(helper.ws,'close');helper.ws.terminate();await closed;await page.locator('#forward-refresh').click();await expect(page.locator('.forward-row')).toContainText('正在自动恢复');
      resumed=await paired(app,helper.ready.resumeToken,'/forward/resume',true);await page.locator('#forward-refresh').click();await expect(page.locator('.forward-row')).toContainText('已连接');
      expect(resumed.ready.targetHost).toBe(host);expect(resumed.ready.targetPort).toBe(5432);
      await page.locator('.forward-row button').click();await expect(page.locator('#forward-confirm-description')).toContainText(destination);
      await page.keyboard.press('Enter');expect(resumed.ws.readyState).toBe(WebSocket.OPEN);
      expect(await page.locator('#forward-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
      await page.locator('.forward-row button').click();await page.locator('#forward-accept-stop').click();
      await expect(page.locator('#forward-recent')).toContainText(destination);
      expect(app.inputCalls).toEqual([]);expect(app.terminalInputs).toEqual([]);expect(app.managementStats.restarts).toBe(0);
    } finally { helper?.ws.terminate();resumed?.ws.terminate();await app.close(); }
  });
}

test('custom target validation retains drafts and server port restrictions while an empty policy disables creation',async({page})=>{
  const app=await fixture({rfb:true,rfbSize:{width:640,height:480},forwardPorts:[5432]});
  try {
    await login(page,app);await page.locator('#forward-button').click();await expect(page.locator('#forward-target')).toHaveValue('5432');
    await expect(page.locator('#forward-port-policy')).toContainText('5432');
    await page.locator('#forward-host').fill('example.com');await page.locator('#forward-create').click();await expect(page.locator('#forward-status')).toContainText('目标 IP 需为 IPv4 或 IPv6');
    await expect(page.locator('#forward-host')).toHaveValue('example.com');await expect(page.locator('.forward-row')).toHaveCount(0);
    await page.locator('#forward-host').fill('192.168.1.10');await page.locator('#forward-target').fill('3306');await page.locator('#forward-create').click();
    await expect(page.locator('#forward-status')).toContainText('服务器端口限制');await expect(page.locator('.forward-row')).toHaveCount(0);
    app.config.forwardPorts=[];await page.locator('#forward-refresh').click();await expect(page.locator('#forward-create')).toBeDisabled();await expect(page.locator('#forward-port-policy')).toContainText('禁用');
    expect(app.inputCalls).toEqual([]);expect(app.terminalInputs).toEqual([]);
  } finally { await app.close(); }
});

for (const architecture of ['arm', 'x86', 'unavailable']) {
  test(`Mac ${architecture} hints recommend the matching package or leave chip choice manual while preserving all downloads`, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mac-downloads-')), files = [];
    for (const [arch, client] of Object.entries(FORWARD_CLIENTS)) {
      const bytes = Buffer.from('download fixture ' + arch); await writeFile(join(directory, client.name), bytes);
      files.push({ arch, name: client.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), build: 'mac-browser-test' });
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }));
    const app = await fixture({ rfb: true, rfbSize: { width: 640, height: 480 }, forwardDownloadDir: directory });
    try {
      await page.addInitScript(architecture => {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS',
          async getHighEntropyValues() { if (architecture === 'unavailable') throw new Error('denied'); return { architecture, bitness: '64' }; } } });
      }, architecture);
      await login(page, app); await page.locator('#forward-button').click(); await expect(page.locator('.forward-download')).toHaveCount(4);
      const expected = architecture === 'arm' ? 'darwin-arm64' : 'darwin-amd64';
      if (architecture === 'unavailable') {
        await expect(page.locator('#forward-platform-note')).toContainText('浏览器未确认芯片架构'); await expect(page.locator('.forward-download.recommended')).toHaveCount(0);
      } else {
        await expect(page.locator('.forward-download.recommended')).toHaveAttribute('data-arch', expected);
        await expect(page.locator('.forward-download').first()).toHaveAttribute('data-arch', expected);
      }
      const manual = architecture === 'arm' ? 'darwin-amd64' : 'darwin-arm64';
      const downloading = page.waitForEvent('download'); await page.locator(`.forward-download[data-arch="${manual}"] a`).click();
      expect((await downloading).suggestedFilename()).toBe(FORWARD_CLIENTS[manual].name);
      await expect(page.locator('#forward-mac-help')).toHaveAttribute('open', ''); await expect(page.locator('#forward-mac-help')).toContainText('Start.command');
      await expect(page.locator('#forward-mac-help')).toContainText('macOS 12'); await expect(page.locator('#forward-mac-help')).toContainText('仍要打开');
      await expect(page.locator('#forward-mac-notice')).toBeVisible(); await expect(page.locator('#forward-mac-notice')).toContainText('Apple 无法验证');
      expect(await page.locator('#forward-dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.locator('#forward-refresh').click(); await expect(page.locator('.forward-download')).toHaveCount(4);
      await page.locator('#forward-mac-help summary').click(); await expect(page.locator('#forward-mac-help')).not.toHaveAttribute('open', '');
      await page.locator('#forward-refresh').click(); await expect(page.locator('#forward-mac-help')).not.toHaveAttribute('open', '');
      await expect(page.locator('#forward-mac-notice')).toBeVisible();
      expect(app.inputCalls).toEqual([]); expect(app.terminalInputs).toEqual([]); expect(app.managementStats.restarts).toBe(0);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
