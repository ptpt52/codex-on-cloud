import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fixture } from './fixture.mjs';
import { normalizeEntryBasePath, stripEntryPath } from '../panel/entry-path.mjs';
import { sessionCookie } from '../panel/auth.mjs';

test('entry base path is canonical and matching requires the node path boundary', () => {
  assert.equal(normalizeEntryBasePath(undefined), '/');
  assert.equal(normalizeEntryBasePath(''), '/');
  assert.equal(normalizeEntryBasePath('/'), '/');
  assert.equal(normalizeEntryBasePath('/node/a/'), '/node/a/');
  assert.equal(normalizeEntryBasePath('/node/a-' + 'b'.repeat(45) + '/'), '/node/a-' + 'b'.repeat(45) + '/');
  for (const value of ['/node/a', 'node/a/', '/node//', '/node/A/', '/node/a/extra/', '/node/' + 'a'.repeat(49) + '/', '/nodes/a/', '/node/a/?x=1', 'https://example.test/node/a/']) {
    assert.throws(() => normalizeEntryBasePath(value), /ENTRY_BASE_PATH/);
  }
  assert.equal(stripEntryPath('/node/a/api/me', '/node/a/'), '/api/me');
  assert.equal(stripEntryPath('/node/a/', '/node/a/'), '/');
  assert.equal(stripEntryPath('/node/ab/api/me', '/node/a/'), null);
  assert.equal(stripEntryPath('/api/me', '/node/a/'), null);
  assert.equal(stripEntryPath('/api/me', '/'), '/api/me');
});

test('node cookies use node-scoped names and entry-scoped paths', () => {
  const a = { entryBasePath: '/node/a/', nodeId: 'a'.repeat(32), secureCookies: true, sessionMs: 10000 };
  const b = { entryBasePath: '/node/b/', nodeId: 'b'.repeat(32), secureCookies: true, sessionMs: 10000 };
  const first = sessionCookie('token-a', a), second = sessionCookie('token-b', b);
  assert.match(first, /^coc_session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=token-a; Path=\/node\/a\/; HttpOnly; SameSite=Strict/);
  assert.match(second, /^coc_session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=token-b; Path=\/node\/b\/; HttpOnly; SameSite=Strict/);
  assert(!first.includes(a.nodeId === b.nodeId ? '__unexpected__' : b.nodeId));
  assert.equal(sessionCookie('', a, true).includes('Max-Age=0'), true);
});

test('a prefixed panel strips only its exact entry and emits prefixed assets and redirects', async t => {
  const nodeId = 'a'.repeat(32), app = await fixture({ nodeId, entryBasePath: '/node/a/' });
  t.after(() => app.close());

  assert.equal((await app.rawRequest('/')).status, 404);
  assert.equal((await app.rawRequest('/api/me')).status, 404);
  assert.equal((await app.rawRequest('/node/ab/api/me')).status, 404);
  const redirect = await app.rawRequest('/node/a?viewer=1');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/node/a/?viewer=1');

  const page = await app.rawRequest('/node/a/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<meta name="entry-base-path" content="\/node\/a\/">/);
  assert.match(html, /name="node-id" content="a{32}"/);
  assert.match(html, /href="\/node\/a\/styles\.css\?ui=[a-f0-9]{24}"/);
  assert.match(html, /src="\/node\/a\/app\.js\?ui=[a-f0-9]{24}"/);
  assert.match(html, /"\/terminal\/terminal\.js":"\/node\/a\/terminal\/terminal\.js\?ui=[a-f0-9]{24}"/);
  assert(!html.includes('href="/styles.css'));

  const manifest = await (await app.rawRequest('/node/a/manifest.webmanifest')).json();
  assert.equal(manifest.id, '/node/a/');
  assert.equal(manifest.start_url, '/node/a/');
  assert.equal(manifest.scope, '/node/a/');
  assert.equal(manifest.icons[0].src, '/node/a/icon.svg');
  const worker = await (await app.rawRequest('/node/a/sw.js')).text();
  assert.match(worker, /const BASE = '\/node\/a\/'/);
  assert.match(worker, /'entry-path\.js'/);
  assert(!worker.includes('__ENTRY_BASE_PATH__'));
  assert(!worker.includes('__UI_REVISION__'));

  await app.login();
  assert.equal((await app.request('/api/me')).status, 200);
  assert.equal((await app.rawRequest('/api/me')).status, 404);
});

test('prefixed WebSocket authentication uses the stripped internal route', async t => {
  const nodeId = 'a'.repeat(32), app = await fixture({ mode: 'terminal', nodeId, entryBasePath: '/node/a/', seamless: true });
  t.after(() => app.close());
  await app.login(); await app.claim();
  const target = (await app.controls.listTerminals()).terminals[0];

  const wsURL = path => {
    const url = new URL(path, app.bindingOrigin.replace('http:', 'ws:'));
    for (const [key, value] of Object.entries({ viewer: app.viewer, streamId: 'd'.repeat(32), mode: 'terminal', terminalId: target.id, terminalToken: target.token })) url.searchParams.set(key, value);
    return url;
  };
  const outside = await new Promise(resolve => {
    const ws = new WebSocket(wsURL('/session/connect'), { origin: app.config.origin, headers: { cookie: app.cookie } });
    ws.on('error', () => {}); ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
  });
  assert.equal(outside, 404);
  assert.equal(app.terminalConnections, 0);

  const ws = new WebSocket(wsURL('/node/a/session/connect'), { origin: app.config.origin, headers: { cookie: app.cookie } });
  t.after(() => ws.terminate());
  const records = []; ws.on('message', bytes => records.push(JSON.parse(bytes)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', csrf: app.csrf }));
  for (let index = 0; index < 100 && !records.length; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(records[0].type, 'welcome');
});
