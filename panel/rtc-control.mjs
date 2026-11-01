import { controlDecoder, sendControl } from './public/control.js';

export function attachRTCControl(channel, { valid, perform }) {
  let ended = false, busy = false, lastId = 0;
  const close = () => { if (ended) return; ended = true; decoder.reset(); channel.close(); };
  const decoder = controlDecoder(value => {
    if (busy || !Number.isSafeInteger(value.id) || value.id <= lastId || value.id > 2147483647 || !valid()) { close(); return; }
    lastId = value.id; busy = true;
    void (async () => {
      let response;
      try {
        const result = await perform(value.action, value.body, () => !ended && channel.readyState === 'open' && valid());
        response = { id: value.id, ok: true, value: result };
      } catch (error) {
        response = { id: value.id, ok: false, error: { status: error.status || 502,
          message: error.status ? error.message : '直连桌面操作失败，请先查看桌面确认', outcome: error.outcome || (error.status ? 'rejected' : 'unknown') } };
      }
      if (ended || !valid()) { close(); return; }
      try { sendControl(channel, response); } catch { close(); }
    })().finally(() => { busy = false; });
  }, close);
  channel.onMessage.subscribe(bytes => { if (!ended) decoder.push(bytes); });
  channel.stateChange.subscribe(state => { if (state === 'closed') close(); });
  channel.error.subscribe(close);
  return { close };
}
