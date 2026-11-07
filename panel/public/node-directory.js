// Public metadata only. The same validator is used by nodes, the portal and its builder.
export const NODE_DIRECTORY_LIMITS = Object.freeze({ bytes: 32768, nodes: 32, name: 48, description: 160, url: 256 });
const directoryFields = ['version', 'portalOrigin', 'nodes'];
const nodeFields = ['id', 'name', 'origin', 'description', 'mode', 'enabled'];
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function onlyFields(value, fields) { return plainObject(value) && Object.keys(value).every(key => fields.includes(key)); }
export function nodeOrigin(value) {
  if (typeof value !== 'string' || value.length > NODE_DIRECTORY_LIMITS.url || value.trim() !== value) throw Error('服务器地址需为 HTTPS 网站根地址');
  let url; try { url = new URL(value); } catch { throw Error('服务器地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin.length > NODE_DIRECTORY_LIMITS.url) throw Error('服务器地址需为 HTTPS 网站根地址；仅回环测试允许 HTTP');
  return url.origin;
}
export function encodePortalCode(origin, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw Error('授权码无效');
  const text = JSON.stringify({ origin: nodeOrigin(origin), key });
  return 'coc1.' + btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function decodePortalCode(code) {
  if (typeof code !== 'string' || code.length > 1024 || !/^coc1\.[A-Za-z0-9_-]+$/.test(code.trim())) throw Error('请粘贴门户生成的完整授权码');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(code.trim().slice(5).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)))); }
  catch { throw Error('授权码格式无效'); }
  if (!value || Object.keys(value).length !== 2 || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) throw Error('授权码格式无效');
  return { origin: nodeOrigin(value.origin), key: value.key };
}
export function parseNodeDirectory(value) {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > NODE_DIRECTORY_LIMITS.bytes) throw Error('服务器目录超过 32 KiB');
    try { value = JSON.parse(value); } catch { throw Error('服务器目录不是有效 JSON'); }
  }
  if (!onlyFields(value, directoryFields) || value.version !== 1 || !Array.isArray(value.nodes) || value.nodes.length > NODE_DIRECTORY_LIMITS.nodes) throw Error('服务器目录需为 version: 1，最多 32 个节点，且不能包含额外字段');
  const portalOrigin = nodeOrigin(value.portalOrigin), ids = new Set(), origins = new Set();
  const nodes = value.nodes.map(item => {
    if (!onlyFields(item, nodeFields) || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > NODE_DIRECTORY_LIMITS.name || /[\u0000-\u001f\u007f]/.test(item.name)) throw Error('节点 ID 或名称无效');
    const origin = nodeOrigin(item.origin), description = item.description ?? '', mode = item.mode ?? 'desktop';
    if (typeof description !== 'string' || description.length > NODE_DIRECTORY_LIMITS.description || /[\u0000-\u001f\u007f]/.test(description) || !['desktop', 'terminal'].includes(mode) || (item.enabled !== undefined && typeof item.enabled !== 'boolean')) throw Error('节点说明、模式或启用状态无效');
    if (ids.has(item.id) || origins.has(origin) || origin === portalOrigin) throw Error('节点 ID、服务器地址必须唯一，且不能指向门户本身');
    ids.add(item.id); origins.add(origin);
    return { id: item.id, name: item.name.trim(), origin, description, mode, enabled: item.enabled !== false };
  });
  const directory = { version: 1, portalOrigin, nodes };
  if (new TextEncoder().encode(JSON.stringify(directory)).length > NODE_DIRECTORY_LIMITS.bytes) throw Error('服务器目录超过 32 KiB');
  return directory;
}
export async function readNodeDirectoryResponse(response, limit = NODE_DIRECTORY_LIMITS.bytes) {
  if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw Error('服务器目录读取失败，请刷新后重试');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) throw Error('服务器目录响应超过大小限制'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
