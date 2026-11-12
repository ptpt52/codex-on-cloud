import { GATEWAY_PREFIX, GATEWAY_LIMITS, gatewayConfig, gatewayNode, gatewaySecret, gatewayDigest, gatewayProxyHeaders, gatewayJSON } from './protocol.mjs';

export function createGateway({ config: source, assets = {}, request: upstream = fetch }) {
  const config = gatewayConfig(source);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ...(new URL(config.origin).protocol === 'https:' ? { 'strict-transport-security': 'max-age=31536000' } : {}) };
  const reply = (status, body, type = 'application/json; charset=utf-8', extra = {}) => new Response(body && (Object.getPrototypeOf(body) === Object.prototype || Array.isArray(body)) ? JSON.stringify(body) : body, { status, headers: { ...headers, 'content-type': type, ...extra } });
  const error = (status, message, outcome = 'rejected') => reply(status, { error: message, outcome });
  async function boundedBody(request) {
    if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw Object.assign(Error('请使用 JSON 请求'), { status: 415 });
    let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 5000); });
    const reader = request.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) {
        const item = await Promise.race([reader.read(), timeout]); if (item.done) break;
        size += item.value.byteLength; if (size > GATEWAY_LIMITS.body) throw Object.assign(Error('请求超过 8 KiB'), { status: 413 }); chunks.push(item.value);
      }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
    } catch (failure) { if (failure.status) throw failure; throw Object.assign(Error('读取请求超时'), { status: 408 }); }
    finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
  }
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== config.origin || request.headers.has('host') && request.headers.get('host').toLowerCase() !== new URL(config.origin).host) return error(400, '网关地址不匹配');
    if (request.headers.has('x-codex-gateway-hop')) return error(508, '检测到网关转发循环');
    if (url.pathname === '/__nodes') return reply(308, '', 'text/plain', { location: GATEWAY_PREFIX });
    if (!env.GATEWAY_REGISTRY) return error(503, '网关存储尚未配置');
    const stub = env.GATEWAY_REGISTRY.get(env.GATEWAY_REGISTRY.idFromName('gateway-v1'));
    if (url.pathname.startsWith(GATEWAY_PREFIX)) {
      const path = url.pathname.slice(GATEWAY_PREFIX.length - 1);
      if (path.startsWith('/api/')) {
        if (!/^\/api\/(?:login|logout|nodes(?:\/[a-f0-9]{32})?|node-status|switch|probe|register|codes(?:\/[a-f0-9]{32})?)$/.test(path)) return error(404, '接口不存在');
        if (!['GET', 'POST', 'DELETE'].includes(request.method)) return error(405, '请求方法不支持');
        if (request.method !== 'GET' && request.headers.get('origin') !== config.origin) return error(403, '请求来源无效');
        let body;
        try { if (request.method !== 'GET') body = await boundedBody(request); }
        catch (failure) { return error(failure.status || 400, failure.message); }
        const forwarded = new Headers({ 'content-type': 'application/json', cookie: request.headers.get('cookie') || '', 'x-csrf-token': request.headers.get('x-csrf-token') || '',
          'x-gateway-client': (await gatewayDigest(request.headers.get('cf-connecting-ip') || 'unknown')).slice(0, 32) });
        try {
          const result = await stub.fetch(new Request('https://registry.internal' + path + url.search, { method: request.method, headers: forwarded, body }));
          return reply(result.status, result.body, 'application/json; charset=utf-8', result.headers.has('set-cookie') ? { 'set-cookie': result.headers.get('set-cookie') } : {});
        } catch { return error(503, '控制请求结果未知，请刷新状态核对；不会自动重试', request.method === 'GET' ? 'rejected' : 'unknown'); }
      }
      if (!['GET', 'HEAD'].includes(request.method)) return error(405, '请求方法不支持');
      const asset = assets[url.pathname]; return asset ? reply(200, request.method === 'HEAD' ? null : asset.body, asset.type) : error(404, '页面不存在');
    }
    let node;
    const pinned = /^\/forward\/(?:agent|helper|resume|data|transport)$/.test(url.pathname) && request.headers.get('x-codex-forward-node');
    try {
      if (pinned && (!/^[a-f0-9]{32}$/.test(pinned) || !/^Bearer (?:[a-f0-9]{32}\.)?[A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') || ''))) return error(400, '助手节点身份无效');
      const result = await stub.fetch(new Request('https://registry.internal/route' + (pinned ? '?node=' + pinned : '')));
      if (!result.ok) throw Error(); node = await gatewayJSON(result, 2048);
      // During a deferred DO update an older registry may ignore ?node and
      // return the browser default. Never forward a pinned request there.
      if (pinned && node?.id !== pinned) throw Error();
      if (node) { const parsed = gatewayNode({ id: node.id, name: node.name, backendOrigin: node.backendOrigin, mode: node.mode }, config); node = { ...parsed, secret: node.secret }; }
    } catch { return error(503, '节点路由暂不可用'); }
    if (!node) return !pinned && request.method === 'GET' && !request.headers.has('upgrade') ? reply(303, '', 'text/plain', { location: GATEWAY_PREFIX }) : error(503, pinned ? '助手授权节点不可用，请检查该节点状态' : '尚未选择入口节点');
    if (!gatewaySecret(node.secret)) return error(503, '节点路由配置无效');
    const destination = new URL(request.url), backend = new URL(node.backendOrigin); destination.protocol = backend.protocol; destination.host = backend.host;
    const forwarded = new Headers(request.headers);
    for (const name of [...forwarded.keys()]) if (name.startsWith('x-codex-gateway-')) forwarded.delete(name);
    for (const name of ['host', 'connection', 'proxy-authorization', 'proxy-authenticate']) forwarded.delete(name);
    forwarded.set('cookie', (request.headers.get('cookie') || '').split(';').map(item => item.trim()).filter(item => item && !item.startsWith('coc_gateway_session=') && !item.startsWith('coc_session=') && (!item.startsWith('coc_session_') || item.startsWith('coc_session_' + node.id + '='))).join('; '));
    for (const [name, value] of Object.entries(gatewayProxyHeaders(node, config.origin))) forwarded.set(name, value);
    forwarded.set('x-codex-gateway-client', request.headers.get('cf-connecting-ip') || '');
    try {
      const result = await upstream(new Request(destination, { method: request.method, headers: forwarded, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', duplex: 'half' }));
      // A 101 Response retains its WebSocket object and streams frames directly.
      if (result.status === 101) return result;
      if (result.headers.get('x-codex-node-id') !== node.id) { await result.body?.cancel().catch(() => {}); throw Error('unexpected upstream identity'); }
      return result;
    } catch {
      if (request.method === 'GET' && url.pathname === '/' && !request.headers.has('upgrade')) return reply(303, '', 'text/plain', { location: GATEWAY_PREFIX + '?unavailable=1' });
      return error(502, '目标节点响应未确认，请核对状态；请求不会重发或转给其他节点', 'unknown');
    }
  } };
}
