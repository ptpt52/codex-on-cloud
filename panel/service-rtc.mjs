import http from 'node:http';
import { createRTCBridge, rtcAddress, rtcIPv6Address, rtcOffer } from './rtc.mjs';
import { rtcHints, withHintCandidates } from './rtc-hints.mjs';
import { normalizeEntryBasePath } from './entry-path.mjs';

const error = (status, message, outcome = 'rejected') => Object.assign(Error(message), { status, outcome });
export const SERVICE_ACTIONS = Object.freeze({ state: ['GET', '/api/state'], diagnostics: ['GET', '/api/diagnostics'], files: ['GET', '/api/files'],
  'forward-list': ['GET', '/api/forward'] });

// Fixed loopback requests reuse the HTTP authorization and quota checks. The
// client cannot supply a URL, credentials, headers, host, port or HTTP method.
export function localServiceRequest(port, headers, action, body, signal, entryBasePath = '/') {
  const route = SERVICE_ACTIONS[action];
  if (!Object.hasOwn(SERVICE_ACTIONS, action)) return Promise.reject(error(400, '不支持的服务操作'));
  const [method, path] = route;
  const prefix = normalizeEntryBasePath(entryBasePath).slice(0, -1);
  const data = method === 'POST' ? JSON.stringify(body) : '';
  if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(data) > 1024)) return Promise.reject(error(400, '服务参数无效或过大'));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: prefix + path, method, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 240 * 1024) res.destroy(error(503, '服务响应过大，请使用 HTTPS')); else chunks.push(chunk); });
      res.once('error', reject); res.once('end', () => {
        try { const result = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) throw error(res.statusCode, result.error || '服务操作失败', result.outcome || 'rejected');
          resolve(result);
        } catch (err) { reject(err); }
      });
    });
    req.once('error', err => reject(err.status ? err : error(502, '服务连接中断，操作结果未知，请刷新状态确认', 'unknown')));
    req.end(data);
  });
}

// At most eight peers (including closing), four per role, two per login.
// No desktop owner, VNC, terminal, shell input, action queue or persisted state.
export function createServiceRTC({ config, authorized, port, connectFiles, helperDownloads = false, turn }) {
  const entries = new Set(), pages = new Map(); let stopped = false;
  async function negotiate({ token, session, viewer, body, headers, signal }) {
    if (!config.webrtc) throw error(404, '服务端已关闭直连');
    if (stopped || !authorized(token)) throw error(401, '登录已失效');
    if (!/^[a-f0-9-]{16,64}$/.test(viewer || '') || Object.keys(body).some(key => !['type', 'sdp', 'hints'].includes(key))) throw error(400, '服务协商参数无效');
    let hints, offer;
    let ice;
    try { hints = rtcHints(body.hints); ice = await turn?.(); offer = withHintCandidates(rtcOffer(body, { ipv6: !!config.webrtcIPv6, relay: ice?.relay }), hints.browser, { ipv6: !!config.webrtcIPv6 }); }
    catch (err) { throw error(400, err.message); }
    const key = session.hash + ':' + viewer;
    if (pages.has(key)) throw error(429, '本页面服务直连仍在运行');
    const role = session.role || 'admin';
    if (entries.size >= 8 || [...entries].filter(e => e.role === role).length >= 4 || [...entries].filter(e => e.session === session.hash).length >= 2) throw error(429, '服务直连名额已满，继续使用 HTTPS');
    const controller = new AbortController(), entry = { key, role, session: session.hash, token, peer: null };
    const valid = () => !stopped && !controller.signal.aborted && !signal.aborted && pages.get(key) === entry && !!authorized(token);
    entry.close = () => {
      if (entry.closing) return entry.closing;
      entry.closing = Promise.resolve().then(() => entry.peer?.destroy()).finally(() => entries.delete(entry));
      controller.abort(); if (pages.get(key) === entry) pages.delete(key);
      return entry.closing;
    };
    entries.add(entry); pages.set(key, entry);
    signal.addEventListener('abort', () => { void entry.close(); }, { once: true });
    try {
      const address = config.webrtcAddressAuto ? rtcAddress() : config.webrtcAddress;
      const ipv6Address = config.webrtcIPv6 ? config.webrtcIPv6AddressAuto ? rtcIPv6Address(undefined, address) : config.webrtcIPv6Address : undefined;
      entry.peer = createRTCBridge({ address, ipv6Address, iceServers: ice?.iceServers || [], stunUrl: config.webrtcStunUrl, relay: ice?.relay, turnCa: config.selfhostCaBundle, serviceOnly: true, valid, closed: () => { void entry.close(); },
        ...(connectFiles ? { connectFiles: (channel, live, fail) => connectFiles(channel, live, headers, controller.signal, fail) } : {}),
        performControl: async (action, value, live) => {
          if (!valid() || !live()) throw error(401, '登录或服务连接已失效');
          if (action === 'ping') return { ready: true, filesProtocol: connectFiles ? 1 : 0, helperDownloadsProtocol: connectFiles && helperDownloads ? 1 : 0 };
          const result = await localServiceRequest(port(), headers, action, value, controller.signal, config.entryBasePath);
          if (!valid() || !live()) throw error(401, '登录或服务连接已失效');
          return result;
        } });
      const answer = withHintCandidates(await entry.peer.answer(offer), hints.server, { ipv6: !!ipv6Address });
      if (!valid()) throw error(401, '登录或协商已失效');
      return answer;
    } catch (err) { await entry.close(); throw err; }
  }
  function revalidate() { for (const entry of entries) if (!authorized(entry.token)) void entry.close(); }
  const timer = setInterval(revalidate, 1000).unref();
  return { negotiate, revalidate, async close() { stopped = true; clearInterval(timer); await Promise.allSettled([...entries].map(e => e.close())); } };
}
