import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createAccessControl, ACCESS_FILE_LIMIT } from '../panel/access-control.mjs';
import { createAuth, SESSION_FILE_LIMIT, tokenHash } from '../panel/auth.mjs';
import { randomBytes } from 'node:crypto';

async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'codex-access-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={dataDir:directory,username:'admin',password:'test-admin-password',sessionMs:604800000};
  return {directory,config,access:await createAccessControl(config)};
}
test('screen and temporary credentials persist only salted hashes, expire independently, and never appear in status',async t=>{
  const {directory,config,access}=await setup(t);assert.equal(access.screenEnabled,false);
  await assert.rejects(access.saveScreen({enabled:true}),/先设置/);
  await access.saveScreen({enabled:true,password:'test-screen-password'});assert.equal(await access.verifyScreen('test-screen-password'),true);assert.equal(await access.verifyScreen('wrong'),false);
  await access.saveTemporary({enabled:true,username:'visitor',password:'test-guest-password',durationMs:300000});
  const identity=await access.verifyTemporary('visitor','test-guest-password');assert.equal(identity.role,'temporary');assert.ok(access.temporaryValid(identity));
  const restored=await createAccessControl(config);assert.equal(await restored.verifyScreen('test-screen-password'),true);assert.ok(await restored.verifyTemporary('visitor','test-guest-password'));
  const bytes=await readFile(join(directory,'access.json'),'utf8');assert.ok(bytes.length<=ACCESS_FILE_LIMIT);assert.ok(!bytes.includes('test-screen-password')&&!bytes.includes('test-guest-password'));
  assert.ok(!JSON.stringify(access.status()).includes('hash'));assert.equal((await lstat(join(directory,'access.json'))).mode&0o777,0o600);
  await access.saveTemporary({enabled:false});assert.equal(access.temporaryValid(identity),false);
  assert.equal(await access.verifyTemporary('visitor','test-guest-password'),null);
});
test('stale owners cannot commit after password hashing, and configuration writes do not queue',async t=>{
  const {directory,access}=await setup(t);let valid=true;
  const pending=access.saveScreen({enabled:true,password:'test-screen-password'},()=>{if(!valid)throw Error('revoked owner');});
  valid=false;await assert.rejects(access.saveTemporary({enabled:false}),/正在保存/);await assert.rejects(pending,/revoked owner/);
  assert.equal(access.screenEnabled,false);await assert.rejects(lstat(join(directory,'access.json')),{code:'ENOENT'});
});
test('guest logins have a separate bounded budget and revoking a guest never evicts administrator sessions',async t=>{
  const {directory,config,access}=await setup(t);
  await access.saveTemporary({enabled:true,username:'visitor',password:'test-guest-password'});
  const auth=await createAuth(config,{validSession:s=>s.role!=='temporary'||access.temporaryValid(s)});
  const admins=await Promise.all(Array.from({length:8},()=>auth.create()));
  const identity=await access.verifyTemporary('visitor','test-guest-password');const guests=await Promise.all(Array.from({length:10},()=>auth.create(identity)));
  assert.equal(admins.filter(s=>auth.get(s.token)).length,8);assert.equal(guests.filter(s=>auth.get(s.token)).length,4);
  await auth.close();assert.ok((await readFile(join(directory,'sessions.json'))).length<=SESSION_FILE_LIMIT);
  await access.saveTemporary({enabled:true,username:'visitor',password:'a-new-guest-password'});
  assert.equal(guests.filter(s=>auth.get(s.token)).length,0);assert.equal(admins.filter(s=>auth.get(s.token)).length,8);
});
test('access startup rejects oversized files, symlinks and FIFOs instead of silently disabling the screen lock',async t=>{
  const {directory,config}=await setup(t),file=join(directory,'access.json'),outside=join(directory,'outside');
  await writeFile(file,'x'.repeat(ACCESS_FILE_LIMIT+1),{mode:0o600});await assert.rejects(createAccessControl(config),/无法读取/);await rm(file);
  await writeFile(outside,'keep',{mode:0o600});await symlink(outside,file);await assert.rejects(createAccessControl(config),/无法读取/);assert.equal(await readFile(outside,'utf8'),'keep');await rm(file);
  execFileSync('mkfifo',[file]);await assert.rejects(createAccessControl(config),/无法读取/);
});

test('legacy administrator cookies migrate but role-bearing cookies cannot be promoted by an older panel on rollback',async t=>{
  const {directory,config}=await setup(t),token=randomBytes(32).toString('hex'),guestToken=randomBytes(32).toString('hex');
  const file=join(directory,'sessions.json'),legacy=tokenHash(config.password),base={csrf:randomBytes(24).toString('hex'),expires:Date.now()+60000};
  await writeFile(file,JSON.stringify({revision:legacy,sessions:[{...base,hash:tokenHash(token)},{...base,hash:tokenHash(guestToken),role:'temporary'}]}),{mode:0o600});
  const auth=await createAuth(config);assert.equal(auth.get(token).role,'admin');assert.equal(auth.get(guestToken),null);await auth.close();
  const stored=JSON.parse(await readFile(file,'utf8'));assert.notEqual(stored.revision,legacy,'Old panels must reject the entire new role-bearing session file');
  const restored=await createAuth(config);assert.equal(restored.get(token).role,'admin');await restored.close();
});
