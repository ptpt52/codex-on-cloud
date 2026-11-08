import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudflarePublication } from '../scripts/cloudflare-publication.mjs';
import { privateIngressReady } from '../scripts/cloudflare-publication.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';

async function fixture(t, { fresh = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cloudflare-publication-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const folder of ['data','secrets'])await mkdir(join(root,folder),{mode:0o700});
  const origin='https://old.example.test', env=`PUBLIC_ORIGIN=${origin}\nALLOWED_HOSTS=localhost:36080\n`,credentials=`工作台：${origin}\n用户名：test-admin\n密码：synthetic-test-password\n`;
  await writeFile(join(root,'.env'),env,{mode:0o600});await writeFile(join(root,'secrets/credentials.txt'),credentials,{mode:0o600});
  const state={hostname:'home.example.test',accountId:'account',zoneId:'zone',tunnelId:'tunnel',dnsRecordId:'record'};
  if(!fresh)await writeFile(join(root,'data/cloudflare-deployment.json'),JSON.stringify(state),{mode:0o600});
  let configuration={ingress:[...(!fresh?[{hostname:'home.example.test',service:'http://127.0.0.1:36080',originRequest:{connectTimeout:12}}]:[]),{service:'http_status:404'}], 'warp-routing':{enabled:false}};
  let dns=fresh?null:{id:'record',type:'CNAME',name:'home.example.test',content:'tunnel.cfargotunnel.com',proxied:false,ttl:300,comment:'preserve me'};
  let ready=true,fail=null,created=0;const calls=[];
  const api=async(path,method='GET',body)=>{
    calls.push({path,method,body:structuredClone(body)});
    const failure=fail?.({path,method,body});if(failure?.before)throw Error('simulated API failure before commit');
    let result;
    if(path==='/zones?name=example.test')result=[{name:'example.test',id:'zone',account:{id:'account'}}];
    else if(path.endsWith('/cfd_tunnel?is_deleted=false&name=codex-on-cloud-home'))result=[];
    else if(path==='/accounts/account/cfd_tunnel'&&method==='POST'){created++;result={id:'tunnel'};}
    else if(path.endsWith('/token'))result='synthetic_runtime_token';
    else if(path.endsWith('/configurations')){if(method==='PUT')configuration=structuredClone(body.config);result={config:structuredClone(configuration)};}
    else if(path.startsWith('/zones/zone/dns_records')){
      if(method==='GET')result=dns?[structuredClone(dns)]:[];
      if(method==='PUT'||method==='POST'){dns={id:'record',...structuredClone(body)};result=structuredClone(dns);}
      if(method==='DELETE'){dns=null;result={id:'record'};}
    }else throw Error('unexpected mock API path '+path);
    if(failure?.after)throw Error('simulated lost acknowledgement after commit');
    return result;
  };
  const options={domain:'home.example.test',zone:'example.test'};
  const make=()=>createCloudflarePublication({root,socketPath:'/tmp/synthetic-private.sock',api,ready:async()=>{calls.push({path:'readiness',method:'GET'});if(!ready)throw Error('not ready');}});
  return {root,env,credentials,options,calls,make,get configuration(){return configuration;},set configuration(v){configuration=v;},get dns(){return dns;},get created(){return created;},set ready(v){ready=v;},set fail(v){fail=v;}};
}

test('preparation preserves public routing and DNS; commit waits for readiness and keeps unrelated configuration',async t=>{
  const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration);await p.prepare(h.options);
  assert.deepEqual(h.configuration,before);assert.equal(h.dns.proxied,false);assert.ok(h.calls.every(c=>c.method==='GET'));
  assert.match(await readFile(join(h.root,'.env'),'utf8'),/ALLOWED_HOSTS=localhost:36080/);
  assert.equal((await stat(join(h.root,'data/cloudflare-publication.json'))).mode&0o777,0o600);
  h.ready=false;await assert.rejects(p.commit(h.options),/not ready/);assert.deepEqual(h.configuration,before);
  h.ready=true;await p.commit(h.options);
  const mutation=h.calls.findIndex(c=>c.method==='PUT');assert.ok(h.calls.slice(0,mutation).some(c=>c.path==='readiness'));
  assert.equal(h.configuration.ingress[0].service,'unix:/tmp/synthetic-private.sock');assert.deepEqual(h.configuration['warp-routing'],{enabled:false});assert.deepEqual(h.configuration.ingress[0].originRequest,{connectTimeout:12});
  assert.equal(h.dns.proxied,true);assert.equal(h.dns.comment,'preserve me');await assert.rejects(stat(join(h.root,'data/cloudflare-publication.json')),{code:'ENOENT'});
});

test('a failed start rolls back preparation locally without mutating the public entry',async t=>{
  const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration);await p.prepare(h.options);await p.rollback();
  assert.deepEqual(h.configuration,before);assert.ok(h.calls.every(c=>c.method==='GET'));
  assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);assert.equal(await readFile(join(h.root,'secrets/credentials.txt'),'utf8'),h.credentials);
  await assert.rejects(stat(join(h.root,'secrets/tunnel_token')),{code:'ENOENT'});
});

test('lost routing or DNS acknowledgements reconcile and restore exactly the previous entry',async t=>{
  for(const target of ['route','dns'])await t.test(target,async t=>{
    const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration),beforeDNS=structuredClone(h.dns);await p.prepare(h.options);let injected=false;
    h.fail=({path,method})=>{if(!injected&&method==='PUT'&&(target==='route'?path.endsWith('/configurations'):path.includes('/dns_records/'))){injected=true;return{after:true};}};
    await assert.rejects(p.commit(h.options),/lost acknowledgement/);assert.equal(injected,true);
    assert.deepEqual(h.configuration,before);assert.deepEqual(h.dns,beforeDNS);assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);
  });
});

test('rollback outages retain a resumable record and never claim the previous entry was restored',async t=>{
  const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration);await p.prepare(h.options);
  let first=true;h.fail=({path,method})=>{if(path.endsWith('/configurations')&&method==='PUT'){if(first){first=false;return{after:true};}return{before:true};}};
  await assert.rejects(p.commit(h.options),/回退未能确认/);assert.equal(JSON.parse(await readFile(join(h.root,'data/cloudflare-publication.json'),'utf8')).phase,'rollback-needed');
  h.fail=null;await h.make().rollback();assert.deepEqual(h.configuration,before);assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);
});

test('fresh tunnels are retained for retry, while concurrent changes are never overwritten',async t=>{
  const h=await fixture(t,{fresh:true}),p=h.make();await p.prepare(h.options);assert.equal(h.created,1);await p.rollback();await p.prepare(h.options);assert.equal(h.created,1);
  h.configuration={ingress:[{hostname:'home.example.test',service:'http://other-owner:8080'},{service:'http_status:404'}]};const changed=structuredClone(h.configuration);
  await assert.rejects(p.commit(h.options),/配置已变化/);assert.deepEqual(h.configuration,changed);await p.rollback();assert.deepEqual(h.configuration,changed);
});

test('real private readiness requires the expected Host, healthy files and healthy task host',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cf-private-ready-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'tunnel.sock');let files=false;
  const server=http.createServer((req,res)=>{assert.equal(req.url,'/readyz');assert.equal(req.headers.host,'home.example.test');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:files,host:true,files}));});
  server.listen(path);await once(server,'listening');await chmod(path,0o600);t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(privateIngressReady(path,'home.example.test'),/未就绪/);files=true;await privateIngressReady(path,'home.example.test');
});

test('a recovery record resumes incomplete local preparation and protects subsequent operator edits',async t=>{
  const h=await fixture(t),p=h.make();await p.prepare(h.options);
  await writeFile(join(h.root,'.env'),h.env);await h.make().prepare(h.options);assert.match(await readFile(join(h.root,'.env'),'utf8'),/home.example.test/);
  await writeFile(join(h.root,'.env'),'PUBLIC_ORIGIN=https://operator.example.test\n');await assert.rejects(p.rollback(),/回退未能确认/);
  assert.match(await readFile(join(h.root,'.env'),'utf8'),/operator.example.test/);
});
