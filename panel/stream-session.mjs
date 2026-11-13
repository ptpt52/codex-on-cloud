export const STREAM_ID = /^[a-f0-9]{32}$/;
export const STREAM_CHUNK = 12 * 1024;
export const STREAM_WINDOW = 256 * 1024;
export const STREAM_LIMIT = 1024 * 1024;
export const STREAM_TTL = 15000;
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 40;
function decode(text) {
  if (typeof text !== 'string' || !text.length || text.length > STREAM_CHUNK * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('invalid chunk');
  const bytes = Buffer.from(text, 'base64'); if (!bytes.length || bytes.length > STREAM_CHUNK) throw new Error('invalid chunk'); return bytes;
}

// One upstream, two authenticated paths, bounded unacknowledged output. Input
// is never retransmitted. An uncertain input gap requires a fresh attachment.
export function createStreamSession({ id, valid, connect, canActivate = async () => true, performPanel, createTerminal, openTerminal, switchTarget, closed = () => {}, ttl = STREAM_TTL }) {
  const peers = new Map(), output = [];
  let upstream, active, ended = false, epoch = 0, produced = 0, acked = 0, input = 0, assembly, assemblyTimer, expiry, activating = false, creating = false, holding = false, holdTimer, handoff, upstreamGeneration = 0;
  const stop = () => {
    if (ended) return; ended = true; clearTimeout(expiry); clearTimeout(assemblyTimer); clearTimeout(holdTimer); clearInterval(guard);
    upstream?.close(); upstream = undefined; assembly = undefined; output.length = 0;
    for (const peer of peers.values()) peer.io.close(); peers.clear(); active = undefined; closed();
  };
  const check = () => { if (ended || !valid()) { stop(); return false; } return true; };
  const guard = setInterval(check, 1000).unref();
  function send(peer, value) {
    if (!check() || peers.get(peer.kind) !== peer || peer.io.buffered() > STREAM_LIMIT) return false;
    try { peer.io.send(value); return true; } catch { detach(peer); return false; }
  }
  function armExpiry() { clearTimeout(expiry); if (!ended) expiry = setTimeout(stop, ttl).unref(); }
  function detach(peer) {
    if (peers.get(peer.kind) !== peer) return;
    peers.delete(peer.kind); peer.io.close();
    if (handoff?.peer === peer) releaseHold();
    if (active === peer) { active = undefined; upstream?.pause(); armExpiry(); }
  }
  function pressure() { if (!active || holding || produced - acked >= STREAM_WINDOW) upstream?.pause(); else upstream?.resume(); }
  function releaseHold() {
    clearTimeout(holdTimer); holding = false; handoff = undefined;
    if (active) flush(active, active.sent); pressure();
  }
  const welcome = peer => send(peer, { type: 'welcome', id, epoch, handoff: 1, panel: performPanel ? 1 : 0, terminalCreate: createTerminal ? 1 : 0, terminalOpen: openTerminal ? 1 : 0, terminalSwitch: switchTarget ? 1 : 0, terminalSwitchRelay: switchTarget ? 1 : 0 });
  function openUpstream() {
    const generation = ++upstreamGeneration;
    upstream = connect({ push: bytes => { if (generation === upstreamGeneration) push(bytes); }, close: () => { if (generation === upstreamGeneration) stop(); } });
  }
  const panelError = (error, mutation = false) => ({ status: error.status || 503, message: error.status ? error.message : '会话请求未完成', outcome: mutation ? error.outcome || (error.status ? 'rejected' : 'unknown') : 'rejected' });
  function flush(peer, from) {
    for (const chunk of output) if (chunk.at >= from) {
      peer.sent = chunk.at + chunk.bytes.length;
      if (active !== peer || !send(peer, { type: 'chunk', epoch, at: chunk.at, data: chunk.bytes.toString('base64') })) return;
    }
  }
  function push(bytes) {
    if (!check() || !Buffer.isBuffer(bytes) || !bytes.length) return;
    if (produced + bytes.length - acked > STREAM_LIMIT || produced + bytes.length > 2 ** 40 || output.length + Math.ceil(bytes.length / STREAM_CHUNK) > 1024) return stop();
    const start = produced;
    for (let at = 0; at < bytes.length; at += STREAM_CHUNK) {
      const data = Buffer.from(bytes.subarray(at, at + STREAM_CHUNK)); output.push({ at: produced, bytes: data }); produced += data.length;
    }
    if (active && !holding) flush(active, start); pressure();
  }
  async function receive(peer, value) {
    if (!check() || peers.get(peer.kind) !== peer || !value || typeof value !== 'object' || Array.isArray(value)) return;
    try {
      if (value.type === 'ping') {
        if (!integer(value.id) || value.id <= peer.ping) throw new Error();
        const now = Date.now(); if (now - peer.pingAt >= 1000) { peer.pingAt = now; peer.pings = 0; }
        if (++peer.pings > 8) throw new Error(); peer.ping = value.id; send(peer, { type: 'pong', id: value.id }); return;
      }
      if (value.type === 'end') return stop();
      if (value.type === 'prepare') {
        if (!integer(value.id) || value.id <= peer.prepare || !integer(value.epoch) || !integer(value.out) || !integer(value.input)) throw new Error();
        peer.prepare = value.id;
        if (value.epoch !== epoch) { welcome(peer); return; }
        if (activating || creating || holding || active === peer || !active) { send(peer, { type: 'wait', prepare: value.id }); return; }
        activating = true;
        try {
          if (!await canActivate(true) || !check() || peers.get(peer.kind) !== peer) { send(peer, { type: 'wait', prepare: value.id }); return; }
          if (value.epoch !== epoch) { welcome(peer); return; }
          if (peer.cancelledPrepare === value.id || !active || holding || value.input !== input || assembly || value.out < acked || value.out > produced || (value.out !== produced && !output.some(item => item.at === value.out))) {
            send(peer, { type: 'wait', prepare: value.id }); return;
          }
          // Freeze at the candidate's authenticated snapshot. The old relay
          // need not answer, and cannot advance input across this boundary.
          holding = true; handoff = { peer, id: value.id, epoch };
          holdTimer = setTimeout(releaseHold, 2500).unref(); pressure();
          send(peer, { type: 'prepared', id: value.id, epoch, input });
        } finally { activating = false; }
        return;
      }
      if (value.type === 'cancel-prepare') {
        if (value.id === peer.prepare) peer.cancelledPrepare = value.id;
        if (handoff?.peer === peer && handoff.id === value.id && handoff.epoch === value.epoch) releaseHold();
        return;
      }
      if (value.type === 'activate') {
        if (!integer(value.epoch) || !integer(value.out) || !integer(value.input)) throw new Error();
        if (activating || creating) { send(peer, { type: 'wait' }); return; }
        if (value.epoch !== epoch) { welcome(peer); return; }
        const prepared = () => value.handoff === undefined ? !handoff : handoff?.peer === peer && handoff.id === value.handoff && handoff.epoch === epoch;
        if (!prepared()) { send(peer, { type: 'wait' }); return; }
        activating = true;
        try {
          if (!await canActivate(!!active && active !== peer) || !check() || peers.get(peer.kind) !== peer) { send(peer, { type: 'wait' }); return; }
          if (value.epoch !== epoch) { welcome(peer); return; }
          if (!prepared()) { send(peer, { type: 'wait' }); return; }
          if (value.input !== input || assembly || value.out < acked || value.out > produced || (value.out !== produced && !output.some(item => item.at === value.out))) {
            send(peer, { type: 'reset', reason: value.input !== input || assembly ? 'input-unknown' : 'output-expired' }); stop(); return;
          }
          clearTimeout(expiry); clearTimeout(holdTimer); holding = false; handoff = undefined; active = peer; epoch++; peer.sent = value.out;
          acked = value.out; while (output.length && output[0].at + output[0].bytes.length <= acked) output.shift();
          send(peer, { type: 'active', epoch, input, out: value.out });
          flush(peer, value.out);
          if (!upstream) openUpstream();
          pressure();
        } finally { activating = false; }
        return;
      }
      // Delayed records from a retired writer cannot act on the new route.
      if (active !== peer || value.epoch !== epoch) return;
      if (value.type === 'panel') {
        const operation = value.action === 'create-terminal' ? createTerminal : value.action === 'open-terminal' ? openTerminal : null;
        const mutation = ['create-terminal', 'open-terminal'].includes(value.action);
        if ((mutation ? !operation : peer.kind !== 'direct' || !performPanel || !['state', 'terminals'].includes(value.action)) || !Number.isSafeInteger(value.id) || value.id <= peer.panelId || value.id > 2147483647) throw new Error();
        peer.panelId = value.id;
        const now = Date.now(); if (now - peer.panelAt >= 1000) { peer.panelAt = now; peer.panelCount = 0; }
        if (++peer.panelCount > 8) throw new Error();
        if (peer.panelBusy.has(value.action)) { send(peer, { type: 'panel-result', epoch, id: value.id, ok: false, error: { status: 429, message: '此项直连查询仍在处理', outcome: 'rejected' } }); return; }
        if (mutation && (activating || creating || holding)) { send(peer, { type: 'panel-result', epoch, id: value.id, ok: false, error: { status: 409, message: '连接正在切换，终端操作未执行', outcome: 'rejected' } }); return; }
        const requestEpoch = epoch, live = () => check() && active === peer && epoch === requestEpoch && peers.get(peer.kind) === peer;
        peer.panelBusy.add(value.action);
        if (mutation) creating = true;
        try {
          let result;
          try {
            if (mutation && Buffer.byteLength(JSON.stringify(value.body) || '') > 1024) throw Object.assign(new Error('终端操作参数超过 1 KiB'), { status: 413, outcome: 'rejected' });
            result = { type: 'panel-result', epoch: requestEpoch, id: value.id, ok: true, value: mutation ? await operation(value.body, live) : await performPanel(value.action, live) };
          } catch (error) { result = { type: 'panel-result', epoch: requestEpoch, id: value.id, ok: false, error: panelError(error, mutation) }; }
          if (Buffer.byteLength(JSON.stringify(result)) > 16384) result = { type: 'panel-result', epoch: requestEpoch, id: value.id, ok: false, error: { status: 413, message: '直连管理响应超过 16 KiB', outcome: mutation ? 'unknown' : 'rejected' } };
          if (live()) send(peer, result);
        } finally { peer.panelBusy.delete(value.action); if (mutation) creating = false; }
        return;
      }
      if (value.type === 'switch-terminal') {
        if (!switchTarget || !Number.isSafeInteger(value.id) || value.id <= peer.switchId || value.id > 2147483647 || !integer(value.input)) throw new Error();
        peer.switchId = value.id;
        const requestEpoch = epoch, live = () => check() && active === peer && epoch === requestEpoch && peers.get(peer.kind) === peer;
        const reject = error => { if (live()) send(peer, { type: 'switch-result', epoch, id: value.id, ok: false, error: panelError(error) }); };
        if (activating || creating || holding || assembly || value.input !== input) { reject({ status: 409, message: '操作尚未结束，暂不切换终端' }); return; }
        activating = true;
        let committed = false;
        try {
          if (!await canActivate(true) || !live()) { reject({ status: 409, message: '终端忙碌或控制权已变化' }); return; }
          const change = await switchTarget(value.target, live);
          if (!live()) return;
          if (assembly || value.input !== input) { reject({ status: 409, message: '输入状态已变化，请重新选择终端' }); return; }
          change.commit(); committed = true;
          // Retire callbacks before closing the viewer; the shell itself lives
          // in tmux. Old output must never enter the newly selected terminal.
          upstreamGeneration++; const previous = upstream; upstream = undefined; previous?.close();
          output.length = 0; acked = produced; epoch++; peer.sent = produced;
          for (const other of [...peers.values()]) if (other !== peer) detach(other);
          send(peer, { type: 'switched', id: value.id, epoch, out: produced, input, target: change.target });
          openUpstream(); pressure();
        } catch (error) { if (committed) stop(); else reject(error); }
        finally { activating = false; }
        return;
      }
      if (handoff && value.type === 'input') { send(peer, { type: 'reset', reason: 'input-unknown' }); stop(); return; }
      if (handoff && value.type !== 'ack') return;
      if (value.type === 'hold' || value.type === 'unhold') {
        clearTimeout(holdTimer); holding = value.type === 'hold';
        if (holding) {
          holdTimer = setTimeout(releaseHold, 2500).unref();
          pressure(); send(peer, { type: 'held', epoch });
        } else { flush(peer, peer.sent); pressure(); }
        return;
      }
      if (value.type === 'ack') {
        if (!integer(value.at) || value.at > peer.sent || value.at > produced) throw new Error();
        if (value.at <= acked) return;
        if (value.at !== produced && !output.some(item => item.at === value.at)) throw new Error();
        acked = value.at; while (output.length && output[0].at + output[0].bytes.length <= acked) output.shift(); pressure(); return;
      }
      if (value.type !== 'input' || !integer(value.id) || value.id !== input + 1 || !Number.isInteger(value.part) || !Number.isInteger(value.parts) || value.parts < 1 || value.parts > 16 || value.part < 0 || value.part >= value.parts) throw new Error();
      const bytes = decode(value.data);
      if (!assembly) {
        if (value.part !== 0) throw new Error();
        assembly = { id: value.id, parts: value.parts, chunks: [], length: 0 };
        assemblyTimer = setTimeout(stop, 3000).unref();
      }
      if (assembly.id !== value.id || assembly.parts !== value.parts || assembly.chunks.length !== value.part || assembly.length + bytes.length > 128 * 1024) throw new Error();
      assembly.chunks.push(bytes); assembly.length += bytes.length;
      if (assembly.chunks.length === assembly.parts) {
        const data = Buffer.concat(assembly.chunks); assembly = undefined; clearTimeout(assemblyTimer);
        upstream.write(data); input = value.id; send(peer, { type: 'input-ack', epoch, id: input });
      }
    } catch { detach(peer); }
  }
  armExpiry();
  return {
    attach(kind, io) {
      if (!check() || !['relay', 'direct'].includes(kind)) { io.close(); return; }
      if (peers.has(kind)) detach(peers.get(kind));
      const peer = { kind, io, sent: 0, ping: 0, pings: 0, pingAt: Date.now(), prepare: 0, panelId: 0, panelBusy: new Set(), panelAt: Date.now(), panelCount: 0, switchId: 0 }; peers.set(kind, peer);
      welcome(peer);
      return { receive: value => { void receive(peer, value); }, close: () => detach(peer), get active() { return active === peer; } };
    },
    close: stop,
    get idle() { return !assembly && (upstream?.idle ?? true); },
    get closed() { return ended; },
    get retained() { return produced - acked; },
  };
}
