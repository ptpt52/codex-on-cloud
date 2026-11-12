import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serverUpdate } from '../selfhost/server-update.mjs';
import { caddyAcmeBootstrap, caddyConfig } from '../selfhost/server-config.mjs';

async function setup(t) {
  const root = await mkdtemp('/tmp/codex-server-update-'); t.after(() => rm(root, { recursive: true, force: true }));
  const files = [join(root, 'Caddyfile'), join(root, 'new-unit')], directory = join(root, 'backup');
  await writeFile(files[0], 'old https configuration', { mode: 0o640 });
  await chmod(files[0], 0o640);
  const application = { current: join(root, 'app'), previous: join(root, 'app.previous'), failed: join(root, 'app.failed') };
  await mkdir(application.current); await writeFile(join(application.current, 'version'), 'old');
  const calls = [], run = async (_file, args) => { calls.push(args); return { ok: true, stdout: args[0] === 'is-active' ? 'active' : args[0] === 'is-enabled' ? 'enabled' : '' }; };
  return { directory, files, application, services: ['center', 'edge'], run, calls };
}

test('certificate bootstrap preserves HTTPS while adding or refreshing HTTP-01 routes', () => {
  for (const redirectHttp of [false, true]) {
    const previous = caddyConfig('desk.example.test', { redirectHttp });
    const next = caddyAcmeBootstrap('desk.example.test', '/new/webroot', previous);
    assert(next.includes('https://desk.example.test {')); assert(next.includes('tls /etc/codex-selfhost/tls/fullchain.pem'));
    assert(next.includes('root * /new/webroot')); assert.equal(next.match(/http:\/\/desk.example.test \{/g).length, 1);
    assert(!next.includes('auto_https off'));
  }
  assert(caddyAcmeBootstrap('desk.example.test', '/webroot').includes('auto_https off'));
});

test('failed updates restore configuration, file permissions, application and previous service state', async t => {
  const h = await setup(t), transaction = await serverUpdate(h);
  await transaction.applicationChanging(); await rename(h.application.current, h.application.previous);
  await mkdir(h.application.current); await writeFile(join(h.application.current, 'version'), 'new');
  await writeFile(h.files[0], 'HTTP bootstrap'); await writeFile(h.files[1], 'new unit');
  await transaction.rollback();
  assert.equal(await readFile(h.files[0], 'utf8'), 'old https configuration'); assert.equal((await stat(h.files[0])).mode & 0o777, 0o640);
  assert.equal(await readFile(join(h.application.current, 'version'), 'utf8'), 'old');
  await assert.rejects(stat(h.files[1]), { code: 'ENOENT' }); await assert.rejects(stat(h.directory), { code: 'ENOENT' });
  assert(h.calls.some(args => args.join(' ') === 'restart center edge'));
});

test('an incomplete restore retains private bounded backups and can be recovered without replaying installation', async t => {
  const h = await setup(t), transaction = await serverUpdate(h);
  await writeFile(h.files[0], 'broken');
  const original = h.run;
  // A second process sees the same journal; service-stop failure must preserve it.
  const failed = await serverUpdate({ ...h, recover: true, run: async (_file, args) => args[0] === 'stop' ? { ok: false } : { ok: true, stdout: 'active' } });
  await assert.rejects(failed.rollback(), /无法确认/);
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700);
  await assert.rejects(serverUpdate(h), /未完成/);
  await (await serverUpdate({ ...h, recover: true, run: original })).rollback();
  assert.equal(await readFile(h.files[0], 'utf8'), 'old https configuration');
  void transaction;
});

test('successful updates discard their backup and leave the new configuration in place', async t => {
  const h = await setup(t), transaction = await serverUpdate(h);
  await writeFile(h.files[0], 'new https configuration'); await transaction.commit();
  assert.equal(await readFile(h.files[0], 'utf8'), 'new https configuration');
  await assert.rejects(stat(h.directory), { code: 'ENOENT' });
});

test('recovery only cleans a committed journal and never rolls back an already validated update', async t => {
  const h = await setup(t); await serverUpdate(h);
  await writeFile(h.files[0], 'committed configuration');
  const manifest = join(h.directory, 'manifest.json'), state = JSON.parse(await readFile(manifest, 'utf8'));
  state.committed = true; await writeFile(manifest, JSON.stringify(state)); h.calls.length = 0;
  assert.deepEqual(await (await serverUpdate({ ...h, recover: true })).rollback(), { committed: true });
  assert.equal(await readFile(h.files[0], 'utf8'), 'committed configuration'); assert.deepEqual(h.calls, []);
});

test('oversized configuration is rejected before changing files or services', async t => {
  const h = await setup(t); await writeFile(h.files[0], Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(serverUpdate(h), /大小无效/);
  assert.equal((await stat(h.files[0])).size, 1024 * 1024 + 1); assert.deepEqual(h.calls, []);
  await assert.rejects(stat(h.directory), { code: 'ENOENT' });
});
