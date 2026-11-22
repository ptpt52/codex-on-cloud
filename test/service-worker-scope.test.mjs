import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ASSETS, createUIAssets } from '../panel/ui-assets.mjs';

async function loadWorker(base = '/node/a/') {
  const assets = await createUIAssets({ entryBasePath: base });
  const source = assets.get('/sw.js').bytes.toString();
  const listeners = new Map(), opened = [], deleted = [], requests = [];
  const keySet = new Set([
    'codex-cloud-shell:revision-current', 'codex-cloud-shell-%2Fnode%2Fa%2F:revision-old',
    'codex-cloud-shell-old-/node/a/', 'codex-cloud-shell:%2Fnode%2Fb%2F:revision-a',
    'codex-cloud-shell-old-/node/b/', 'unrelated-cache',
  ]);
  const caches = {
    async open(name) { opened.push(name); keySet.add(name); return { async addAll(values) { requests.push(...values); } }; },
    async keys() { return [...keySet]; },
    async delete(name) { deleted.push(name); return keySet.delete(name); },
  };
  vm.runInNewContext(source, { self: { location: { origin: 'https://desk.example.test' }, addEventListener: (name, callback) => listeners.set(name, callback) }, caches, URL, fetch: async () => { throw Error('offline'); } });
  const wait = async name => {
    let pending;
    listeners.get(name)({ waitUntil: promise => { pending = promise; } });
    await pending;
  };
  return { opened, deleted, keySet, requests, wait, revision: assets.revision };
}

test('Service Worker cache cleanup is isolated to its node entry scope', async () => {
  const worker = await loadWorker('/node/a/');
  await worker.wait('install');
  assert(worker.opened[0].startsWith('codex-cloud-shell:%2Fnode%2Fa%2F:'));
  assert(worker.requests.includes('/node/a/?ui=' + worker.revision));
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

test('the offline shell lists only public assets within its entry at the matching revision', async () => {
  const publicRoutes = [...ASSETS.keys()].filter(route => route !== '/sw.js' && !/^\/(desktop|terminal)\//.test(route)).sort();
  for (const base of ['/', '/node/a/']) {
    const worker = await loadWorker(base);
    await worker.wait('install');
    const routes = worker.requests.map(value => {
      const url = new URL(value, 'https://desk.example.test');
      assert.equal(url.origin, 'https://desk.example.test');
      assert.ok(url.pathname.startsWith(base));
      assert.equal(url.search, '?ui=' + worker.revision);
      return '/' + url.pathname.slice(base.length);
    });
    assert.deepEqual(routes.sort(), publicRoutes);
  }
});
