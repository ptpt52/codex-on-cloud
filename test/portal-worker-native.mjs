// Actual workerd + SQLite Durable Object checks; no Cloudflare account or live node.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setupPortal } from '../scripts/setup-portal.mjs';
import { buildPortal, PORTAL_COMPATIBILITY_DATE } from '../scripts/build-portal.mjs';
import { decodePortalCode } from '../panel/public/node-directory.js';
import { portalDigest } from '../portal/registry.mjs';
const tools = process.env.PORTAL_WORKER_TOOLS;
if (!tools) throw Error('请设置 PORTAL_WORKER_TOOLS，指向安装固定 wrangler@4.158.0 的临时目录；详见 docs/portal.md');
const require = createRequire(join(resolve(tools), 'package.json'));
assert.equal(require('wrangler/package.json').version, '4.158.0');
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const root = await mkdtemp(join(tmpdir(), 'codex-portal-worker-'));
let runtime;
try {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const setup = await setupPortal({ root, origin, home: 'https://home-codex.example.com' });
  const output = join(root, 'build'); await buildPortal({ config: setup.config, output, passwordFile: setup.passwordFile });
  const secret = JSON.parse(await readFile(join(output, 'worker-secrets.json'), 'utf8'));
  const options = { name: 'portal-test', host: '127.0.0.1', port, cf: false, scriptPath: join(output, 'worker.mjs'), modules: true, compatibilityDate: PORTAL_COMPATIBILITY_DATE, bindings: secret,
    durableObjects: { NODE_REGISTRY: { className: 'NodeRegistry', useSQLite: true } }, resourcePersistencePath: join(root, 'state'), log: new Log(LogLevel.ERROR) };
  runtime = new Miniflare(convertV4MiniflareOptions(options)); await runtime.ready;
  let cookie = '', csrf = '';
  const request = (path, method = 'GET', body, headers = {}) => runtime.dispatchFetch(origin + path, { method, headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request('/api/nodes')).status, 401);
  const login = await request('/api/login', 'POST', { password: (await readFile(setup.passwordFile, 'utf8')).trim() }); assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0]; let directory = await (await request('/api/nodes')).json(); csrf = directory.csrf;
  const grant = await (await request('/api/authorization-codes', 'POST', { name: '可重复接入' })).json(); const code = decodePortalCode(grant.code).key;
  for (const [id, nodeSecret] of [['home', 'a'.repeat(64)], ['work', 'b'.repeat(64)]]) {
    const response = await request('/api/register', 'POST', { authorizationCode: code, nodeSecret, node: { id, name: id, origin: `https://${id}-codex.example.com`, mode: 'terminal' } }, { cookie: '', 'x-csrf-token': '' }); assert.equal(response.status, 200);
  }
  directory = await (await request('/api/nodes')).json(); assert.equal(directory.nodes.length, 2);
  const work = directory.nodes.find(node => node.id === 'work');
  const response = await request('/api/nodes/work', 'PUT', { revision: directory.revision, node: { ...work, enabled: true } }); assert.equal(response.status, 200);
  assert.equal((await request('/api/authorization-codes/' + grant.id, 'DELETE', {})).status, 200);
  const directoryKey = await portalDigest('directory-v1\0' + 'a'.repeat(64) + '\0' + origin);
  assert.equal((await request('/api/directory', 'GET', undefined, { cookie: '', authorization: 'Bearer ' + directoryKey })).status, 200);
  assert.equal((await request('/api/register', 'POST', { authorizationCode: code, nodeSecret: 'c'.repeat(64), node: { id: 'third', name: 'third', origin: 'https://third.example.com' } }, { cookie: '' })).status, 401);
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options)); await runtime.ready;
  const restored = await request('/api/nodes'), retained = await restored.json(); assert.equal(restored.status, 200, JSON.stringify(retained)); assert.equal(retained.nodes.length, 2); assert.equal(retained.nodes.find(node => node.id === 'work').enabled, true);
  assert.equal((await request('/api/directory', 'GET', undefined, { cookie: '', authorization: 'Bearer ' + directoryKey })).status, 200);
  assert.deepEqual((await (await request('/api/authorization-codes')).json()).codes, []);
  console.log('Actual workerd/SQLite portal passed: authentication, reusable registration, dynamic update, code revocation and persistent data across runtime restart.');
} finally { await runtime?.dispose(); await rm(root, { recursive: true, force: true }); }
