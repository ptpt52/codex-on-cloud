import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createPanel } from '../panel/server.mjs';

const DEMO_DESKTOP = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#1d2722;color:#d6e6d0;font:14px monospace}header{padding:13px 18px;background:#26332b;color:#aabca4;font:11px sans-serif}.terminal{margin:26px auto;max-width:850px;padding:22px;line-height:1.9;background:#152019;border:1px solid #3a4f3e;border-radius:8px}b{color:#88bb83}small{color:#849680}</style><header>Ubuntu 开发桌面 · 模拟上游，仅用于界面与代理测试</header><div class="terminal"><small>codex — /workspace</small><p><b>✳ Codex</b></p><p>你的工作空间已就绪。</p><p>在手机输入助手中粘贴指令，然后按 Enter 提交。</p><p><small>真实部署时，这里显示 KasmVNC 桌面画面。</small></p><p>› <span id="cursor">_</span></p></div><script>const p=new URLSearchParams(location.search).get('path');if(p){const w=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/'+p);w.onopen=()=>document.getElementById('cursor').textContent='已连接';}</script></html>`;

export async function fixture({ port = 0, dataDir, password = 'test_password_very_long_123', sessionMs } = {}) {
  const directory = dataDir || await mkdtemp(join(tmpdir(), 'codex-cloud-test-'));
  const received = [];
  const files = new Map();
  const upstream = http.createServer(async (req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ready: true, version: 'Codex test fixture' })); }
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
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/index.html' }); return res.end(); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('set-cookie', 'upstream_secret=must_not_escape');
    res.setHeader('www-authenticate', 'Basic realm="secret"');
    res.end(DEMO_DESKTOP);
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    received.push({ method: 'WS', url: req.url, headers: req.headers });
    wss.handleUpgrade(req, socket, head, ws => { ws.on('message', bytes => ws.send(bytes)); });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const config = {
    host: '127.0.0.1', port, origin: '', secureCookies: false, hosts: new Set(),
    dataDir: directory, username: 'admin', password, desktopPassword: 'desktop_password_for_test_123',
    agentSecret: 'agent_secret_for_test_123', desktopUrl: upstreamUrl, agentUrl: upstreamUrl,
    desktopTlsVerify: true, sessionMs: sessionMs || 604800000,
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
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
      if (!preserve && !dataDir) await rm(directory, { recursive: true, force: true });
    },
  };
}
