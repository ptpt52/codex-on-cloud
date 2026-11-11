import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { FORWARD_FILES } from '../panel/forward-downloads.mjs';

test('logout cancels slow helper downloads and releases both download slots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-forward-revocation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const name = FORWARD_FILES['windows-amd64'], bytes = Buffer.alloc(32 * 1024 * 1024, 1);
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, files: [{ arch: 'windows-amd64', name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), build: 'slow-download-test' }] }));
  const app = await fixture({ forwardDownloadDir: directory }); t.after(() => app.close()); await app.login();
  const path = '/api/forward/download/windows-amd64', responses = [], clients = [];
  app.panel.server.on('request', (req, res) => { if (req.url === path) responses.push(res); });
  t.after(() => { for (const client of clients) client.destroy(); });
  for (let index = 0; index < 2; index++) await new Promise((resolve, reject) => {
    const client = http.get(app.config.origin + path, { headers: { cookie: app.cookie } }, res => { res.on('error', () => {}); res.pause(); resolve(); });
    clients.push(client); client.on('error', reject);
  });
  assert.equal((await app.request(path)).status, 429);
  await app.request('/api/logout', { method: 'POST', body: {} });
  assert(responses.slice(0, 2).every(response => response.destroyed), 'revoked downloads must close even while their clients are paused');
  await Promise.all(responses.slice(0, 2).map(response => response.closed ? undefined : once(response, 'close')));
  await app.login();
  const next = await app.request(path); assert.equal(next.status, 200); await next.body.cancel();
});

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
