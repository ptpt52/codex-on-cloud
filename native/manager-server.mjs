import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function createManagerServer(secret, controls) {
  let active = 0;
  const expected = Buffer.from(`Bearer ${secret}`);
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(data)); } };
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: '本机管理接口认证失败' });
    if (active >= 4) return reply(503, { error: '本机管理接口繁忙' });
    active++;
    req.setTimeout(5000, () => req.destroy());
    try {
      if (req.method === 'GET' && req.url === '/settings') return reply(200, await controls.get());
      if (!['/settings', '/apply', '/terminal'].includes(req.url) || req.method !== 'POST') return reply(404, { error: '动作不存在' });
      if (req.headers['content-type'] !== 'application/json') return reply(415, { error: '需要 JSON 请求' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024) { const error = new Error('管理请求过大'); error.status = 413; throw error; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
      catch { const error = new Error('JSON 格式无效'); error.status = 400; throw error; }
      if (req.url === '/settings') return reply(200, controls.save(body));
      if (req.url === '/apply') return reply(202, { job: await controls.apply(body) });
      return reply(202, { job: controls.terminal(body) });
    } catch (error) { reply(error.status || 503, { error: error.status ? error.message : '本机桌面管理暂不可用' }); }
    finally { active--; }
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxHeadersCount = 32; server.maxConnections = 8;
  return server;
}
