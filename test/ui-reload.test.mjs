import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, unlink, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUIAssets, UI_LIMITS } from '../panel/ui-assets.mjs';
import { serveUIReload, requestUIReload } from '../native/ui-reload.mjs';
import { uiSnapshot } from './support/ui-snapshot.mjs';
import { fixture } from './fixture.mjs';

test('complete version snapshots are bounded and atomic; invalid syntax, missing, growing and special files preserve last good assets', async t => {
  const snapshot = await uiSnapshot(); t.after(() => rm(snapshot.directory, { recursive: true, force: true }));
  const assets = await createUIAssets({ root: snapshot.root }), initial = assets.revision;
  const script = new URL('control.js', snapshot.root), original = await readFile(script);
  await writeFile(script, 'export const = nope'); await assert.rejects(assets.reload()); assert.equal(assets.revision, initial);
  await writeFile(script, "import { missingExport } from './shortcuts.js';\nexport const sample = missingExport;"); await assert.rejects(assets.reload()); assert.equal(assets.revision, initial);
  await unlink(script); await assert.rejects(assets.reload()); assert.equal(assets.revision, initial);
  execFileSync('mkfifo', [script.pathname]); await assert.rejects(assets.reload()); await unlink(script);
  await symlink(new URL('app.js', snapshot.root), script); await assert.rejects(assets.reload()); await unlink(script);
  await writeFile(script, Buffer.alloc(UI_LIMITS.file + 1)); await assert.rejects(assets.reload());
  await writeFile(script, original); assert.equal((await assets.reload()).changed, false);
  for (let i = 0; i < UI_LIMITS.generations; i++) {
    await writeFile(script, Buffer.concat([original, Buffer.from('\n// revision ' + i)])); await assets.reload();
  }
  assert.throws(() => assets.get('/control.js', initial), { status: 410 });
  assert.match(assets.get('/').bytes.toString(), new RegExp('"/control.js":"/control.js\\?ui=' + assets.revision));
});

test('private reload IPC refuses occupied regular files and live sockets, rejects overlap, and serves no public mutation endpoint', async t => {
  const app = await fixture(); t.after(() => app.close()); const path = join(app.directory, 'ui.sock');
  await writeFile(path, 'do not overwrite'); await assert.rejects(serveUIReload(path, app.panel.reloadUI)); assert.equal(await readFile(path, 'utf8'), 'do not overwrite'); await unlink(path);
  let release; const held = new Promise(resolve => { release = resolve; });
  const stop = await serveUIReload(path, async () => { await held; return { revision: app.panel.uiRevision, changed: false }; }); t.after(stop);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(serveUIReload(path, app.panel.reloadUI));
  const first = requestUIReload(path); await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(requestUIReload(path)); release(); assert.equal((await first).changed, false);
  assert.equal((await app.request('/reload-ui', { method: 'POST', body: {} })).status, 404);
});

test('versioned private assets retain authentication, traversal checks and CSP across a live update', async t => {
  const snapshot = await uiSnapshot(); t.after(() => rm(snapshot.directory, { recursive: true, force: true }));
  const app = await fixture({ uiRoot: snapshot.root }); t.after(() => app.close());
  const initial = app.panel.uiRevision;
  assert.equal((await app.request('/terminal/index.html?ui=' + initial)).status, 401);
  await app.login(); await app.claim();
  const response = await app.request('/'); assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.match(await response.text(), new RegExp('app.js\\?ui=' + initial));
  const styles = new URL('styles.css', snapshot.root); await writeFile(styles, (await readFile(styles, 'utf8')) + '\n/* new-version */');
  await app.panel.reloadUI(); assert.notEqual(app.panel.uiRevision, initial);
  assert.doesNotMatch(await (await app.request('/styles.css?ui=' + initial)).text(), /new-version/);
  assert.match(await (await app.request('/styles.css')).text(), /new-version/);
  assert.equal((await app.request('/api/me')).status, 200); assert.equal(app.inputCalls.length, 0); assert.equal(app.managementStats.restarts, 0);
  assert.equal((await app.request('/desktop/novnc/core/%2e%2e%2fpackage.json?ui=' + initial)).status, 404);
});
