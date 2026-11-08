import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portalWrite } from '../scripts/portal-files.mjs';
test('portal configuration recovers dead writers and legacy partial files without deleting unrelated data', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'portal-writer-')); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, 'portal.json');
 await portalWrite(path, 'original'); await writeFile(path + '.portal-next', 'legacy partial');
 await writeFile(path + '.portal-next-v2', 'terminated write');
 await writeFile(path + '.portal-lock', JSON.stringify({ pid: process.pid, started: '0' }));
 await portalWrite(path, 'updated'); assert.equal(await readFile(path, 'utf8'), 'updated'); assert.equal(await readFile(path + '.portal-next', 'utf8'), 'legacy partial');
 await assert.rejects(lstat(path + '.portal-lock'), { code: 'ENOENT' }); await assert.rejects(lstat(path + '.portal-next-v2'), { code: 'ENOENT' });
});
test('portal writers reject active locks and special temporaries and recheck permission before commit', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'portal-writer-')); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, 'portal.json');
 await portalWrite(path, 'original');
 const stat = await readFile('/proc/' + process.pid + '/stat', 'utf8'), started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
 await writeFile(path + '.portal-lock', JSON.stringify({ pid: process.pid, started })); await assert.rejects(portalWrite(path, 'blocked'), /已有门户/); await rm(path + '.portal-lock');
 await symlink(path, path + '.portal-next-v2'); await assert.rejects(portalWrite(path, 'blocked'), /普通文件/); await rm(path + '.portal-next-v2');
 let checks = 0; await assert.rejects(portalWrite(path, 'revoked', { valid() { if (++checks === 3) throw Error('permission revoked'); } }), /permission revoked/);
 assert.equal(await readFile(path, 'utf8'), 'original'); await assert.rejects(lstat(path + '.portal-next-v2'), { code: 'ENOENT' }); await assert.rejects(lstat(path + '.portal-lock'), { code: 'ENOENT' });
});
