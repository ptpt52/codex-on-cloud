import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixture.mjs';
import { FORWARD_FILES } from '../panel/forward-downloads.mjs';

test('helper downloads require authentication and use only fixed bounded regular files',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-forward-download-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const name='codex-cloud-forward-windows-amd64.exe',bytes=Buffer.from('MZ-test-only-not-a-real-binary'),sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory,name),bytes);await writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,files:[{arch:'windows-amd64',name,size:bytes.length,sha256,build:'test'}]}));
  const app=await fixture({forwardDownloadDir:directory});t.after(()=>app.close());
  const path='/api/forward/download/windows-amd64';assert.equal((await app.request(path)).status,401);await app.login();await app.claim();
  const listing=await(await app.request('/api/forward')).json();assert.equal(listing.downloads[0].sha256,sha256);
  const download=await app.request(path);assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await app.request('/api/forward/download/unknown')).status,404);
  await rm(join(directory,name));await symlink(join(directory,'manifest.json'),join(directory,name));assert.equal((await app.request(path)).status,502);
});

test('all four helper artifacts are authenticated, retain exact bytes and types, and reject malformed or duplicate manifests',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codex-forward-platforms-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const files=[];
  for(const [arch,name] of Object.entries(FORWARD_FILES)){
    const bytes=Buffer.from('fixture only '+arch);await writeFile(join(directory,name),bytes);
    files.push({arch,name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),build:'platform-test'});
  }
  const manifest=()=>writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,files}));await manifest();
  const app=await fixture({forwardDownloadDir:directory});t.after(()=>app.close());
  for(const file of files)assert.equal((await app.request('/api/forward/download/'+file.arch)).status,401);
  await app.login();const listed=(await(await app.request('/api/forward')).json()).downloads;assert.equal(listed.length,4);
  for(const file of files){
    const response=await app.request('/api/forward/download/'+file.arch);assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),file.arch.startsWith('darwin')?'application/zip':'application/octet-stream');
    assert.match(response.headers.get('content-disposition'),new RegExp(file.name.replaceAll('.','\\.')));
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),file.sha256);
  }
  files.push(files[0]);await manifest();assert.equal((await(await app.request('/api/forward')).json()).downloads.length,0);
  files.pop();files[3]=files[0];await manifest();assert.equal((await(await app.request('/api/forward')).json()).downloads.length,0);
  await writeFile(join(directory,'manifest.json'),' '.repeat(4097));assert.equal((await(await app.request('/api/forward')).json()).downloads.length,0);
});
