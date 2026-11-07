import { parseNodeDirectory } from '../panel/public/node-directory.js';
import { portalDigest } from './registry.mjs';

export function createPortal({ directory: source, assets }) {
  const directory = parseNodeDirectory(source);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const reply = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => new Response(body, { status, headers: { ...headers, 'content-type': type, ...extra } });
  return { async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (url.origin !== directory.portalOrigin || (request.headers.has('host') && request.headers.get('host').toLowerCase() !== new URL(directory.portalOrigin).host)) return reply(400, '门户地址不匹配');
    if (path.startsWith('/api/')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return reply(405, '请求方法不支持');
      if (request.method !== 'GET' && request.headers.get('origin') !== directory.portalOrigin) return reply(403, '请求来源无效');
      let body;
      if (request.method !== 'GET') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, '请使用 JSON 请求');
        if (!request.body) return reply(400, '请求内容为空');
        const reader = request.body.getReader(), chunks = []; let length = 0;
        let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 5000); });
        try {
          while (true) { const { done, value } = await Promise.race([reader.read(), timeout]); if (done) break; length += value.length; if (length > 32768) return reply(413, '请求超过 32 KiB'); chunks.push(value); }
          const bytes = new Uint8Array(length); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; } body = bytes;
        } catch { return reply(408, '读取请求超时'); }
        finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
      }
      if (!env.NODE_REGISTRY) return reply(503, '门户存储尚未配置');
      const forwarded = new Headers({ 'content-type': 'application/json', cookie: request.headers.get('cookie') || '', 'x-csrf-token': request.headers.get('x-csrf-token') || '', authorization: request.headers.get('authorization') || '' });
      forwarded.set('x-portal-client', (await portalDigest(request.headers.get('cf-connecting-ip') || 'unknown')).slice(0, 32));
      try {
        const stub = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName('nodes-v1'));
        const result = await stub.fetch(new Request('https://registry.internal' + path, { method: request.method, headers: forwarded, body }));
        return reply(result.status, result.body, 'application/json; charset=utf-8', result.headers.has('set-cookie') ? { 'set-cookie': result.headers.get('set-cookie') } : {});
      } catch { return reply(503, JSON.stringify({ error: '门户暂不可用，请稍后重试' }), 'application/json; charset=utf-8'); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply(405, '请求方法不支持');
    const asset = assets[path];
    return asset ? reply(200, request.method === 'HEAD' ? null : asset.body, asset.type) : reply(404, '页面不存在');
  } };
}
