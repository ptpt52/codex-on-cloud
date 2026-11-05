import { controlDecoder, sendControl } from './public/control.js';
export function streamRTC(channel, session, valid, failed) {
  let entry, ended = false;
  const close = () => { if (ended) return; ended = true; decoder.reset(); entry?.close(); channel.close(); failed(); };
  const decoder = controlDecoder(value => { if (!valid()) close(); else entry?.receive(value); }, close);
  entry = session.attach('direct', { send: value => sendControl(channel, value), buffered: () => channel.bufferedAmount, close });
  return { close, receive: bytes => { if (!ended) decoder.push(bytes); }, get active() { return entry?.active === true; } };
}
