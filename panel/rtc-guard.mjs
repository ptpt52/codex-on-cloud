import { isStunMessage, parseMessage, classes, methods } from 'werift';

// Guard the pinned ICE agent before it processes role changes or learns peers.
// No unauthenticated request can create an early-check queue or an echo service.
export function guardIceAgent(connection, { valid, allowed }) {
  const guarded = new WeakSet(), peers = new Set();
  let windowStart = performance.now(), requests = 0;
  // werift 0.26 otherwise falls back to Google STUN even with iceServers: [].
  // The server already knows its bound addresses; discovery is browser-only.
  connection.stunServer = undefined;
  const install = () => {
    for (const protocol of connection.protocols) {
      if (guarded.has(protocol)) continue;
      guarded.add(protocol);
      const receive = protocol.transport.onData;
      protocol.transport.onData = (bytes, address) => {
        if (!valid() || !allowed(address[0]) || address[1] < 1024 || address[1] > 65535) return;
        const key = `${address[0]}:${address[1]}`;
        if (isStunMessage(bytes)) {
          if (bytes.length > 2048) return;
          if ((bytes.readUInt16BE(0) & 0x0110) === classes.REQUEST) {
            const now = performance.now();
            if (now - windowStart >= 1000) { windowStart = now; requests = 0; }
            if (++requests > 64 || !connection.remoteUsername) return;
            const message = parseMessage(bytes, Buffer.from(connection.localPassword));
            if (!message || message.messageMethod !== methods.BINDING || message.getAttributeValue('USERNAME') !== `${connection.localUsername}:${connection.remoteUsername}`) return;
            if (!peers.has(key) && peers.size >= 16) return;
            if (!connection.earlyChecksDone && connection.checkList.length === 0 && connection.earlyChecks.length >= 16) return;
            peers.add(key);
          }
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
