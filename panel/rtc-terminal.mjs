import { EventEmitter } from 'node:events';
import { controlDecoder, sendControl } from './public/control.js';
import { attachTerminal } from './terminal-bridge.mjs';

// Reuse the authenticated terminal protocol and its PTY/input/output limits.
// Only this bounded framing adapter knows about SCTP instead of WebSocket.
export function attachRTCTerminal(channel, options, failed) {
  const socket = new EventEmitter();
  let ended = false, terminal;
  const close = () => {
    if (ended) return;
    ended = true; decoder.reset(); terminal?.close(); channel.close(); failed();
  };
  const decoder = controlDecoder(value => socket.emit('message', Buffer.from(JSON.stringify(value)), false), close);
  Object.defineProperties(socket, {
    readyState: { get: () => !ended && channel.readyState === 'open' ? 1 : 3 },
    bufferedAmount: { get: () => channel.bufferedAmount },
  });
  socket.send = text => { try { sendControl(channel, JSON.parse(text)); } catch { close(); } };
  socket.terminate = close;
  terminal = attachTerminal(socket, options);
  return { close, receive: bytes => { if (!ended) decoder.push(bytes); }, get idle() { return terminal.idle; } };
}
