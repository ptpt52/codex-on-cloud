import { desktopTransport, canTryDirect } from '/desktop/rtc.js';
import { controlDecoder, sendControl } from '/control.js';
export { canTryDirect };

// Presents the same terminal records as WSS; never retries an input record.
export async function terminalDirect(viewer, terminal, options) {
  let ended = false, transport, decoder;
  const socket = new EventTarget();
  const close = () => {
    if (ended) return;
    ended = true; decoder?.reset(); transport?.close(); socket.dispatchEvent(new Event('close'));
  };
  transport = await desktopTransport(viewer, live => { if (!live) close(); }, { ...options, terminal, probe: true });
  if (!transport || ended) { transport?.close(); return null; }
  const channel = transport.video(); channel.binaryType = 'arraybuffer';
  decoder = controlDecoder(value => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })), close);
  channel.addEventListener('message', event => { if (!ended) decoder.push(event.data); });
  channel.addEventListener('close', close); channel.addEventListener('error', close);
  Object.defineProperties(socket, {
    direct: { value: true },
    readyState: { get: () => ended ? 3 : channel.readyState === 'open' ? 1 : 0 },
    bufferedAmount: { get: () => channel.bufferedAmount },
  });
  socket.send = text => sendControl(channel, JSON.parse(text)); socket.close = close;
  socket.stats = () => transport.stats();
  return { socket, close, start: () => transport.start(), ping: () => transport.control.request('ping', {}),
    activate: () => transport.control.request('activate', {}), attach: () => transport.viewerReady(), stats: () => transport.stats() };
}
