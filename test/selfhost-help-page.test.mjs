import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP_PAGE_LIMIT, readHelpPage } from '../selfhost/help-page.mjs';

test('optional help document is bounded and rejects unsafe files instead of publishing them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-help-page-')), file = join(directory, 'help.html');
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readHelpPage(file, { optional: true }), null);
  await assert.rejects(readHelpPage(file), { code: 'ENOENT' });
  await writeFile(file, '<!doctype html><h1>部署教程</h1>', { mode: 0o640 });
  assert.match((await readHelpPage(file)).toString(), /部署教程/);
  const link = join(directory, 'link.html'); await symlink(file, link);
  await assert.rejects(readHelpPage(link, { optional: true }));
  await assert.rejects(readHelpPage(directory), /普通文件/);
  await chmod(file, 0o666); await assert.rejects(readHelpPage(file), /写入/); await chmod(file, 0o640);
  await writeFile(file, Buffer.alloc(HELP_PAGE_LIMIT)); assert.equal((await readHelpPage(file)).length, HELP_PAGE_LIMIT);
  await writeFile(file, Buffer.alloc(HELP_PAGE_LIMIT + 1)); await assert.rejects(readHelpPage(file), /512 KiB/);
  await writeFile(file, ''); await assert.rejects(readHelpPage(file), /非空/);
});
