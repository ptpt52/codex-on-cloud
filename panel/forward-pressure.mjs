export const FORWARD_PRESSURE_MS = 60000;

// TCP writable backpressure belongs to one logical stream. Heartbeats on its
// shared WSS/RTC cannot bound this wait, and idle TCPs need no expiry timer.
export function createForwardPressure(tcp, ws, expired) {
  let timer, ended = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const close = () => {
    if (ended) return;
    ended = true; clear();
    tcp.off('drain', drain); tcp.off('close', close); ws.off('close', close);
  };
  const drain = () => { clear(); if (!ended && ws.readyState === 1) ws.resume(); };
  tcp.on('drain', drain); tcp.once('close', close); ws.once('close', close);
  return {
    pause() {
      if (ended) return;
      ws.pause();
      timer ??= setTimeout(() => { close(); expired('tcp_peer_stalled'); }, FORWARD_PRESSURE_MS).unref();
    },
    close,
  };
}
