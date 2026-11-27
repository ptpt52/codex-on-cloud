import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBackendRevisions, BACKEND_VERSION_LIMITS } from '../native/backend-version.mjs';
import { fixture } from './fixture.mjs';

async function sourceTree(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-backend-version-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['panel/public', 'native', 'selfhost', 'gateway', 'desktop', 'scripts']) await mkdir(join(root, path), { recursive: true });
  for (const path of ['package.json', 'package-lock.json', 'panel/main.mjs', 'native/manager.mjs', 'native/desktop-worker.mjs', 'selfhost/main.mjs', 'desktop/agent.py', 'desktop/web-terminal.py', 'panel/public/file-upload.js']) await writeFile(join(root, path), 'initial');
  await writeFile(join(root, 'panel/main.mjs'), "import './public/file-upload.js';");
  return root;
}
test('backend revisions track backend/shared sources separately from UI, state and Python helper', async t => {
  const root = await sourceTree(t), initial = await readBackendRevisions(root);
  await writeFile(join(root, 'panel/public/app.js'), 'new UI'); await mkdir(join(root, 'secrets')); await writeFile(join(root, 'secrets/password'), 'private');
  assert.deepEqual(await readBackendRevisions(root), initial);
  await writeFile(join(root, 'desktop/agent.py'), 'new helper'); const helper = await readBackendRevisions(root);
  assert.equal(helper.panel, initial.panel); assert.notEqual(helper.files, initial.files);
  await writeFile(join(root, 'panel/public/file-upload.js'), 'newSharedProtocol');
  assert.notEqual((await readBackendRevisions(root)).panel, initial.panel);
  await writeFile(join(root, 'native/new-backend.mjs'), 'newModule');
  await writeFile(join(root, 'native/manager.mjs'), "import './new-backend.mjs';");
  const changed = await readBackendRevisions(root);
  assert.notEqual(changed.manager, helper.manager); assert.equal(changed.actions, helper.actions);
});
test('editing the spawned terminal helper changes the panel deployment revision', async t => {
  const root = await sourceTree(t), before = await readBackendRevisions(root);
  await writeFile(join(root, 'desktop/web-terminal.py'), 'updated terminal helper');
  const after = await readBackendRevisions(root);
  assert.notEqual(after.panel, before.panel);
  assert.deepEqual({ ...after, panel: before.panel }, before);
});
test('backend source reads reject links and oversize files', async t => {
  const root = await sourceTree(t);
  await symlink('../package.json', join(root, 'native/linked.mjs')); await assert.rejects(readBackendRevisions(root));
  await rm(join(root, 'native/linked.mjs')); await writeFile(join(root, 'native/large.mjs'), 'x'.repeat(BACKEND_VERSION_LIMITS.file + 1)); await assert.rejects(readBackendRevisions(root));
});
for (const mode of ['terminal', 'desktop']) test(`authenticated ${mode} version diagnostics preserve tasks and match every required process`, async t => {
  const app = await fixture({ mode }); t.after(() => app.close());
  assert.equal((await app.request('/api/backend-version')).status, 401); await app.login();
  const before = app.managementStats.restarts, expected = await readBackendRevisions();
  const first = await (await app.request('/api/backend-version')).json();
  for (const component of ['panel', 'manager', 'files', ...(mode === 'desktop' ? ['actions'] : [])]) assert.equal(first.components[component].revision, expected[component]);
  await app.panel.reloadUI(); const next = await (await app.request('/api/backend-version')).json();
  assert.deepEqual(next, first); assert.equal(app.managementStats.restarts, before); assert.equal(app.terminalConnections, 0); assert.deepEqual(app.inputCalls, []);
});
