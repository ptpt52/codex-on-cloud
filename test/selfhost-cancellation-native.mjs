// Actual Caddy/TLS and the panel's transfer quota. The node and route auth are
// isolated HTTP fixtures; this does not exercise frps or a production desktop.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { caddyConfig } from '../selfhost/server-config.mjs';
import { createFileTransfers } from '../panel/file-transfers.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition, message) {
  const deadline = performance.now() + 3000;
  while (!condition() && performance.now() < deadline) await delay(10);
  assert(condition(), message);
}

export async function verifyNodeCancellation({ binary, directory, tlsDir, ca }) {
  const root = join(directory, 'node-cancellation'); await mkdir(root);
  const requests = new Set(), peers = new Set(), transfers = createFileTransfers();
  const ws = new WebSocketServer({ noServer: true });
  let upstream, auth, child, client, entered = 0, released = 0;
  try {
    const reservation = http.createServer(), edgePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
    auth = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
    const internalPort = await listen(auth);
    upstream = http.createServer((req, res) => {
      if (req.url === '/healthz') return res.end('ok');
      let transfer;
      try { transfer = transfers.begin(req, res, () => true); }
      catch (error) { res.writeHead(error.status || 500); res.end(); return; }
      if (req.url.endsWith('/probe')) { transfer.finish(); return res.end('available'); }
      entered++;
      transfer.signal.addEventListener('abort', () => { released++; transfer.finish(); res.destroy(); }, { once: true });
      if (req.url.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); }
      if (req.url.endsWith('/stream')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(1024, 97)); }
    });
    upstream.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, peer => {
      peers.add(peer); peer.once('close', () => peers.delete(peer)); peer.on('error', () => {});
      peer.on('message', bytes => peer.send(bytes));
    }));
    const upstreamPort = await listen(upstream), file = join(root, 'Caddyfile');
    await writeFile(file, caddyConfig('desk.example.test', { tlsDirectory: tlsDir, webroot: root, centerPort: upstreamPort, internalPort, frpHttpPort: upstreamPort, redirectHttp: false }).replaceAll('https://desk.example.test', `https://127.0.0.1:${edgePort}`));
    child = spawn(binary, ['run', '--config', file, '--adapter', 'caddyfile'], { cwd: root, env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root }, stdio: 'ignore' });
    const get = (path, onResponse) => {
      let request;
      const result = new Promise((resolve, reject) => {
        request = https.get({ host: '127.0.0.1', port: edgePort, path, ca, agent: false }, response => {
          response.on('error', reject);
          if (onResponse) return onResponse(response, resolve);
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        requests.add(request); request.once('close', () => requests.delete(request)); request.on('error', reject);
        request.setTimeout(4000, () => request.destroy(Error('isolated request deadline')));
      });
      void result.catch(() => {}); return { request, result };
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if (await get('/healthz').result === 200) { ready = true; break; } } catch {}
      await delay(20);
    }
    assert(ready, 'cancellation Caddy did not start');
    const held = Array.from({ length: 4 }, (_, index) => get('/node/test/api/files/held-' + index));
    await until(() => entered === 4, 'file requests did not enter');
    assert.equal(await get('/node/test/api/probe').result, 503);
    for (const { request } of held) request.destroy();
    await Promise.allSettled(held.map(entry => entry.result));
    await until(() => released === 4, 'cancel before response headers retained the four file slots');
    assert.equal(await get('/node/test/api/probe').result, 200);

    // A first chunk must arrive before the upstream finishes. Cancellation
    // after headers must also release the slot for SSE and file streams.
    for (const path of ['events', 'stream']) {
      const stream = get('/node/test/api/' + path, (response, resolve) => response.once('data', bytes => resolve(bytes)));
      const bytes = await stream.result; assert(bytes.length > 0);
      stream.request.destroy();
      await until(() => released === entered, path + ' cancellation did not reach the node');
    }
    client = new WebSocket(`wss://127.0.0.1:${edgePort}/node/test/session/connect`, { ca, handshakeTimeout: 3000 });
    await once(client, 'open'); const echoed = once(client, 'message'); client.send('isolated-echo');
    assert.equal((await echoed)[0].toString(), 'isolated-echo');
    client.close(); await once(client, 'close'); client = undefined;
    await until(() => peers.size === 0, 'WebSocket close did not reach the node');
    console.log('✓ actual Caddy: canceled requests release all four file slots before headers; SSE/file first chunks and cancellation, plus WebSocket echo/close remain streaming');
  } finally {
    client?.terminate(); for (const peer of peers) peer.terminate(); for (const request of requests) request.destroy(); transfers.close(); ws.close();
    if (child?.exitCode === null) {
      const stopped = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM'); try { await stopped; } finally { clearTimeout(timer); }
    }
    for (const server of [auth, upstream].filter(Boolean)) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
