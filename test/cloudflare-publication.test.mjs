import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudflarePublication } from '../scripts/cloudflare-publication.mjs';
import { privateIngressReady } from '../scripts/cloudflare-publication.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';
import { writeFileSync, readlinkSync } from 'node:fs';
import { deploy } from '../scripts/deploy.mjs';
import { acquireDeploymentLease } from '../scripts/deployment-lease.mjs';

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
  const make=(extra={})=>createCloudflarePublication({root,socketPath:'/tmp/synthetic-private.sock',api,ready:async()=>{calls.push({path:'readiness',method:'GET'});if(!ready)throw Error('not ready');},...extra});
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

test('commit refuses operator changes to prepared local configuration before touching public routing',async t=>{
  for(const file of ['.env','secrets/credentials.txt','secrets/tunnel_token'])await t.test(file,async t=>{
    const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration);await p.prepare(h.options);
    const path=join(h.root,file),prepared=await readFile(path,'utf8'),edited=prepared+'# operator edit\n';
    await writeFile(path,edited,{mode:0o600});
    await assert.rejects(p.commit(h.options),/本机配置已变化/);
    assert.deepEqual(h.configuration,before);assert.ok(h.calls.every(c=>c.method==='GET'));
    assert.equal(await readFile(path,'utf8'),edited);
    assert.equal(JSON.parse(await readFile(join(h.root,'data/cloudflare-publication.json'),'utf8')).phase,'prepared');
    await writeFile(path,prepared,{mode:0o600});await p.commit(h.options);
    assert.equal(h.configuration.ingress[0].service,'unix:/tmp/synthetic-private.sock');
  });
});

test('commit rechecks local preparation after remote preflight requests',async t=>{
  const h=await fixture(t),p=h.make(),before=structuredClone(h.configuration);await p.prepare(h.options);
  const path=join(h.root,'.env'),edited='PUBLIC_ORIGIN=https://operator.example.test\n';
  h.fail=({path:request,method})=>{if(method==='GET'&&request.includes('/dns_records'))writeFileSync(path,edited,{mode:0o600});};
  await assert.rejects(p.commit(h.options),/本机配置已变化/);
  assert.deepEqual(h.configuration,before);assert.ok(h.calls.every(c=>c.method==='GET'));
  assert.equal(await readFile(path,'utf8'),edited);
  assert.equal(JSON.parse(await readFile(join(h.root,'data/cloudflare-publication.json'),'utf8')).phase,'prepared');
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

// Return the old snapshot, then edit the real target before the async writer
// acquires its lease. The previous read/compare/await-write sequence lost it.
async function editAfterRead(t,path,occurrence,edited){
 const handle=await open(path),prototype=Object.getPrototypeOf(handle),read=prototype.read;await handle.close();let seen=0,injected=false;
 t.mock.method(prototype,'read',async function(...args){
  const target=readlinkSync('/proc/self/fd/'+this.fd),result=await read.apply(this,args);
  if(target===path&&++seen===occurrence){writeFileSync(path,edited,{mode:0o600});injected=true;}
  return result;
 });
 return ()=>injected;
}
test('preparation preserves an operator edit between snapshot comparison and file lease acquisition',async t=>{
 const h=await fixture(t),p=h.make(),path=join(h.root,'.env'),edited='PUBLIC_ORIGIN=https://operator.example.test\n';
 const injected=await editAfterRead(t,path,2,edited);
 await assert.rejects(p.prepare(h.options),/回退未能确认/);assert.equal(injected(),true);
 assert.equal(await readFile(path,'utf8'),edited);assert.ok(h.calls.every(c=>c.method==='GET'));
 assert.equal(JSON.parse(await readFile(join(h.root,'data/cloudflare-publication.json'),'utf8')).phase,'rollback-needed');
});
test('rollback rechecks both replacement and deletion after a stale local snapshot',async t=>{
 for(const file of ['.env','secrets/tunnel_token'])await t.test(file,async t=>{
  const h=await fixture(t),p=h.make();await p.prepare(h.options);const path=join(h.root,file),edited='operator-edit-to-preserve\n';
  const injected=await editAfterRead(t,path,1,edited);
  await assert.rejects(p.rollback(),/回退未能确认/);assert.equal(injected(),true);
  assert.equal(await readFile(path,'utf8'),edited);assert.ok(h.calls.every(c=>c.method==='GET'));
  assert.equal(JSON.parse(await readFile(join(h.root,'data/cloudflare-publication.json'),'utf8')).phase,'rollback-needed');
 });
});

test('a complete deployment lease excludes other deployments and standalone publishers before side effects',async t=>{
 const h=await fixture(t),lease=await acquireDeploymentLease(h.root);t.after(()=>lease.release());
 await assert.rejects(h.make().prepare(h.options),{status:409});
 let commands=0;await assert.rejects(deploy({}, {root:h.root,run:async()=>{commands++;return{status:0};}}),{status:409});
 assert.equal(commands,0);assert.equal(h.calls.length,0);assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);
});

test('failed deployment preparation never rolls back another operation, even with the same target',async t=>{
 for(const domain of ['home.example.test','other.example.test'])await t.test(domain,async t=>{
  const h=await fixture(t);await h.make().prepare(h.options);
  const path=join(h.root,'data/cloudflare-publication.json'),record=await readFile(path,'utf8'),env=await readFile(join(h.root,'.env'),'utf8');
  const token=join(h.root,'synthetic-api-token');await writeFile(token,'synthetic-api-token',{mode:0o600});let started=false;
  await assert.rejects(deploy({domain,zone:'example.test','api-token-file':token,'skip-wsl-network':true},{root:h.root,log:()=>{},
   publicationFactory:async(_values,context)=>h.make(context),health:async()=>{throw Error('unexpected health');},
   run:async(_command,args)=>{if(args.includes('is-system-running'))return{status:0,stdout:'running\n'};if(args.includes('is-active'))return{status:args.at(-1)==='codex-cloud-terminal.service'?3:0};if(args.includes('start'))started=true;return{status:0,stdout:''};},
  }),/属于其他操作/);
  assert.equal(started,false);assert.equal(await readFile(path,'utf8'),record);assert.equal(await readFile(join(h.root,'.env'),'utf8'),env);
  assert.ok(h.calls.every(call=>call.method==='GET'));
 });
});

test('a lost prepare acknowledgement still rolls back only the operation that actually prepared',async t=>{
 const h=await fixture(t),token=join(h.root,'synthetic-api-token');await writeFile(token,'synthetic-api-token',{mode:0o600});
 await assert.rejects(deploy({...h.options,'api-token-file':token,'skip-wsl-network':true},{root:h.root,log:()=>{},
  publicationFactory:async(_values,context)=>{const p=h.make(context);return{...p,async prepare(target){await p.prepare(target);throw Error('synthetic lost prepare acknowledgement');}};},
  health:async()=>{throw Error('unexpected health');},run:async(_command,args)=>args.includes('is-system-running')?{status:0,stdout:'running\n'}:args.includes('is-active')?{status:args.at(-1)==='codex-cloud-terminal.service'?3:0}:{status:0,stdout:''},
 }),/lost prepare acknowledgement/);
 assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);await assert.rejects(stat(join(h.root,'data/cloudflare-publication.json')),{code:'ENOENT'});
 assert.ok(h.calls.every(call=>call.method==='GET'));
});

test('explicit standalone rollback validates the requested domain and zone before any modification',async t=>{
 const h=await fixture(t),p=h.make();await p.prepare(h.options);const path=join(h.root,'data/cloudflare-publication.json'),record=await readFile(path,'utf8');
 for(const target of [{...h.options,domain:'other.example.test'},{...h.options,zone:'other.test'}])await assert.rejects(p.rollback(target),{status:409});
 assert.equal(await readFile(path,'utf8'),record);await p.rollback(h.options);assert.equal(await readFile(join(h.root,'.env'),'utf8'),h.env);
});

test('legacy prepared records without an operation identity remain manually resumable',async t=>{
 const h=await fixture(t);await h.make().prepare(h.options);const path=join(h.root,'data/cloudflare-publication.json'),record=JSON.parse(await readFile(path,'utf8'));delete record.operationId;await writeFile(path,JSON.stringify(record),{mode:0o600});
 const p=h.make();assert.equal((await p.prepare(h.options)).resumed,true);await p.commit(h.options);
 assert.equal(h.configuration.ingress[0].service,'unix:/tmp/synthetic-private.sock');await assert.rejects(stat(path),{code:'ENOENT'});
});
