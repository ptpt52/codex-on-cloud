// ws.pause() stops control frames as well as data. A slow TCP receiver must not
// be mistaken for a lost network, but may not retain a stream indefinitely.
export function forwardHeartbeat(ws, expired) {
  let pending = false, waited = 0, blocked = 0, wasPaused = false, ended = false, nonce = 0, challenge;
  const interval = setInterval(() => {
    if (ended) return;
    const fail = code => { ended = true; clearInterval(interval); expired(code); };
    if (ws.readyState !== 1) return fail('heartbeat_timeout');
    if (ws.isPaused) {
      wasPaused = true; pending = false; waited = 0; blocked += 15000;
      if (blocked >= 60000) return fail('tcp_peer_stalled');
      // Receive suspension must not also let the helper's read deadline expire.
      // Pongs queued during this bounded pause cannot confirm the resume probe.
      challenge = String(++nonce);
      try { ws.ping(challenge); } catch { fail('helper_disconnected'); }
      return;
    }
    blocked = 0;
    if (wasPaused) { wasPaused = false; pending = false; waited = 0; }
    if (pending) {
      waited += 15000;
      if (waited >= 30000) fail('heartbeat_timeout');
      return;
    }
    pending = true; waited = 0; challenge = String(++nonce);
    try { ws.ping(challenge); } catch { fail('helper_disconnected'); }
  }, 15000).unref();
  ws.on('pong', bytes => { if (pending && !wasPaused && bytes?.toString() === challenge) { pending = false; waited = 0; } });
  ws.once('close', () => { ended = true; clearInterval(interval); });
  ws.on('error', () => {});
}
