import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadWorker(base = '/node/a/') {
  const source = (await readFile(new URL('../panel/public/sw.js', import.meta.url), 'utf8'))
    .replaceAll('__UI_REVISION__', 'revision-a').replaceAll('__ENTRY_BASE_PATH__', base);
  const listeners = new Map(), opened = [], deleted = [];
  const keySet = new Set([
    'codex-cloud-shell:revision-current', 'codex-cloud-shell-%2Fnode%2Fa%2F:revision-old',
    'codex-cloud-shell-old-/node/a/', 'codex-cloud-shell:%2Fnode%2Fb%2F:revision-a',
    'codex-cloud-shell-old-/node/b/', 'unrelated-cache',
  ]);
  const caches = {
    async open(name) { opened.push(name); keySet.add(name); return { async addAll() {} }; },
    async keys() { return [...keySet]; },
    async delete(name) { deleted.push(name); return keySet.delete(name); },
  };
  vm.runInNewContext(source, { self: { location: { origin: 'https://desk.example.test' }, addEventListener: (name, callback) => listeners.set(name, callback) }, caches, URL, fetch: async () => { throw Error('offline'); } });
  const wait = name => new Promise(resolve => listeners.get(name)({ waitUntil: promise => Promise.resolve(promise).then(resolve) }));
  return { opened, deleted, keySet, wait };
}

test('Service Worker cache cleanup is isolated to its node entry scope', async () => {
  const worker = await loadWorker('/node/a/');
  await worker.wait('install');
  assert(worker.opened[0].startsWith('codex-cloud-shell:%2Fnode%2Fa%2F:'));
  assert(worker.keySet.has('codex-cloud-shell:%2Fnode%2Fb%2F:revision-a'));
  assert(worker.keySet.has('codex-cloud-shell-old-/node/b/'));
  assert(worker.keySet.has('unrelated-cache'));
  assert(worker.keySet.has('codex-cloud-shell:revision-current'));
  const own = [...worker.keySet].filter(key => key.startsWith('codex-cloud-shell:%2Fnode%2Fa%2F:'));
  assert(own.length <= 4); assert(own.includes(worker.opened[0]));

  worker.deleted.length = 0;
  await worker.wait('activate');
  assert(worker.deleted.every(key => !key.includes('%2Fnode%2Fb%2F') && !key.endsWith('-/node/b/') && key !== 'unrelated-cache'));
  assert(worker.deleted.includes('codex-cloud-shell-old-/node/a/'));
  assert(worker.keySet.has(worker.opened[0]));
  assert(worker.keySet.has('codex-cloud-shell:%2Fnode%2Fb%2F:revision-a'));
});
