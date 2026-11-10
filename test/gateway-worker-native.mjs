// Actual workerd + persistent SQLite + HTTP/WSS forwarding through private
// panel ingress. Terminal/file/manager upstreams are fixtures; no CF account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { setupGateway } from '../scripts/setup-gateway.mjs';
import { buildGateway, GATEWAY_COMPATIBILITY_DATE } from '../scripts/build-gateway.mjs';
import { decodeGatewayCode } from '../gateway/protocol.mjs';
import { gatewayHTTPFixture } from './gateway-http-fixture.mjs';

const tools = process.env.PORTAL_WORKER_TOOLS;
if (!tools) throw Error('请设置 PORTAL_WORKER_TOOLS，指向固定 wrangler@4.158.0 的工具目录');
const require = createRequire(join(resolve(tools), 'package.json')); assert.equal(require('wrangler/package.json').version, '4.158.0');
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const root = await mkdtemp(join(tmpdir(), 'codex-gateway-worker-')); let runtime, socket, h;
try {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port; h = await gatewayHTTPFixture({ origin }); const a = await h.add(1), b = await h.add(2);
  const setup = await setupGateway({ root, origin, backendZone: 'localhost' }), output = join(root, 'build'); await buildGateway({ config: setup.config, output, passwordFile: setup.passwordFile });
  const bindings = JSON.parse(await readFile(join(output, 'worker-secrets.json'))), options = { name: 'gateway-test', host: '127.0.0.1', port, cf: false, scriptPath: join(output, 'worker.mjs'), modules: true, modulesRoot: output, compatibilityDate: GATEWAY_COMPATIBILITY_DATE, bindings,
    durableObjects: { GATEWAY_REGISTRY: { className: 'GatewayState', useSQLite: true } }, resourcePersistencePath: join(root, 'state'), log: new Log(LogLevel.ERROR) };
  runtime = new Miniflare(convertV4MiniflareOptions(options)); await runtime.ready;
  let cookie = '', csrf = '';
  const control = (path, method = 'GET', body, headers = {}) => runtime.dispatchFetch(origin + '/__nodes/api/' + path, { method, headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await control('nodes')).status, 401);
  const login = await control('login', 'POST', { password: (await readFile(setup.passwordFile, 'utf8')).trim() }); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await (await control('nodes')).json()).csrf;
  const code = decodeGatewayCode((await (await control('codes', 'POST', { name: '动态节点' })).json()).code).key;
  for (const app of [a, b]) {
    const node = app.gatewayEntry, enrolled = await control('register', 'POST', { authorizationCode: code, secret: node.secret, node: { id: node.id, name: node.name, backendOrigin: node.backendOrigin, mode: 'terminal' } });
    assert.equal(enrolled.status, 200, await enrolled.text());
  }
  const select = async node => { const state = await (await control('nodes')).json(); const result = await control('switch', 'POST', { nodeId: node.id, revision: state.revision, operation: crypto.randomUUID().replaceAll('-', '') }); assert.equal(result.status, 200, await result.text()); };
  await select(a.gatewayEntry);
  const page = await runtime.dispatchFetch(origin); assert.equal(page.status, 200); assert((await page.text()).includes('name="gateway-entry"'));
  const nodeHeaders = app => ({ host: new URL(origin).host, origin, 'x-codex-node': app.gatewayEntry.id });
  const panelLogin = async app => {
    const result = await runtime.dispatchFetch(origin + '/api/login', { method: 'POST', headers: { ...nodeHeaders(app), 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: app.config.password }) });
    assert.equal(result.status, 200); return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: (await result.json()).csrf };
  };
  const first = await panelLogin(a), viewer = crypto.randomUUID();
  const claim = await runtime.dispatchFetch(origin + '/api/desktop/claim', { method: 'POST', headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-csrf-token': first.csrf, 'x-viewer-id': viewer, 'content-type': 'application/json' }, body: JSON.stringify({ viewer }) }); assert.equal(claim.status, 200);
  const bytes = Buffer.alloc(65536, 97);
  const uploaded = await runtime.dispatchFetch(origin + '/api/files/native.txt', { method: 'PUT', headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-csrf-token': first.csrf, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'if-none-match': '*' }, body: bytes });
  assert.equal(uploaded.status, 200, await uploaded.text()); assert.deepEqual(a.files.get('native.txt'), bytes);
  const downloaded = await runtime.dispatchFetch(origin + '/api/files/native.txt?node=' + a.gatewayEntry.id, { headers: { host: new URL(origin).host, cookie: first.cookie } }); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const terminal = (await a.controls.listTerminals()).terminals[0], query = new URLSearchParams({ node: a.gatewayEntry.id, viewer, streamId: 'd'.repeat(32), mode: 'terminal', terminalId: terminal.id, terminalToken: terminal.token });
  socket = new WebSocket('ws://127.0.0.1:' + port + '/session/connect?' + query, { origin, headers: { host: new URL(origin).host, cookie: first.cookie }, handshakeTimeout: 5000 });
  const welcome = once(socket, 'message'); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'auth', csrf: first.csrf })); assert.equal(JSON.parse((await welcome)[0]).type, 'welcome');
  await select(b.gatewayEntry); assert.equal(socket.readyState, WebSocket.OPEN);
  const second = await panelLogin(b);
  const stale = await runtime.dispatchFetch(origin + '/api/files/native.txt?node=' + a.gatewayEntry.id, { headers: { host: new URL(origin).host, cookie: first.cookie + '; ' + second.cookie } }); assert.equal(stale.status, 409);
  socket.terminate(); socket = undefined;
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options)); await runtime.ready;
  const restored = await (await control('nodes')).json(); assert.equal(restored.nodes.length, 2); assert.equal(restored.activeId, b.gatewayEntry.id);
  assert.deepEqual(a.terminalInputs, []); assert.deepEqual(b.terminalInputs, []); assert.equal(a.managementStats.restarts + b.managementStats.restarts, 0);
  console.log('PASS actual workerd/SQLite: independent gateway authentication, dynamic enrollment, atomic selection, streaming HTTP upload/download, WSS pass-through retained across selection, stale-node rejection, and persistent routing after Worker restart. No CF API or production input.');
} finally { socket?.terminate(); await runtime?.dispose(); await h?.close(); await rm(root, { recursive: true, force: true }); }
