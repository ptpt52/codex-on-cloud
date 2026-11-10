import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { deploy, options, checkHealth } from '../scripts/deploy.mjs';
import { serviceUnits } from '../native/service-units.mjs';

async function harness(t, { active = [], installed = true, failure = '', bus = 'degraded\n', healthError } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex deploy 中文 '));
  t.after(() => rm(root,{recursive:true,force:true}));
  const calls = [], logs = [], wslCalls = [], events = []; let healthy = false;
  const config = 'PUBLIC_ORIGIN=http://localhost:36080\nPANEL_PORT=36080\n';
  const context = {root, platform:'linux',uid:1000,username:'test-user',nodeVersion:'24.0.0',log:text=>logs.push(text),
    wslNetwork:async options=>{wslCalls.push(options);return{};},
    health:async()=>{events.push('health');if(healthError)throw new Error(healthError);healthy=true;},
    run:async(command,args,flags)=>{
      calls.push({command,args:[...args],capture:flags.capture});assert.ok(calls.length<=40);
      if(args[0]==='scripts/provision-cloudflare.mjs')events.push(args.at(-1));
      if(args.includes('is-system-running'))return{status:bus?'degraded'===bus.trim()?1:0:1,stdout:bus};
      if(args.includes('is-active'))return{status:active.includes(args.at(-1))||calls.some(c=>c.args.includes('start'))?0:3};
      if(command==='npm'&&args[0]==='ls')return{status:installed?0:1};
      if(args.includes(failure))return{status:1};
      if(args[0]==='scripts/setup.mjs'){
        await mkdir(join(root,'secrets'),{recursive:true});
        const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'desktop';
        try{await writeFile(join(root,'.env'),'DEPLOY_MODE='+mode+'\n'+config,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
      }
      if(args[0]==='scripts/provision-cloudflare.mjs'){
        await writeFile(join(root,'.env'),'PUBLIC_ORIGIN=https://desktop.example.com\n');
        await writeFile(join(root,'secrets','tunnel_token'),'fake_tunnel_token');
      }
      return{status:0,stdout:''};
    }};
  context.publicationFactory=async values=>Object.fromEntries([['prepare','--prepare-only'],['commit','--commit-only'],['rollback','--rollback']].map(([action,flag])=>[action,async()=>{
    const result=await context.run(process.execPath,['scripts/provision-cloudflare.mjs','--domain',values.domain,'--zone',values.zone,'--api-token-file',values['api-token-file'],flag],{capture:false});
    if(result.status!==0)throw Error('synthetic publication failure');return action==='rollback'?{rolledBack:true}:{};
  }]));
  return {root,calls,logs,wslCalls,events,context,get healthy(){return healthy;}};
}

test('deploy options validate public configuration before work and do not accept unknown flags',()=>{
  assert.equal(options([]).check,undefined);assert.equal(options(['--check','--install-deps']).check,true);
  for(const args of [['--domain','desktop.example.com'],['--zone','example.com'],['--origin','https://user:password@example.com'],['--origin','https://example.com/path'],['--restart-desktop'],['--domain','elsewhere.test','--zone','example.com','--api-token-file','file']])assert.throws(()=>options(args));
  assert.equal(options(['--help']).help,true);
  assert.throws(()=>options(['--mode','invalid']));
});

test('terminal-only deployment installs minimal packages and production JS without graphical services', async t => {
  const h=await harness(t);await deploy(options(['--mode','terminal','--install-deps']),h.context);
  const install=h.calls.find(c=>c.command==='sudo'&&c.args[1]==='install');
  assert.deepEqual(install.args.slice(6),['tmux','python3','util-linux']);
  assert.ok(h.calls.some(c=>c.command==='npm'&&c.args.join(',')==='ci,--omit=dev,--omit=optional'));
  assert.match(await readFile(join(h.root,'.env'),'utf8'),/DEPLOY_MODE=terminal/);
  const units=serviceUnits('/app','/bin',process.execPath,'terminal');
  assert.deepEqual([...units.keys()],['codex-cloud-terminal.service','codex-cloud-files.service','codex-cloud-manager.service','codex-cloud-panel.service','codex-cloud-tunnel.service']);
  assert.ok([...units.values()].every(text=>!text.includes('desktop.mjs')&&!text.includes('desktop-worker.mjs')&&!text.includes('PartOf=')));
  assert.match(units.get('codex-cloud-terminal.service'),/Restart=no/);
  assert.ok(h.calls.every(c=>c.capture||!c.args.some(arg=>/codex-cloud-(desktop|actions)/.test(arg))));
});

test('deployment mode is retained on rerun and a requested conversion stops before installing or touching services', async t => {
  const h=await harness(t);await writeFile(join(h.root,'.env'),'DEPLOY_MODE=terminal\nPUBLIC_ORIGIN=http://localhost:36080\n');
  await assert.rejects(deploy(options(['--mode','desktop','--install-deps']),h.context),/不会自动切换/);assert.equal(h.calls.length,0);
  await deploy({},h.context);assert.ok(h.calls.some(c=>c.args.includes('codex-cloud-terminal.service')));
  assert.ok(h.calls.every(c=>c.capture||!c.args.some(arg=>/codex-cloud-(desktop|actions)/.test(arg))));
});

test('a live desktop in another deployment prevents terminal installation before any mutation',async t=>{
  const h=await harness(t,{active:['codex-cloud-desktop.service']});
  await assert.rejects(deploy(options(['--mode','terminal','--install-deps']),h.context),/另一部署模式仍在运行/);
  assert.ok(h.calls.every(c=>c.capture));await assert.rejects(readFile(join(h.root,'.env')),{code:'ENOENT'});
});

test('unsupported host, root and old Node are rejected before any subprocess or changes',async t=>{
  const h=await harness(t);
  for(const override of [{platform:'darwin'},{uid:0},{nodeVersion:'20.1.0'}])await assert.rejects(deploy({}, {...h.context,...override}));
  assert.equal(h.calls.length,0);
  await assert.rejects(readFile(join(h.root,'.env')),{code:'ENOENT'});
});

test('check-only tolerates a degraded user manager and performs no installs, setup, service or Cloudflare mutations',async t=>{
  const h=await harness(t);await deploy(options(['--check','--install-deps','--enable-linger','--build-forward']),h.context);
  assert.deepEqual(h.calls.map(c=>c.args),[['--user','is-system-running'],['scripts/native.mjs','doctor']]);
  assert.equal(h.healthy,false);await assert.rejects(readFile(join(h.root,'.env')),{code:'ENOENT'});
});

test('deployment preserves a pending shared-entry activation before setup or service mutations', async t => {
  const h = await harness(t); await mkdir(join(h.root, 'data'), { mode: 0o700 });
  const file = join(h.root, 'data/cloudflare-activation.json'); await writeFile(file, '{}', { mode: 0o600 });
  await assert.rejects(deploy(options(['--install-deps']), h.context), /共享入口切换待核对/);
  assert.ok(h.calls.every(call => call.capture)); assert.equal(await readFile(file, 'utf8'), '{}');
  await assert.rejects(readFile(join(h.root, '.env')), { code: 'ENOENT' });
});

test('deployment protects unfinished gateway enrollment and prevents DNS publication for fixed gateways before mutation', async t => {
  for (const [name, args, error] of [
    ['gateway-join.json', ['--install-deps'], /网关接入尚未完成/],
    ['gateway-node.json', ['--domain', 'desk.example.test', '--zone', 'example.test'], /固定网关/],
  ]) {
    const h = await harness(t); await mkdir(join(h.root, 'data'), { mode: 0o700 });
    const file = join(h.root, 'data', name); await writeFile(file, '{}', { mode: 0o600 });
    await assert.rejects(deploy(options(args), h.context), error);
    assert.ok(h.calls.every(call => call.capture)); assert.equal(await readFile(file, 'utf8'), '{}');
    await assert.rejects(readFile(join(h.root, '.env')), { code: 'ENOENT' });
  }
});

test('a completed gateway node rejects an incompatible deployment origin before setup or service changes', async t => {
  const h = await harness(t); await mkdir(join(h.root, 'data'), { mode: 0o700 });
  await writeFile(join(h.root, 'data/gateway-node.json'), JSON.stringify({ version: 1, origin: 'https://desk.example.test', backendOrigin: 'https://node.example.test', nodeId: '1'.repeat(32), name: '节点', secret: 'a'.repeat(64), registeredAt: 1 }), { mode: 0o600 });
  await assert.rejects(deploy(options(['--origin', 'https://other.example.test']), h.context), /固定网关/);
  assert.equal(h.calls.length, 0); await assert.rejects(readFile(join(h.root, '.env')), { code: 'ENOENT' });
});

test('missing user bus stops before initialization rather than reporting a working deployment',async t=>{
  const h=await harness(t,{bus:''});await assert.rejects(deploy({},h.context),/systemd 用户服务/);assert.equal(h.calls.length,1);
});

test('deployment configures WSL automatically, while check-only only diagnoses and reports a missing setting', async t => {
  const h = await harness(t);
  await deploy({ mode: 'terminal' }, { ...h.context, wslNetwork: async options => {
    assert.equal(options.check, false);
    assert.ok(h.calls.some(call => call.args[0] === 'scripts/native.mjs' && call.args[1] === 'install'));
    assert.ok(h.calls.every(call => !call.args.includes('start')));
    return { restartRequired: true };
  } });
  assert.ok(h.logs.some(line => line.includes('WSL 网络配置待生效')));
  assert.ok(h.calls.every(call => !call.args.includes('--shutdown') && !call.args.includes('stop') && !call.args.includes('restart')));
  const check = await harness(t);
  await assert.rejects(deploy({ check: true }, { ...check.context, wslNetwork: async options => {
    assert.equal(options.check, true); return { needsConfiguration: true };
  } }), /直连配置待修复/);
  assert.ok(check.calls.every(call => call.capture || call.args[1] === 'doctor'));
  assert.ok(check.logs.every(line => !line.includes('环境检查通过')));
  await assert.rejects(readFile(join(check.root, '.env')), { code: 'ENOENT' });
});

test('explicit opt-out and disabled WebRTC preserve WSL settings, and failed preflight never configures them', async t => {
  const skip = await harness(t);
  await deploy(options(['--mode', 'terminal', '--skip-wsl-network']), skip.context);
  assert.equal(skip.wslCalls.length, 0);
  const disabled = await harness(t);
  await writeFile(join(disabled.root, '.env'), 'DEPLOY_MODE=terminal\nWEBRTC_ENABLED=0\n');
  await deploy({}, disabled.context); assert.equal(disabled.wslCalls.length, 0);
  const busy = await harness(t, { active: ['codex-cloud-panel.service'], installed: false });
  await assert.rejects(deploy({}, busy.context)); assert.equal(busy.wslCalls.length, 0);
});

test('first deployment installs locked dependencies and initializes, enables and starts services before checking readiness',async t=>{
  const h=await harness(t);await deploy({},h.context);
  const actions=h.calls.filter(c=>!c.capture).map(c=>c.args);
  assert.deepEqual(actions,[['ci'],['scripts/setup.mjs'],['scripts/native.mjs','install'],['scripts/native.mjs','start']]);
  assert.equal(h.healthy,true);assert.ok(h.logs.some(line=>line.includes('部署完成')));
  assert.ok(h.calls.every(c=>c.command!=='sudo'&&!c.args.includes('restart')));
});

test('rerunning updates active gateways and file services while preserving dependencies, credentials and desktop lifetime',async t=>{
  const h=await harness(t,{active:['codex-cloud-desktop.service','codex-cloud-manager.service','codex-cloud-files.service','codex-cloud-panel.service']});
  await writeFile(join(h.root,'.env'),'PUBLIC_ORIGIN=http://existing.test:36080\nDESKTOP_SIZE=1920x2000\n');
  await mkdir(join(h.root,'secrets'));await writeFile(join(h.root,'secrets','credentials.txt'),'retained test credential');
  await deploy({},h.context);
  assert.ok(h.calls.every(c=>!c.args.includes('ci')&&!c.args.includes('stop')));
  assert.deepEqual(h.calls.filter(c=>c.args.includes('restart')).map(c=>c.args.at(-1)),['codex-cloud-files.service','codex-cloud-manager.service','codex-cloud-panel.service']);
  assert.match(await readFile(join(h.root,'.env'),'utf8'),/1920x2000/);
  assert.equal(await readFile(join(h.root,'secrets','credentials.txt'),'utf8'),'retained test credential');
});

test('active services with broken dependencies stop before sudo, npm ci or changing configuration',async t=>{
  const h=await harness(t,{active:['codex-cloud-panel.service'],installed:false});
  await assert.rejects(deploy({'install-deps':true},h.context),/保留当前任务/);
  assert.ok(h.calls.every(c=>c.capture));await assert.rejects(readFile(join(h.root,'.env')),{code:'ENOENT'});
});

test('system packages and linger require their explicit flags, and failed steps do not continue',async t=>{
  const h=await harness(t);await deploy({'install-deps':true,'enable-linger':true},h.context);
  const sudo=h.calls.filter(c=>c.command==='sudo');assert.equal(sudo.length,3);
  assert.deepEqual(sudo.at(-1).args,['loginctl','enable-linger','test-user']);
  assert.ok(sudo[1].args.includes('fonts-noto-cjk'));
  assert.ok(sudo[1].args.includes('--no-upgrade'));assert.ok(sudo[1].args.includes('--no-remove'));
  const failed=await harness(t,{failure:'install'});await assert.rejects(deploy({},failed.context),/失败/);
  assert.ok(failed.calls.every(c=>!c.args.includes('start')));assert.equal(failed.healthy,false);
});

test('public deployment uses secrets/cf_token without requiring an explicit token argument or logging its value', async t => {
  const h = await harness(t); await mkdir(join(h.root, 'secrets'), { mode: 0o700 });
  const token = 'synthetic_conventional_cf_token', file = join(h.root, 'secrets/cf_token'); await writeFile(file, token, { mode: 0o600 });
  await deploy(options(['--domain', 'desktop.example.com', '--zone', 'example.com']), h.context);
  assert.ok(h.calls.find(call => call.args[0] === 'scripts/provision-cloudflare.mjs').args.includes(file));
  assert.equal(JSON.stringify([h.calls, h.logs]).includes(token), false); assert.equal(h.healthy, true);
});

test('explicit public deployment passes token file as an argument, builds after origin setup and restarts only an existing panel',async t=>{
  const h=await harness(t,{active:['codex-cloud-desktop.service','codex-cloud-panel.service']});
  const file=join(h.root,'api token $(literal).txt'),secret='fake_test_api_token_never_log';await writeFile(file,secret);
  await deploy(options(['--domain','desktop.example.com','--zone','example.com','--api-token-file',file,'--build-forward']),h.context);
  const actions=h.calls.filter(c=>!c.capture);
  assert.ok(actions.find(c=>c.args[0]==='scripts/setup.mjs').args.includes('https://desktop.example.com'));
  assert.ok(actions.find(c=>c.args[0]==='scripts/provision-cloudflare.mjs').args.includes(file));
  assert.ok(actions.findIndex(c=>c.args[0]==='scripts/provision-cloudflare.mjs')<actions.findIndex(c=>c.args[0]==='scripts/build-forward.mjs'));
  assert.deepEqual(actions.filter(c=>c.args.includes('restart')).map(c=>c.args),[['--user','restart','codex-cloud-panel.service']]);
  assert.ok(actions.some(c=>c.args[0]==='scripts/native.mjs'&&c.args[1]==='tunnel'));
  assert.equal(JSON.stringify([h.calls,h.logs]).includes(secret),false);assert.equal(h.healthy,true);
  assert.deepEqual(h.events,['--prepare-only','health','--commit-only']);
});

test('public deployment failures keep the public commit uninvoked and request bounded rollback without restarting tasks',async t=>{
  for(const failure of ['start','health'])await t.test(failure,async t=>{
    const h=await harness(t,{active:['codex-cloud-desktop.service','codex-cloud-panel.service'],failure:failure==='start'?'start':'',healthError:failure==='health'?'not ready':undefined});
    const token=join(h.root,'token');await writeFile(token,'synthetic-api-token');
    await assert.rejects(deploy({domain:'desktop.example.com',zone:'example.com','api-token-file':token},h.context));
    assert.ok(h.events.includes('--prepare-only'));assert.ok(h.events.includes('--rollback'));assert.ok(!h.events.includes('--commit-only'));
    assert.ok(h.calls.every(call=>!['stop','restart'].some(action=>call.args.includes(action)&&call.args.some(arg=>/^codex-cloud-(desktop|terminal|actions)\.service$/.test(arg)))));
    assert.ok(h.logs.every(line=>!line.includes('部署完成')));
  });
});

test('oversized token files and failed health do not produce a success message or repeat service operations',async t=>{
  const h=await harness(t);const file=join(h.root,'oversized');await writeFile(file,'x'.repeat(4097));
  await assert.rejects(deploy({'api-token-file':file},h.context),/大小限制/);assert.equal(h.calls.length,1);
  const failed=await harness(t,{healthError:'fixture is not ready'});await assert.rejects(deploy({},failed.context),/not ready/);
  assert.ok(failed.logs.every(line=>!line.includes('部署完成')));assert.equal(failed.calls.filter(c=>c.args[1]==='start').length,1);
});

test('real isolated setup uses the documented desktop size and preserves existing credentials and configuration on rerun',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-real-setup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const folder of ['scripts','native'])await mkdir(join(directory,folder));
  await mkdir(join(directory,'panel','public'),{recursive:true});
  for(const file of ['scripts/setup.mjs','native/config.mjs','native/preferences.mjs','native/deployment-mode.mjs','panel/public/terminal-slots.js'])await copyFile(resolve(file),join(directory,file));
  const exec=promisify(execFile);await exec(process.execPath,[join(directory,'scripts/setup.mjs')],{maxBuffer:8192});
  const files=['.env','secrets/panel_password','secrets/agent_secret','secrets/credentials.txt'];
  const before=await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')));
  assert.match(before[0],/DESKTOP_SIZE=1600x3200/);
  assert.match(before[0],/MAX_TERMINALS=4/);
  const result=await exec(process.execPath,[join(directory,'scripts/setup.mjs'),'--origin','https://other.example.com','--username','other'],{maxBuffer:8192});
  assert.deepEqual(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8'))),before);
  assert.equal(result.stdout.includes(before[1].trim()),false);
  assert.equal((await stat(join(directory,'secrets','panel_password'))).mode&0o777,0o600);
});

test('real readiness HTTP uses the configured Host and helper authorization without logging or sending terminal input',async t=>{
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);assert.ok(requests.length<=2);
    res.setHeader('content-type','application/json');
    if(req.url==='/readyz') {assert.equal(req.headers.host,'desktop.example.test');res.end('{"ok":true,"host":true,"files":true}');}
    else {assert.equal(req.url,'/health');assert.equal(req.headers.authorization,'Bearer synthetic_test_secret');res.end('{"ready":true,"uploadProtocol":1,"quotaProtocol":1}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  await checkHealth({port:server.address().port,agentPort:server.address().port,origin:'https://desktop.example.test',agentSecret:'synthetic_test_secret'});
  assert.deepEqual(requests.sort(),['/health','/readyz']);
});

test('readiness refuses an absent dedicated FILE_AGENT_PORT despite a healthy host and panel', async t => {
  const server = http.createServer((_req,res) => { res.setHeader('content-type','application/json'); res.end('{"ok":true,"host":true,"files":true,"ready":true,"uploadProtocol":1,"quotaProtocol":1}'); });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const missing = http.createServer(); missing.listen(0,'127.0.0.1'); await once(missing,'listening'); const missingPort = missing.address().port; await new Promise(resolve => missing.close(resolve));
  await assert.rejects(checkHealth({port:server.address().port,agentPort:server.address().port,fileAgentPort:missingPort,origin:'http://example.test',agentSecret:'synthetic_test_secret'}, {attempts:1}), /独立文件服务/);
});

test('default deployment readiness uses the persisted origin and helper port despite stale task environment variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-health-env-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const folder of ['native','panel','scripts','gateway'])await cp(resolve(folder),join(root,folder),{recursive:true,filter:path=>!path.includes('__pycache__')});
  await symlink(resolve('node_modules'),join(root,'node_modules'));await mkdir(join(root,'secrets'));
  for(const name of ['agent_secret','panel_password'])await writeFile(join(root,'secrets',name),'synthetic_health_secret',{mode:0o600});
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);res.setHeader('content-type','application/json');
    if(req.url==='/readyz') {res.statusCode=req.headers.host==='deployed.example.test'?200:400;res.end('{"ok":true,"host":true,"files":true}');}
    else {assert.equal(req.headers.authorization,'Bearer synthetic_health_secret');res.end('{"ready":true,"uploadProtocol":1,"quotaProtocol":1}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  await writeFile(join(root,'.env'),`PUBLIC_ORIGIN=https://deployed.example.test\nPANEL_PORT=${port}\nAGENT_PORT=${port}\nFILE_AGENT_PORT=${port}\nWEBRTC_ENABLED=0\n`);
  await promisify(execFile)(process.execPath,['--input-type=module','-e',"import {checkHealth} from './scripts/deploy.mjs'; await checkHealth(undefined,{attempts:1});"],{
    cwd:root,env:{...process.env,PUBLIC_ORIGIN:'https://stale.example.test',PANEL_PORT:'1',PORT:'1',AGENT_PORT:'1',FILE_AGENT_PORT:'1'},timeout:10000,maxBuffer:2048,
  });
  assert.deepEqual(requests.sort(),['/health','/readyz']);
});
