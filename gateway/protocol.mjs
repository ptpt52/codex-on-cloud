export const GATEWAY_PREFIX = '/__nodes/';
export const GATEWAY_LIMITS = Object.freeze({ page: 16, bytes: 131072, sessions: 8, codes: 16, failures: 64, body: 8192, probeMs: 4000, pendingMs: 15000 });
export const gatewayHex = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const gatewaySecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const gatewayLocal = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function gatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 256 || value.trim() !== value) throw Error('网关地址无效');
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && gatewayLocal(url.hostname))) throw Error('需要 HTTPS 根地址；仅本地测试允许 HTTP');
  if (!gatewayLocal(url.hostname) && (!/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.') || url.port)) throw Error('需要有效的 HTTPS 域名');
  return url.origin;
}
export function gatewayConfig(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'origin', 'backendZone'].includes(key))) throw Error('网关配置无效');
  const origin = gatewayOrigin(value.origin), zone = value.backendZone;
  if (typeof zone !== 'string' || zone.length > 253 || !/^[a-z0-9.-]+$/.test(zone) || zone.startsWith('.') || zone.endsWith('.') || zone.includes('..')) throw Error('需要有效的后端域名区域');
  return { version: 1, origin, backendZone: zone };
}
export function gatewayBackend(value, config) {
  const origin = gatewayOrigin(value), url = new URL(origin), gateway = new URL(config.origin);
  if (origin === config.origin || (gatewayLocal(url.hostname) ? !gatewayLocal(gateway.hostname) : !(url.hostname === config.backendZone || url.hostname.endsWith('.' + config.backendZone)))) throw Error('节点地址不属于允许的后端区域，或指向网关自身');
  return origin;
}
export function gatewayNode(value, config) {
  if (!value || Object.keys(value).some(key => !['id', 'name', 'backendOrigin', 'mode'].includes(key)) || !gatewayHex(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 48 || /[\u0000-\u001f\u007f]/.test(value.name) || !['desktop', 'terminal'].includes(value.mode)) throw Error('节点身份、名称或模式无效');
  return { id: value.id, name: value.name.trim(), backendOrigin: gatewayBackend(value.backendOrigin, config), mode: value.mode };
}
export const gatewayDigest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const gatewayRandom = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export function gatewayEqual(a, b) {
  if (!gatewaySecret(a) || !gatewaySecret(b)) return false;
  let difference = 0; for (let index = 0; index < 64; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index); return difference === 0;
}
export const gatewayError = (status, message, code) => Object.assign(Error(message), { status, code });
export function gatewayCookie(token, origin, expired = false) {
  return `coc_gateway_session=${token}; Path=${GATEWAY_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : 604800}${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
}
export function gatewaySessionCookie(header = '') {
  return header.split(';').map(value => value.trim()).find(value => value.startsWith('coc_gateway_session='))?.slice(20) || '';
}
export function gatewayProxyHeaders(node, origin) {
  return { 'x-codex-gateway-secret': node.secret, 'x-codex-gateway-origin': origin, 'x-codex-gateway-node': node.id, 'x-codex-gateway-hop': '1' };
}
export async function gatewayJSON(response, limit = 4096) {
  if (!response.body) throw Error('响应为空');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > limit) throw Error('响应超过大小限制'); parts.push(item.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Error('响应 JSON 无效'); }
}
export async function gatewayProbe(node, origin, request = fetch) {
  try {
    const response = await request(node.backendOrigin + '/readyz', { headers: gatewayProxyHeaders(node, origin), redirect: 'manual', signal: AbortSignal.timeout(GATEWAY_LIMITS.probeMs), cache: 'no-store' });
    const value = await gatewayJSON(response);
    return response.status === 200 && value.ok === true && value.host === true && value.files === true && value.nodeId === node.id;
  } catch { return false; }
}
export function encodeGatewayCode(origin, key) {
  if (!gatewaySecret(key)) throw Error('接入授权码无效');
  return 'cog1.' + btoa(JSON.stringify({ origin: gatewayOrigin(origin), key })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function decodeGatewayCode(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^cog1\.[A-Za-z0-9_-]+$/.test(value.trim())) throw Error('请使用节点网关生成的完整接入码');
  let code; try { code = JSON.parse(atob(value.trim().slice(5).replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw Error('接入码格式无效'); }
  if (!code || Object.keys(code).length !== 2 || !gatewaySecret(code.key)) throw Error('接入码格式无效');
  return { origin: gatewayOrigin(code.origin), key: code.key };
}
