import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from '../panel/server.mjs';


export async function fixture({ port = 0, dataDir, password = 'test_password_very_long_123', sessionMs, rfb = false } = {}) {
  const directory = dataDir || await mkdtemp(join(tmpdir(), 'codex-cloud-test-'));
  const received = [];
  const files = new Map();
  const upstream = http.createServer(async (req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ready: true, version: '模拟桌面 · 仅供测试' })); }
    if (req.url === '/files') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ files: [...files].map(([name, content]) => ({ name, size: content.length, modified: 1 })) })); }
    if (req.url.startsWith('/files/')) {
      const name = decodeURIComponent(req.url.slice('/files/'.length));
      if (req.method === 'PUT') { files.set(name, body); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, name })); }
      if (!files.has(name)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: '文件不存在' })); }
      res.setHeader('content-length', files.get(name).length); return res.end(files.get(name));
    }
    if (['/paste', '/key', '/terminal'].includes(req.url)) {
      received.at(-1).body = JSON.parse(body);
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end();
  });
  const clients = new Set();
  const vnc = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    if (!rfb) return socket.on('data', bytes => { received.push({ method: 'VNC', bytes }); socket.write(bytes); });
    // Minimal RFB fixture; browsers still use the real noVNC client and Unix socket bridge.
    socket.write('RFB 003.008\n');
    let phase = 0, pending = Buffer.alloc(0), sent = false;
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      if (phase === 0 && pending.length >= 12) { pending = pending.subarray(12); socket.write(Buffer.from([1, 1])); phase = 1; }
      if (phase === 1 && pending.length >= 1) { pending = pending.subarray(1); socket.write(Buffer.alloc(4)); phase = 2; }
      if (phase === 2 && pending.length >= 1) {
        pending = pending.subarray(1); phase = 3;
        const name = Buffer.from('SIMULATED DESKTOP - TEST ONLY');
        const header = Buffer.alloc(24);
        header.writeUInt16BE(1600, 0); header.writeUInt16BE(1600, 2);
        header.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
        header.writeUInt32BE(name.length, 20); socket.write(Buffer.concat([header, name]));
      } else if (phase === 3 && !sent) {
        sent = true;
        const frame = Buffer.alloc(16 + 1600 * 1600 * 4);
        frame.writeUInt16BE(1, 2); frame.writeUInt16BE(1600, 8); frame.writeUInt16BE(1600, 10);
        for (let i = 16; i < frame.length; i += 4) frame.set([34, 48, 29, 0], i);
        socket.write(frame);
      }
      if (phase === 3) pending = Buffer.alloc(0);
    });
  });
  const vncSocket = join(directory, 'vnc.sock');
  vnc.listen(vncSocket); await once(vnc, 'listening');
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const config = {
    host: '127.0.0.1', port, origin: '', secureCookies: false, hosts: new Set(),
    dataDir: directory, username: 'admin', password,
    agentSecret: 'agent_secret_for_test_123', vncSocket, agentUrl: upstreamUrl,
    transferDir: '/test-workspace/transfer', sessionMs: sessionMs || 604800000,
  };
  const panel = await createPanel(config);
  panel.server.listen(port, '127.0.0.1'); await once(panel.server, 'listening');
  config.origin = `http://127.0.0.1:${panel.server.address().port}`;
  config.hosts.add(new URL(config.origin).host);
  let cookie = '', csrf = '';
  const viewer = '11111111-1111-4111-8111-111111111111';
  async function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
    return fetch(config.origin + path, {
      method, headers: { origin: config.origin, cookie, 'x-csrf-token': csrf, 'x-viewer-id': viewer, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual',
    });
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { username: 'admin', password } });
    cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json(); csrf = data.csrf;
    return { cookie, csrf };
  }
  async function claim(id = viewer) { return request('/api/desktop/claim', { method: 'POST', body: { viewer: id } }); }
  return {
    panel, config, directory, received, files, viewer, request, login, claim,
    get cookie() { return cookie; }, get csrf() { return csrf; },
    async close({ preserve = false } = {}) {
      await panel.close();
      for (const client of clients) client.destroy();
      await new Promise(resolve => vnc.close(resolve));
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
      if (!preserve && !dataDir) await rm(directory, { recursive: true, force: true });
    },
  };
}
