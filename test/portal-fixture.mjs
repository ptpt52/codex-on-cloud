import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PortalRegistry, portalDigest } from '../portal/registry.mjs';
import { createPortal } from '../portal/worker.mjs';

export async function portalFixture({ nodes = [], origin, listen = false } = {}) {
  const password = 'test-only-portal-password-' + 'a'.repeat(40), env = { PORTAL_PASSWORD_HASH: await portalDigest(password) };
  let handler, server, clock = Date.now();
  if (listen) {
    server = http.createServer(async (req, res) => {
      try {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 32768) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
        const response = await handler.fetch(new Request(origin + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  }
  origin ||= 'https://portal.example.com';
  const initial = { version: 1, portalOrigin: origin, nodes };
  const storage = { value: undefined, chain: Promise.resolve(), active: 0,
    transaction(fn) {
      if (++this.active > 64) throw Error('test transaction bound');
      const operation = this.chain.then(async () => { let draft = structuredClone(this.value); const result = await fn({ get: async () => structuredClone(draft), put: async (_, value) => { draft = structuredClone(value); } }); this.value = draft; return result; });
      this.chain = operation.catch(() => {}); return operation.finally(() => { this.active--; });
    },
  };
  const registry = new PortalRegistry({ storage }, env, initial); registry.now = () => clock;
  env.NODE_REGISTRY = { idFromName: name => name, get: () => registry };
  const assets = {};
  for (const [path, name, type] of [['/', 'index.html', 'text/html'], ['/portal.js', 'portal.js', 'text/javascript'], ['/portal.css', 'portal.css', 'text/css'], ['/node-directory.js', '../panel/public/node-directory.js', 'text/javascript']]) assets[path] = { body: await readFile(new URL('../portal/' + name, import.meta.url), 'utf8'), type };
  handler = createPortal({ directory: initial, assets });
  let cookie = '', csrf = '';
  const request = (path, { method = 'GET', body, headers = {} } = {}) => handler.fetch(new Request(origin + path, { method, headers: { cookie, origin, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { origin, password, env, storage, registry, worker: handler, assets, request,
    advance(ms) { clock += ms; },
    async login() { const response = await request('/api/login', { method: 'POST', body: { password } }); if (response.status !== 200) throw Error('fixture portal login failed'); cookie = response.headers.get('set-cookie').split(';')[0]; const value = await (await request('/api/nodes')).json(); csrf = value.csrf; return value; },
    async code(name = '测试接入授权') { const response = await request('/api/authorization-codes', { method: 'POST', body: { name } }); if (response.status !== 200) throw Error('fixture code failed'); return response.json(); },
    fetch: (url, init) => handler.fetch(new Request(url, init), env),
    close: async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}
