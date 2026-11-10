// Real HTTP/WSS and private panel ingress. Only Worker/DO transport adapters and
// the desktop/terminal upstream use fixture implementations; CF DNS is untouched.
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { gatewayFixture } from './gateway-fixture.mjs';
import { fixture } from './fixture.mjs';
import { GATEWAY_PREFIX } from '../gateway/protocol.mjs';

export async function gatewayHTTPFixture({ webrtc = false, origin: publicOrigin } = {}) {
  let gateway;
  const peers = new Set(), nodes = [], servers = [], netSockets = new Set();
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 262144 });
  const forward = async request => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fetch(request);
    const headers = Object.fromEntries([...request.headers].filter(([key]) => !['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'].includes(key)));
    const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim()) || [];
    return new Promise((resolve, reject) => {
      const remote = new WebSocket(request.url.replace(/^http/, 'ws'), protocols, { headers, perMessageDeflate: false, handshakeTimeout: 5000 }); peers.add(remote);
      remote.on('close', () => peers.delete(remote)); remote.on('error', reject);
      remote.once('open', () => resolve({ status: 101, webSocket: remote }));
      remote.once('unexpected-response', (_req, response) => { response.resume(); remote.terminate(); resolve(new Response('', { status: response.statusCode })); });
    });
  };
  const main = http.createServer(async (req, res) => {
    try {
      const request = new Request(gateway.origin + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half' });
      const response = await gateway.worker.fetch(request, gateway.env); res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  }); main.maxConnections = 32; main.on('connection', socket => { netSockets.add(socket); socket.on('close', () => netSockets.delete(socket)); });
  main.on('upgrade', async (req, socket, head) => {
    try {
      const response = await gateway.worker.fetch(new Request(gateway.origin + req.url, { headers: req.headers }), gateway.env);
      if (response.status !== 101) { socket.end(`HTTP/1.1 ${response.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
      const remote = response.webSocket;
      wsServer.handleUpgrade(req, socket, head, client => {
        peers.add(client); client.on('message', (bytes, binary) => { if (remote.readyState === WebSocket.OPEN) remote.send(bytes, { binary }); });
        remote.on('message', (bytes, binary) => { if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary }); });
        client.on('error', () => remote.terminate()); remote.on('error', () => client.terminate()); client.on('close', () => { peers.delete(client); remote.close(); }); remote.on('close', () => client.close());
      });
    } catch { socket.destroy(); }
  });
  main.listen(0, '127.0.0.1'); await once(main, 'listening'); servers.push(main);
  const origin = publicOrigin || 'http://127.0.0.1:' + main.address().port, assets = {};
  for (const [name, type] of [['index.html', 'text/html'], ['gateway.js', 'text/javascript'], ['gateway.css', 'text/css']]) assets[GATEWAY_PREFIX + (name === 'index.html' ? '' : name)] = { body: await readFile(new URL('../gateway/' + name, import.meta.url), 'utf8'), type };
  gateway = await gatewayFixture({ origin, backendZone: 'localhost', request: forward, assets }); await gateway.login(); const code = await gateway.code();
  async function add(number) {
    const id = number.toString(16).padStart(32, '0'), secret = number.toString(16).padStart(64, '0');
    const connection = { version: 1, origin, backendOrigin: '', nodeId: id, secret, name: '节点 ' + number, registeredAt: 0 };
    const app = await fixture({ mode: 'terminal', seamless: true, webrtc, nodeId: id, sharedEntry: true, gatewayNode: connection, publicOrigin: origin }); nodes.push(app);
    app.backendOnline = true;
    const backend = http.createServer((req, res) => {
      if (!app.backendOnline) { res.writeHead(503); return res.end(); }
      const upstream = http.request({ socketPath: app.tunnelSocket, method: req.method, path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
    }); backend.maxConnections = 32; backend.on('connection', socket => { netSockets.add(socket); socket.on('close', () => netSockets.delete(socket)); });
    backend.on('upgrade', (req, socket, head) => {
      if (!app.backendOnline) { socket.end('HTTP/1.1 503 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      const upstream = http.request({ socketPath: app.tunnelSocket, method: req.method, path: req.url, headers: req.headers });
      upstream.on('upgrade', (response, remote, received) => {
        netSockets.add(remote); remote.on('close', () => netSockets.delete(remote));
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
        if (received.length) socket.write(received); if (head.length) remote.write(head); remote.pipe(socket).pipe(remote); socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      });
      upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
      upstream.on('error', () => socket.destroy()); upstream.end();
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); servers.push(backend);
    const backendOrigin = 'http://127.0.0.1:' + backend.address().port; connection.backendOrigin = backendOrigin;
    const response = await gateway.register({ id, name: connection.name, backendOrigin, mode: 'terminal' }, secret, code.key);
    if (response.status !== 200) throw Error('real fixture node enrollment failed: ' + await response.text());
    app.gatewayEntry = { id, name: connection.name, backendOrigin, secret }; return app;
  }
  return { ...gateway, origin, add, nodes, async close() {
    for (const socket of peers) socket.terminate(); for (const socket of netSockets) socket.destroy(); wsServer.close();
    for (const server of servers.reverse()) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const app of nodes) await app.close();
  } };
}
