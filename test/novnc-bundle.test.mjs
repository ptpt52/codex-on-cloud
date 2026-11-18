import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { novncBundle } from '../scripts/build-novnc.mjs';
import { ASSETS } from '../panel/ui-assets.mjs';

test('the pinned noVNC bundle is reproducible, self-contained and retains upstream notices', async () => {
  const generated = await novncBundle();
  for (const [key, path] of Object.entries({ bundle: 'novnc-bundle.js', licenses: 'novnc-LICENSES.txt', manifest: 'novnc-build.json' }))
    assert.equal(generated[key], await readFile(new URL('../panel/public/vendor/' + path, import.meta.url), 'utf8'), `Run npm run build:novnc to update ${path}`);
  assert.deepEqual(ASSETS.get('/novnc-bundle.js'), ['vendor/novnc-bundle.js', 'text/javascript; charset=utf-8']);
  assert.match(generated.licenses, /Mozilla Public License Version 2.0/);
  assert.ok(generated.licenses.includes('Copyright (C) 2014-2016 by Vitaly Puzrin'));
  assert.ok(!generated.manifest.includes(process.cwd()));
});
