// Direct runtime tests: no browser enrollment API, session roles or desktop.
// The request helper is an in-process driver, never a production HTTP route.
import http from 'node:http';
import { once } from 'node:events';
import { createForwarding } from '../../panel/forward.mjs';
export async function fixture(options = {}) {
  let revoked = '', closed = false;
  const createdAt = Date.now(), config = { forwardPorts: [22], ...options, origin: '', port: 0 };
  const runtime = createForwarding(config), server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
  const deny = (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== new URL(config.origin).host || req.headers.origin !== config.origin) return deny(socket, 403);
    runtime.upgrade(req, socket, head, new URL(req.url, config.origin).pathname);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); config.origin = 'http://127.0.0.1:' + server.address().port; config.port = server.address().port;
  const invalid = () => revoked || options.sessionMs && Date.now() >= createdAt + options.sessionMs ? revoked || 'authorization_expired' : '';
  async function request(action, { method = 'GET', body } = {}) {
    try {
      let value;
      if (action === 'mapping' && method === 'POST') value = runtime.create(body, 'runtime-test', invalid);
      else if (action === 'mapping') value = runtime.list();
      else if (action === 'stop') value = runtime.stop(body);
      else if (action === 'hints') value = runtime.updateHints(body);
      else if (action === 'revoke') { revoked = 'authorization_revoked'; runtime.refresh(); value = { ok: true }; }
      else throw Object.assign(Error('test driver action unknown'), { status: 404 });
      return Response.json(value);
    } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
  }
  async function close() { if (closed) return; closed = true; await runtime.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  return { config, request, runtime, panel: { server, close }, close, inputCalls: [], terminalInputs: [], managementStats: { restarts: 0 } };
}
