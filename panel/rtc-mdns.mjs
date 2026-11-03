import multicastDNS from 'multicast-dns';
import { privateIPv4, globalIPv6 } from './rtc-network.mjs';

// Retain the ICE agent's original lookup window: on routed LANs mDNS may be
// unavailable while authenticated browser-initiated checks can still succeed.
export const MDNS_TIMEOUT = 10000;

// werift 0.26 only inspects answers[0] and leaves lookups pending after close.
// Keep one lazy multicast socket and at most eight names for this peer's life.
export function createMDNSLookup({ address, ipv6 = false, create = multicastDNS }) {
  const names = new Map();
  let socket, ended = false;
  const normalize = name => typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
  function finish(entry, error, value) {
    if (!entry.pending) return;
    entry.pending = false; clearTimeout(entry.timer); clearTimeout(entry.retry);
    if (error) entry.reject(error); else entry.resolve(value);
  }
  const handle = {
    lookup(host) {
      const name = normalize(host);
      if (ended || !/^[a-z0-9-]{1,63}\.local$/.test(name)) return Promise.reject(new Error('Invalid mDNS lookup'));
      if (names.has(name)) return names.get(name).promise;
      if (names.size >= 8) return Promise.reject(new Error('Too many mDNS names'));
      const entry = { pending: true };
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      names.set(name, entry);
      try {
        if (!socket) {
          // Receive group replies on wildcard, but join and query only the
          // selected LAN interface rather than an unrelated default interface.
          socket = create({ interface: address, bind: '0.0.0.0' });
          socket.on('error', () => handle.close());
          socket.on('response', response => {
            if (ended) return;
            const records = [...(response.answers || []).slice(0, 64), ...(response.additionals || []).slice(0, 64)].slice(0, 64);
            for (const [name, entry] of names) {
              if (!entry.pending) continue;
              const matching = records.filter(record => normalize(record.name) === name && record.ttl > 0);
              const answer = matching.find(record => record.type === 'A' && privateIPv4(record.data)) ||
                (ipv6 && matching.find(record => record.type === 'AAAA' && globalIPv6(record.data)));
              if (answer) finish(entry, null, answer.data);
            }
          });
        }
        const query = () => {
          if (ended || !entry.pending) return;
          try { socket.query([{ name, type: 'A' }, ...(ipv6 ? [{ name, type: 'AAAA' }] : [])], error => { if (error) finish(entry, new Error('mDNS query failed')); }); }
          catch { finish(entry, new Error('mDNS query failed')); }
        };
        entry.timer = setTimeout(() => finish(entry, new Error('No mDNS response')), MDNS_TIMEOUT).unref();
        entry.retry = setTimeout(query, 1000).unref();
        query();
      } catch { finish(entry, new Error('mDNS unavailable')); }
      return entry.promise;
    },
    close() {
      if (ended) return;
      ended = true;
      for (const entry of names.values()) finish(entry, new Error('mDNS closed'));
      names.clear();
      try { socket?.destroy(); } catch {}
    },
  };
  return handle;
}
