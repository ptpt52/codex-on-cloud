import { isStunMessage, parseMessage, classes, methods } from 'werift';
const canonical = host => host.includes(':') ? new URL(`http://[${host}]/`).hostname : host;

// Guard the pinned ICE agent before it processes role changes or learns peers.
// No unauthenticated request can create an early-check queue or an echo service.
export function guardIceAgent(connection, { valid, allowed, stun = false }) {
  const guarded = new WeakSet(), peers = new Set();
  let windowStart = performance.now(), requests = 0;
  // werift 0.26 otherwise falls back to Google STUN even with iceServers: [].
  if (!stun) connection.stunServer = undefined;
  const install = () => {
    for (const protocol of connection.protocols) {
      if (guarded.has(protocol)) continue;
      guarded.add(protocol);
      // TURN control traffic keeps its own transaction integrity checks. Guard
      // decoded peer packets, rather than the allocation server's TCP/TLS socket.
      const target = protocol.turn ? protocol : protocol.transport;
      const method = protocol.turn ? 'handleStunMessage' : 'onData';
      const receive = target[method].bind(target);
      target[method] = (bytes, address) => {
        if (!valid() || !allowed(address[0], address[1]) || address[1] < 1024 || address[1] > 65535) return;
        const key = `${address[0]}:${address[1]}`;
        if (isStunMessage(bytes)) {
          if (bytes.length > 2048) return;
          const messageClass = bytes.readUInt16BE(0) & 0x0110;
          if (messageClass === classes.RESPONSE || messageClass === classes.ERROR) {
            // Discovery has no shared key; pin its response to an outstanding
            // transaction and its resolved source. ICE checks also require HMAC.
            const transaction = (protocol.turn?.transactions || protocol.transactions)?.[bytes.subarray(8, 20).toString('hex')];
            if (!transaction || canonical(transaction.addr[0]) !== canonical(address[0]) || transaction.addr[1] !== address[1] ||
                transaction.integrityKey && !parseMessage(bytes, transaction.integrityKey)) return;
          } else if (messageClass === classes.REQUEST) {
            const now = performance.now();
            if (now - windowStart >= 1000) { windowStart = now; requests = 0; }
            if (++requests > 64 || !connection.remoteUsername) return;
            const message = parseMessage(bytes, Buffer.from(connection.localPassword));
            if (!message || message.messageMethod !== methods.BINDING || message.getAttributeValue('USERNAME') !== `${connection.localUsername}:${connection.remoteUsername}`) return;
            if (!peers.has(key) && peers.size >= 16) return;
            if (!connection.earlyChecksDone && connection.checkList.length === 0 && connection.earlyChecks.length >= 16) return;
            peers.add(key);
          } else return;
        } else {
          const pair = connection.nominated;
          if (!peers.has(key) && !(pair?.remoteCandidate.host === address[0] && pair.remoteCandidate.port === address[1])) return;
        }
        receive(bytes, address);
      };
    }
  };
  connection.onIceCandidate.subscribe(install);
  install();
}
