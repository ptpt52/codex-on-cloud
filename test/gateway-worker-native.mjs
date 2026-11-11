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

const tools = process.env.WORKER_TOOLS;
if (!tools) throw Error('请设置 WORKER_TOOLS，指向固定 wrangler@4.158.0 的工具目录');
const require = createRequire(join(resolve(tools), 'package.json')); assert.equal(require('wrangler/package.json').version, '4.158.0');
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const root = await mkdtemp(join(tmpdir(), 'codex-gateway-worker-')); let runtime, socket, agentSocket, h;
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
  const deniedUpgrade = await new Promise((resolve, reject) => {
    const anonymous = new WebSocket('ws://127.0.0.1:' + port + '/session/connect?node=' + a.gatewayEntry.id, { origin, handshakeTimeout: 5000 });
    anonymous.on('error', reject); anonymous.once('open', () => { anonymous.terminate(); reject(Error('Unauthenticated upgrade accepted')); });
    anonymous.once('unexpected-response', (_request, response) => { response.resume(); anonymous.terminate(); resolve(response.statusCode); });
  }); assert.equal(deniedUpgrade, 401);
  const page = await runtime.dispatchFetch(origin); assert.equal(page.status, 200); assert((await page.text()).includes('name="gateway-entry"'));
  const nodeHeaders = app => ({ host: new URL(origin).host, origin, 'x-codex-node': app.gatewayEntry.id });
  const panelLogin = async app => {
    const result = await runtime.dispatchFetch(origin + '/api/login', { method: 'POST', headers: { ...nodeHeaders(app), 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: app.config.password }) });
    assert.equal(result.status, 200); return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: (await result.json()).csrf };
  };
  const first = await panelLogin(a), viewer = crypto.randomUUID();
  const claim = await runtime.dispatchFetch(origin + '/api/desktop/claim', { method: 'POST', headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-csrf-token': first.csrf, 'x-viewer-id': viewer, 'content-type': 'application/json' }, body: JSON.stringify({ viewer }) }); assert.equal(claim.status, 200);
  const helpers = await runtime.dispatchFetch(origin + '/api/forward/agents', { headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-viewer-id': viewer } });
  assert.equal(helpers.status, 200); const agentId = (await helpers.json()).agents[0].id;
  const keyResponse = await runtime.dispatchFetch(origin + '/api/forward/agents/key?id=' + agentId, { headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-viewer-id': viewer } });
  assert.equal(keyResponse.status, 200); const grant = JSON.parse(Buffer.from((await keyResponse.json()).key.slice(6), 'base64url'));
  const bytes = Buffer.alloc(65536, 97);
  const uploaded = await runtime.dispatchFetch(origin + '/api/files/native.txt', { method: 'PUT', headers: { ...nodeHeaders(a), cookie: first.cookie, 'x-csrf-token': first.csrf, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'if-none-match': '*' }, body: bytes });
  assert.equal(uploaded.status, 200, await uploaded.text()); assert.deepEqual(a.files.get('native.txt'), bytes);
  const downloaded = await runtime.dispatchFetch(origin + '/api/files/native.txt?node=' + a.gatewayEntry.id, { headers: { host: new URL(origin).host, cookie: first.cookie } }); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const terminal = (await a.controls.listTerminals()).terminals[0], query = new URLSearchParams({ node: a.gatewayEntry.id, viewer, streamId: 'd'.repeat(32), mode: 'terminal', terminalId: terminal.id, terminalToken: terminal.token });
  socket = new WebSocket('ws://127.0.0.1:' + port + '/session/connect?' + query, { origin, headers: { host: new URL(origin).host, cookie: first.cookie }, handshakeTimeout: 5000 });
  const welcome = once(socket, 'message'); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'auth', csrf: first.csrf })); assert.equal(JSON.parse((await welcome)[0]).type, 'welcome');
  await select(b.gatewayEntry); assert.equal(socket.readyState, WebSocket.OPEN);
  for (const [path, error] of [['agent', 'agent_key_invalid'], ['helper', 'pair_invalid'], ['resume', 'resume_authorization_invalid'], ['data', 'stream_authorization_invalid']]) {
    const rejection = await new Promise((resolve, reject) => {
      const invalid = new WebSocket('ws://127.0.0.1:' + port + '/forward/' + path, path === 'agent' ? 'codex-agent-v2' : 'codex-forward-v1', { origin, headers: { authorization: 'Bearer ' + (path === 'agent' ? grant.agent + '.' : '') + 'z'.repeat(43), 'x-codex-forward-node': grant.node, 'x-codex-agent-instance': 'e'.repeat(32), 'x-codex-forward-resume': '1' }, handshakeTimeout: 5000 });
      invalid.on('error', reject); invalid.once('open', () => { invalid.terminate(); reject(Error('Invalid helper credentials accepted')); });
      invalid.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode, headers: response.headers }); invalid.terminate(); });
    });
    assert.equal(rejection.status, 401, path + ' authentication must survive gateway identity checks');
    assert.equal(rejection.headers['x-codex-node-id'], a.gatewayEntry.id); assert.equal(rejection.headers['x-codex-forward-error'], error);
  }
  // A new native connection remains on its granting node after the browser's
  // global selection changes. No browser cookie is passed to the helper.
  agentSocket = new WebSocket('ws://127.0.0.1:' + port + '/forward/agent', 'codex-agent-v2', { origin, headers: { authorization: 'Bearer ' + grant.agent + '.' + grant.secret, 'x-codex-forward-node': grant.node, 'x-codex-agent-instance': 'a'.repeat(32) }, handshakeTimeout: 5000 });
  const agentWelcome = once(agentSocket, 'message'); await once(agentSocket, 'open');
  const agentReady = JSON.parse((await agentWelcome)[0]); assert.equal(agentReady.type, 'agent-ready'); assert.equal(agentReady.node.id, a.gatewayEntry.id);
  assert.equal((await (await control('nodes')).json()).activeId, b.gatewayEntry.id);
  agentSocket.close(1000, 'client_stopping'); await once(agentSocket, 'close'); agentSocket = undefined;
  const second = await panelLogin(b);
  const stale = await runtime.dispatchFetch(origin + '/api/files/native.txt?node=' + a.gatewayEntry.id, { headers: { host: new URL(origin).host, cookie: first.cookie + '; ' + second.cookie } }); assert.equal(stale.status, 409);
  socket.terminate(); socket = undefined;
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options)); await runtime.ready;
  const restored = await (await control('nodes')).json(); assert.equal(restored.nodes.length, 2); assert.equal(restored.activeId, b.gatewayEntry.id);
  assert.deepEqual(a.terminalInputs, []); assert.deepEqual(b.terminalInputs, []); assert.equal(a.managementStats.restarts + b.managementStats.restarts, 0);
  console.log('PASS actual workerd/SQLite: independent gateway authentication, dynamic enrollment, atomic selection, streaming HTTP upload/download, WSS pass-through retained across selection, native helper pinned to its granting node, helper handshake rejection codes preserved, stale-node rejection, and persistent routing after Worker restart. No CF API or production input.');
} finally { socket?.terminate(); agentSocket?.terminate(); await runtime?.dispose(); await h?.close(); await rm(root, { recursive: true, force: true }); }
