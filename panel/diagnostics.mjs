import { isIP } from 'node:net';

// A single in-flight request/cache entry, a fixed loopback endpoint, and a bounded response.
export function createTunnelDiagnostics(endpoint) {
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/diag/tunnel' || url.search || url.hash) throw new Error('Tunnel 诊断只能读取固定的回环接口');
  }
  let cache;
  return async function readTunnel() {
    if (cache && Date.now() - cache.at < 3000) return cache.promise;
    const promise = (async () => {
      try {
        if (!endpoint) throw new Error('not configured');
        const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(1500) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('unavailable'); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 32 * 1024) throw new Error('response too large');
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // cloudflared omits connections entirely when its active connection list is empty.
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        const list = data?.connections ?? (uuid.test(data?.tunnelID) && uuid.test(data?.connectorID) ? [] : null);
        if (!Array.isArray(list) || list.length > 64) throw new Error('invalid response');
        let connections = 0, ipv4 = 0, ipv6 = 0;
        for (const item of list) {
          if (typeof item?.isConnected !== 'boolean') throw new Error('invalid connection');
          if (!item.isConnected) continue;
          connections++;
          const family = typeof item.edgeAddress === 'string' ? isIP(item.edgeAddress) : 0;
          if (!family) throw new Error('invalid edge address');
          if (family === 4) ipv4++;
          if (family === 6) ipv6++;
        }
        return { available: true, connections, ipv4, ipv6, checkedAt: Date.now() };
      } catch {
        return { available: false, connections: null, ipv4: null, ipv6: null, checkedAt: Date.now() };
      }
    })();
    cache = { at: Date.now(), promise };
    return promise;
  };
}
