import net from 'node:net';
import { EventEmitter } from 'node:events';
import { attachTerminal } from './terminal-bridge.mjs';

export function vncUpstream(path, { push, close }) {
  const socket = net.createConnection({ path, highWaterMark: 16384 });
  socket.on('data', push); socket.once('error', close); socket.once('close', close);
  return { write(bytes) { if (socket.writableLength + bytes.length > 128 * 1024) throw new Error('upstream busy'); socket.write(bytes); },
    pause: () => socket.pause(), resume: () => socket.resume(), close: () => socket.destroy() };
}

export function terminalUpstream(options, { push, close }) {
  const socket = new EventEmitter(); let ended = false, pending = '', terminal;
  Object.defineProperties(socket, { readyState: { get: () => ended ? 3 : 1 }, bufferedAmount: { get: () => 0 } });
  socket.send = text => { if (!ended) push(Buffer.from(text + '\n')); };
  socket.terminate = () => { if (!ended) { ended = true; terminal?.close(); close(); } };
  terminal = attachTerminal(socket, options);
  return { write(bytes) {
    if (ended || pending.length + bytes.length > 192 * 1024) throw new Error('terminal input too large');
    pending += bytes.toString('utf8'); let newline;
    while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); socket.emit('message', Buffer.from(line), false); }
  }, pause() {}, resume() {}, close: () => { ended = true; terminal.close(); }, get idle() { return terminal.idle; } };
}
