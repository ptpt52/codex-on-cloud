const MAX_BODY = 16 * 1024;

function origin(value, label) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/api/turn-credentials') throw Error(label + ' 无效');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw Error(label + ' 必须使用 HTTPS');
  return url.origin + url.pathname;
}

function iceURL(value) {
  if (typeof value !== 'string' || value.length > 256 || /[@\s]/.test(value)) return false;
  const match = /^(stun|turn|turns):(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):([0-9]{1,5})(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  return match[1] === 'stun' ? !match[4] : match[1] !== 'turns' || match[4] === 'tcp';
}

export function validateTurnResponse(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60 * 60 * 1000 + 60_000 || !Number.isSafeInteger(value.ttlMs) || value.ttlMs < 60_000 || value.ttlMs > 60 * 60 * 1000 || !Array.isArray(value.iceServers) || value.iceServers.length < 1 || value.iceServers.length > 4) throw Error('TURN 响应无效');
  return {
    expiresAt: value.expiresAt,
    iceServers: value.iceServers.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('TURN ICE 配置无效');
      const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
      if (urls.length < 1 || urls.length > 4 || !urls.every(iceURL)) throw Error('TURN ICE 地址无效');
      const turn = urls.some(url => /^(?:turn|turns):/.test(url));
      if (!turn) return { urls };
      if (typeof item.username !== 'string' || !item.username || item.username.length > 128 || typeof item.credential !== 'string' || !item.credential || item.credential.length > 128) throw Error('TURN 临时凭据无效');
      return { urls, username: item.username, credential: item.credential };
    }),
  };
}

export async function requestTurnCredentials({ endpoint, node, request = fetch, now = Date.now() } = {}) {
  const url = origin(endpoint, 'TURN endpoint');
  if (!node || typeof node.credential !== 'string' || typeof node.slug !== 'string' || typeof node.nodeId !== 'string') throw Error('节点 TURN 身份无效');
  const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ slug: node.slug, nodeId: node.nodeId, credential: node.credential }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  const reader = response.body?.getReader(), chunks = []; let size = 0;
  if (reader) {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BODY) { await reader.cancel(); throw Error('TURN 响应超过大小上限'); } chunks.push(value); }
  } else chunks.push(Buffer.from(await response.arrayBuffer()));
  let value;
  try { value = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')); } catch { throw Error('TURN 响应格式无效'); }
  if (!response.ok) throw Object.assign(Error(value.error || 'TURN 凭据暂不可用'), { status: response.status });
  return validateTurnResponse(value, now);
}
