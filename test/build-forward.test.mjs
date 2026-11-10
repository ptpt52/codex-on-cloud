import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, open } from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildForward } from '../scripts/build-forward.mjs';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { createForwardDownloads, FORWARD_FILES } from '../panel/forward-downloads.mjs';
import { writeStateFile } from '../scripts/state-files.mjs';
import { removeRelease } from '../native/forward-artifacts.mjs';
import { fixture as panelFixture } from './fixture.mjs';

test('forward builds use persisted configuration instead of the task environment and keep explicit origins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forward-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'PUBLIC_ORIGIN=https://current.example.test\n', { mode: 0o600 });
  const before = process.env.PUBLIC_ORIGIN; t.after(() => { if (before === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = before; });
  process.env.PUBLIC_ORIGIN = 'https://stale.example.test';
  for (const origin of [undefined, 'https://explicit.example.test']) {
    let compiled = false;
    await assert.rejects(buildForward({ root, origin }, { run: async (file, args) => {
      if (file === 'git') return { stdout: '123456abcdef\n' };
      if (args[0] === 'version') return { stdout: 'go version go1.26.4 linux/amd64\n' };
      compiled = true; assert.ok(args.includes('-s -w -X main.defaultServer=' + (origin || 'https://current.example.test') + ' -X main.version=0.7.3+123456abcdef'));
      throw Error('synthetic compiler stop');
    } }), /synthetic compiler stop/);
    assert.equal(compiled, true);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-forward-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data/forward-client'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const legacy = Buffer.from('synthetic legacy helper'), name = FORWARD_FILES['windows-amd64'];
  const manifest = JSON.stringify({ version: 1, files: [{ arch: 'windows-amd64', name, size: legacy.length, sha256: createHash('sha256').update(legacy).digest('hex'), build: 'legacy' }] });
  await writeFile(join(directory, name), legacy); await writeFile(join(directory, 'manifest.json'), manifest);
  let seed = 1;
  const state = { fail: '', before: async () => {} };
  const run = async (file, args, options) => {
    if (file === 'git') return { stdout: '123456abcdef\n' };
    if (file === 'go' && args[0] === 'version') return { stdout: 'go version go1.26.4 linux/amd64\n' };
    if (file === 'go') {
      const arch = options.env.GOOS + '-' + options.env.GOARCH; await state.before(arch);
      if (state.fail === arch) throw Error('synthetic platform build failure');
      const bytes = Buffer.alloc(256, seed++); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(options.env.GOARCH === 'amd64' ? 0x8664 : 0xaa64, 68);
      await writeFile(args[args.indexOf('-o') + 1], bytes); return { stdout: '' };
    }
    assert.equal(file, 'python3'); await writeFile(args.at(-1), Buffer.alloc(300, seed++)); return { stdout: '' }; // Mock packaging, not a real ZIP.
  };
  return { root, directory, legacy, manifest, state, run, downloads: createForwardDownloads(directory) };
}
async function download(downloads, generation) {
  const chunks = [], sink = new Writable({ write(bytes, _encoding, done) { chunks.push(Buffer.from(bytes)); done(); } });
  sink.writeHead = () => {};
  await downloads.serve('windows-amd64', sink, generation); return Buffer.concat(chunks);
}
test('a later compiler failure leaves the complete previous download and its manifest untouched', async t => {
  const h = await fixture(t); h.state.fail = 'windows-arm64';
  await assert.rejects(buildForward({ root: h.root }, { run: h.run }), /platform build failure/);
  assert.deepEqual(await download(h.downloads), h.legacy); assert.equal(await readFile(join(h.directory, 'manifest.json'), 'utf8'), h.manifest);
  assert.deepEqual(await readdir(join(h.directory, 'releases')), []);
});
test('all four artifacts publish together, versioned downloads remain stable and retention is bounded', async t => {
  const h = await fixture(t), first = await buildForward({ root: h.root }, { run: h.run });
  const old = await download(h.downloads, first.generation), listed = await h.downloads.list();
  assert.equal(listed.length, 4); assert.ok(listed.every(item => item.href.endsWith('?generation=' + first.generation)));
  h.state.before = async () => { assert.deepEqual(await h.downloads.list(), listed); assert.deepEqual(await download(h.downloads), old); };
  const second = await buildForward({ root: h.root }, { run: h.run }); h.state.before = async () => {};
  assert.notDeepEqual(await download(h.downloads), old); assert.deepEqual(await download(h.downloads, first.generation), old);
  await buildForward({ root: h.root }, { run: h.run });
  assert.equal((await readdir(join(h.directory, 'releases'))).length, 2);
  await assert.rejects(download(h.downloads, first.generation), { status: 410 });
  assert.ok((await download(h.downloads, second.generation)).length > 0);
  assert.deepEqual(await readFile(join(h.directory, FORWARD_FILES['windows-amd64'])), h.legacy);
});
test('an ambiguous pointer acknowledgement never deletes a generation already committed', async t => {
  const h = await fixture(t);
  await assert.rejects(buildForward({ root: h.root }, { run: h.run, publish: async (path, text, options) => {
    await writeStateFile(path, text, options); if (path.endsWith('/current.json')) throw Error('synthetic lost commit acknowledgement');
  } }), /lost commit acknowledgement/);
  assert.equal((await h.downloads.list()).length, 4); assert.ok((await download(h.downloads)).length > 0);
});

test('publication rechecks the exact pointer inside its write lease', async t => {
  const h=await fixture(t),first=await buildForward({root:h.root},{run:h.run});
  const pointer=join(h.directory,'current.json'),edited=JSON.stringify({version:1,generation:first.generation},null,2)+'\n';
  await assert.rejects(buildForward({root:h.root},{run:h.run,publish:async(path,text,options)=>{
    if(path===pointer)await writeFile(pointer,edited);
    await writeStateFile(path,text,options);
  }}),{status:409});
  assert.equal(await readFile(pointer,'utf8'),edited);assert.equal((await h.downloads.list()).length,4);
  assert.equal((await readdir(join(h.directory,'releases'))).length,1);
});

test('expiry after reading a pinned manifest reports refresh instead of an internal download failure', async t => {
  const h=await fixture(t),first=await buildForward({root:h.root},{run:h.run});await buildForward({root:h.root},{run:h.run});
  const manifest=join(h.directory,'releases',first.generation,'manifest.json'),probe=await open(manifest),prototype=Object.getPrototypeOf(probe),stat=prototype.stat;await probe.close();
  let expired=false;t.mock.method(prototype,'stat',async function(...args){
    const path=readlinkSync('/proc/self/fd/'+this.fd),info=await stat.apply(this,args);
    if(path===manifest&&!expired){expired=true;await removeRelease(h.directory,first.generation);}return info;
  });
  await assert.rejects(download(h.downloads,first.generation),{status:410});assert.equal(expired,true);
  assert.ok((await download(h.downloads)).length>0);
});

test('published downloads pin their generation through authenticated HTTP and reject arbitrary paths', async t => {
  const h = await fixture(t);
  const app = await panelFixture({ forwardDownloadDir: h.directory }); t.after(() => app.close());
  const result = await buildForward({ root: h.root, origin: app.config.origin }, { run: h.run });
  const url = '/api/forward/download/windows-amd64?generation=' + result.generation;
  assert.equal((await app.request(url)).status, 401); await app.login();
  const response = await app.request(url); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.files.find(item => item.arch === 'windows-amd64').sha256);
  assert.equal((await app.request(url + '&generation=' + result.generation)).status, 400);
  assert.equal((await app.request('/api/forward/download/windows-amd64?generation=../../outside')).status, 400);
  assert.equal((await app.request('/api/forward/download/windows-amd64?generation=' + '0'.repeat(32))).status, 410);
});


test('helper builds bind defaults and publication metadata to the configured node prefix', async t => {
  const h = await fixture(t);
  await writeFile(join(h.root, '.env'), 'PUBLIC_ORIGIN=https://desk.example.test\nENTRY_BASE_PATH=/node/site-a/\n', { mode: 0o600 });
  let compiled = false;
  const run = async (file, args, options) => {
    if (file === 'go' && args[0] === 'build') {
      compiled = true;
      assert(args.includes('-s -w -X main.defaultServer=https://desk.example.test/node/site-a/ -X main.version=0.7.3+123456abcdef'));
    }
    return h.run(file, args, options);
  };
  const result = await buildForward({ root: h.root }, { run }); assert(compiled);
  const manifest = JSON.parse(await readFile(join(h.root, 'data/forward-client/releases', result.generation, 'manifest.json')));
  assert.equal(manifest.server, 'https://desk.example.test/node/site-a/');
  const downloads = createForwardDownloads(h.directory, { server: manifest.server });
  assert((await downloads.list())[0].href.startsWith('/node/site-a/api/forward/download/'));
  const other = createForwardDownloads(h.directory, { server: 'https://desk.example.test/node/site-b/' });
  assert.deepEqual(await other.list(), []);
  await assert.rejects(other.serve('windows-amd64', {}), /入口已变化/);
});
