import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { portalFixture } from './portal-fixture.mjs';
import { parseNodeDirectory, decodePortalCode, encodePortalCode } from '../panel/public/node-directory.js';
import { setupPortal } from '../scripts/setup-portal.mjs';
import { buildPortal } from '../scripts/build-portal.mjs';
import { portalDigest } from '../portal/registry.mjs';
const directoryToken = ({nodeSecret, portalOrigin}) => portalDigest('directory-v1\0' + nodeSecret + '\0' + portalOrigin);

const node = (id = 'home') => ({ id, name: id, origin: `https://${id}-codex.example.com`, mode: 'desktop', enabled: true });
const register = async (portal, code, entry, secret = 'b'.repeat(64)) => portal.request('/api/register', { method: 'POST', body: { authorizationCode: decodePortalCode(code).key, nodeSecret: secret, node: entry }, headers: { cookie: '', 'x-csrf-token': '' } });

test('directory validation excludes credentials, duplicate origins, unsafe URLs and unbounded metadata', () => {
  const value = { version: 1, portalOrigin: 'https://portal.example.com', nodes: [node()] };
  assert.equal(parseNodeDirectory(value).nodes[0].enabled, true);
  assert.deepEqual(parseNodeDirectory({ ...value, nodes: [] }).nodes, []);
  for (const origin of ['javascript:alert(1)', 'http://192.168.1.1', 'https://user:pass@example.com', 'https://example.com/a', 'https://example.com?secret=a']) assert.throws(() => parseNodeDirectory({ ...value, nodes: [{ ...node(), origin }] }));
  assert.throws(() => parseNodeDirectory({ ...value, password: 'do-not-publish' }));
  assert.throws(() => parseNodeDirectory({ ...value, nodes: [{ ...node(), token: 'do-not-publish' }] }));
  assert.throws(() => parseNodeDirectory({ ...value, nodes: [node(), { ...node('work'), origin: node().origin }] }));
  assert.throws(() => parseNodeDirectory({ ...value, nodes: Array.from({ length: 33 }, (_, i) => node('n' + i)) }));
  assert.throws(() => parseNodeDirectory({ ...value, nodes: [{ ...node(), id: ['home'] }] }));
  const code = encodePortalCode(value.portalOrigin, 'a'.repeat(64)); assert.equal(decodePortalCode(code).origin, value.portalOrigin); assert.throws(() => decodePortalCode('coc1.bad'));
});

test('portal authentication, CSRF, origins and read-only node credentials protect the dynamic registry', async t => {
  const portal = await portalFixture({ nodes: [node()] }); t.after(portal.close);
  assert.equal((await portal.request('/api/nodes')).status, 401);
  assert.equal((await portal.request('/api/login', { method: 'POST', body: { password: portal.password }, headers: { origin: 'https://attacker.example' } })).status, 403);
  let directory = await portal.login();
  assert.equal((await portal.request('/api/nodes', { method: 'POST', body: { revision: directory.revision, node: node('work') }, headers: { 'x-csrf-token': 'bad' } })).status, 403);
  assert.equal((await portal.request('/api/nodes', { method: 'POST', body: { revision: directory.revision, node: node('work') } })).status, 200);
  assert.equal((await portal.request('/api/nodes', { method: 'POST', body: { revision: directory.revision, node: node('stale') } })).status, 409);
  directory = await (await portal.request('/api/nodes')).json(); assert.equal(directory.nodes.length, 2);
  const code = await portal.code(); const response = await register(portal, code.code, node()); assert.equal(response.status, 200);
  const token = await directoryToken({ nodeSecret: 'b'.repeat(64), portalOrigin: portal.origin });
  assert.equal((await portal.request('/api/directory', { headers: { cookie: '', authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await portal.request('/api/nodes', { headers: { cookie: '', authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await portal.request('/api/authorization-codes', { method: 'POST', body: { name: 'forbidden' }, headers: { cookie: '', authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await portal.worker.fetch(new Request('https://unprotected.workers.dev/api/nodes'), portal.env)).status, 400);
});

test('one persistent code enrolls multiple domains; deleting it preserves existing identities and directory access', async t => {
  const portal = await portalFixture(); t.after(portal.close); await portal.login(); const code = await portal.code();
  assert.equal((await register(portal, code.code, node('home'))).status, 200);
  portal.advance(90 * 86400000);
  assert.equal((await register(portal, code.code, node('work'), 'c'.repeat(64))).status, 200);
  assert.equal((await register(portal, code.code, node('home'), 'd'.repeat(64))).status, 409);
  const first = await register(portal, code.code, node('work'), 'c'.repeat(64)); assert.equal(first.status, 200);
  await portal.login(); const directory = await (await portal.request('/api/nodes')).json(); assert.equal(directory.nodes.length, 2); assert.equal(directory.nodes.every(item => item.enabled), true);
  assert.equal((await portal.request('/api/authorization-codes/' + code.id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await register(portal, code.code, node('third'), 'e'.repeat(64))).status, 401);
  assert.equal((await register(portal, code.code, node('home'))).status, 200);
  const token = await directoryToken({ nodeSecret: 'b'.repeat(64), portalOrigin: portal.origin });
  assert.equal((await portal.request('/api/directory', { headers: { cookie: '', authorization: 'Bearer ' + token } })).status, 200);
  const listed = await (await portal.request('/api/authorization-codes')).json(); assert.deepEqual(listed.codes, []);
});

test('registry bounds codes and sessions and retains dynamic data across Worker instances and credential rotation', async t => {
  const portal = await portalFixture(); t.after(portal.close); await portal.login();
  for (let i = 0; i < 16; i++) await portal.code('code ' + i);
  assert.equal((await portal.request('/api/authorization-codes', { method: 'POST', body: { name: 'overflow' } })).status, 429);
  for (let i = 0; i < 10; i++) await portal.login(); assert.equal(portal.storage.value.sessions.length, 8);
  const snapshot = structuredClone(portal.storage.value); assert.equal(snapshot.codes.length, 16); assert.equal(JSON.stringify(snapshot).length < 65536, true);
  const password = portal.env.PORTAL_PASSWORD_HASH; portal.env.PORTAL_PASSWORD_HASH = 'f'.repeat(64);
  assert.equal((await portal.request('/api/nodes')).status, 401); assert.equal(portal.storage.value.codes.length, 16); portal.env.PORTAL_PASSWORD_HASH = password;
});

test('portal setup and build keep credentials private, avoid dependencies and preserve bootstrap configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-build-portal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await setupPortal({ root, origin: 'https://codex.example.com', home: 'https://home-codex.example.com', work: 'https://work-codex.example.com' });
  const first = await readFile(paths.passwordFile, 'utf8'); await setupPortal({ root }); assert.equal(await readFile(paths.passwordFile, 'utf8'), first);
  const output = join(root, 'build'); const result = await buildPortal({ config: paths.config, output, passwordFile: paths.passwordFile }); assert.equal(result.nodes, 2);
  const bundle = await readFile(join(output, 'worker.mjs'), 'utf8'); assert.equal(bundle.includes(first.trim()), false); assert.match(bundle, /class NodeRegistry/);
  const built = await import(pathToFileURL(join(output, 'worker.mjs')).href); assert.equal(typeof built.NodeRegistry, 'function');
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8')); assert.equal(config.workers_dev, false); assert.deepEqual(config.migrations[0].new_sqlite_classes, ['NodeRegistry']);
  await symlink(paths.passwordFile, join(root, 'linked')); await assert.rejects(buildPortal({ config: paths.config, output, passwordFile: join(root, 'linked') }));
});
