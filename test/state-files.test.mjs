import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, lstat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStateFile, removeStateFile } from '../scripts/state-files.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
test('state configuration recovers dead writers and legacy partial files without deleting unrelated data', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'state-writer-')); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, 'config.json');
 await writeStateFile(path, 'original'); await writeFile(path + '.portal-next', 'legacy partial');
 await writeFile(path + '.portal-next-v2', 'terminated write');
 await writeFile(path + '.portal-lock', JSON.stringify({ pid: process.pid, started: '0' }));
 await writeStateFile(path, 'updated'); assert.equal(await readFile(path, 'utf8'), 'updated'); assert.equal(await readFile(path + '.portal-next', 'utf8'), 'legacy partial');
 assert.equal((await lstat(path + '.portal-lock')).size, 0); await assert.rejects(lstat(path + '.portal-next-v2'), { code: 'ENOENT' });
});

test('an empty lock held by a live OS lease rejects concurrent writers and recovers immediately after process death', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-kernel-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config.json'),lock=path+'.portal-lock';
 await writeFile(path,'original');await writeFile(lock,'');
 const helper=fileURLToPath(new URL('../native/file_lock.py',import.meta.url));
 const child=spawn('python3',['-I',helper,lock],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');assert.equal((await lstat(lock)).size,0);
 await assert.rejects(writeStateFile(path,'racing write'),{status:409});assert.equal(await readFile(path,'utf8'),'original');
 const closed=once(child,'close');child.kill('SIGKILL');await closed;
 await writeStateFile(path,'recovered');assert.equal(await readFile(path,'utf8'),'recovered');assert.equal((await lstat(lock)).mode&0o777,0o600);
});

test('a crashed parent releases its lock helper through EOF, without requiring PID-file deletion', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-parent-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config.json');await writeFile(path,'original');
 const module=new URL('../native/file-lock.mjs',import.meta.url).href;
 const source=`import {acquireFileLock} from ${JSON.stringify(module)};await acquireFileLock(process.argv[1]);console.log('ready');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,path+'.portal-lock'],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));await once(child.stdout,'data');
 const helper=Number((await readFile('/proc/'+child.pid+'/task/'+child.pid+'/children','utf8')).trim());assert.ok(Number.isInteger(helper)&&helper>1);
 const closed=once(child,'close');child.kill('SIGKILL');await closed;
 for(let n=0;n<100;n++){
  const state=await readFile('/proc/'+helper+'/stat','utf8').catch(()=>null);
  if(!state||state.slice(state.lastIndexOf(')')+2).split(' ')[0]==='Z')break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 await writeStateFile(path,'after parent crash');assert.equal(await readFile(path,'utf8'),'after parent crash');
});

test('partial legacy locks recover, while symbolic and hard links never redirect lock initialization', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-invalid-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config.json'),lock=path+'.portal-lock',unrelated=join(dir,'unrelated');
 await writeFile(path,'original');await writeFile(lock,'{"pid":');await writeStateFile(path,'recovered');assert.equal(await readFile(path,'utf8'),'recovered');
 await rm(lock);await writeFile(unrelated,'must stay intact');await symlink(unrelated,lock);await assert.rejects(writeStateFile(path,'wrong'));assert.equal(await readFile(unrelated,'utf8'),'must stay intact');
 await rm(lock);await link(unrelated,lock);await assert.rejects(writeStateFile(path,'wrong'));assert.equal(await readFile(unrelated,'utf8'),'must stay intact');
});

test('exclusive initialization publishes a complete file only after its final permission check', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-exclusive-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config.json');let checks=0;
 await assert.rejects(writeStateFile(path,'not authorized',{exclusive:true,valid(){if(++checks===3){assert.equal(existsSync(path),false);throw Error('revoked');}}}),/revoked/);
 await assert.rejects(lstat(path),{code:'ENOENT'});await writeStateFile(path,'complete',{exclusive:true});
 await assert.rejects(writeStateFile(path,'must not replace',{exclusive:true}),{code:'EEXIST'});assert.equal(await readFile(path,'utf8'),'complete');
});
test('state writers reject active locks and special temporaries and recheck permission before commit', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'state-writer-')); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, 'config.json');
 await writeStateFile(path, 'original');
 const stat = await readFile('/proc/' + process.pid + '/stat', 'utf8'), started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
 await writeFile(path + '.portal-lock', JSON.stringify({ pid: process.pid, started })); await assert.rejects(writeStateFile(path, 'blocked'), /已有配置写入/); await rm(path + '.portal-lock');
 await symlink(path, path + '.portal-next-v2'); await assert.rejects(writeStateFile(path, 'blocked'), /普通文件/); await rm(path + '.portal-next-v2');
 let checks = 0; await assert.rejects(writeStateFile(path, 'revoked', { valid() { if (++checks === 3) throw Error('permission revoked'); } }), /permission revoked/);
 assert.equal(await readFile(path, 'utf8'), 'original'); await assert.rejects(lstat(path + '.portal-next-v2'), { code: 'ENOENT' }); assert.equal((await lstat(path + '.portal-lock')).size, 0);
});

test('conditional configuration writes compare after lease acquisition and immediately before commit', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-cas-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config');
 for(const phase of [2,3]){
  await writeFile(path,'before',{mode:0o600});let checks=0;
  await assert.rejects(writeStateFile(path,'after',{expected:'before',valid(){if(++checks===phase)writeFileSync(path,'operator edit');}}),{status:409});
  assert.equal(checks,phase);assert.equal(await readFile(path,'utf8'),'operator edit');
  await assert.rejects(lstat(path+'.portal-next-v2'),{code:'ENOENT'});
 }
 await writeStateFile(path,'after',{expected:'operator edit'});assert.equal(await readFile(path,'utf8'),'after');
 await assert.rejects(writeStateFile(path,'stale',{expected:'before'}),{status:409});
 await rm(path);await assert.rejects(writeStateFile(path,'stale',{expected:'before'}),{status:409});
 await writeStateFile(path,'created',{expected:null});await assert.rejects(writeStateFile(path,'replaced',{expected:null}),{status:409});
 assert.equal(await readFile(path,'utf8'),'created');
});

test('conditional rollback deletion preserves intervening edits and requires an explicit expectation', async t => {
 const dir=await mkdtemp(join(tmpdir(),'state-remove-cas-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'config');
 await assert.rejects(removeStateFile(path),/预期内容/);assert.equal(await removeStateFile(path,{expected:null}),false);
 for(const phase of [2,3]){
  await writeFile(path,'prepared',{mode:0o600});let checks=0;
  await assert.rejects(removeStateFile(path,{expected:'prepared',valid(){if(++checks===phase)writeFileSync(path,'operator edit');}}),{status:409});
  assert.equal(await readFile(path,'utf8'),'operator edit');
 }
 await assert.rejects(removeStateFile(path,{expected:null}),{status:409});
 await removeStateFile(path,{expected:'operator edit'});await assert.rejects(lstat(path),{code:'ENOENT'});
 const other=join(dir,'other');await writeFile(other,'prepared');await symlink(other,path);
 await assert.rejects(removeStateFile(path,{expected:'prepared'}));assert.equal(await readFile(other,'utf8'),'prepared');
});
