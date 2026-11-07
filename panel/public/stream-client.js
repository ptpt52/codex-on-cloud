import { desktopTransport, canTryDirect } from './rtc.js';
import { controlDecoder, sendControl } from '/control.js';
import { routePolicy, STABLE_ROUTE } from './transport-policy.js';

const CHUNK = 12 * 1024, integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 40;
const encode = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

// One browser-visible channel. Network paths may change; the consumer and its
// parser stay attached. Only downstream bytes can be replayed, never inputs.
export function createStreamClient({ viewer, csrf, terminal, bootstrap, idle = () => true, settled = idle, targetIdle = settled, prepare = async () => true, paused = () => {}, changed = () => {}, issue = () => {} }) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const socket = new EventTarget(), peers = new Map(), routes = routePolicy(), inputSizes = new Map();
  let active, ended = false, opened = false, out = 0, epoch = 0, sent = 0, inputAck = 0, inputBytes = 0, isPaused = false, claiming = false, transitioning = false, prepareSequence = 0;
  let relayTimer, directTimer, directDue = 0, promotionTimer, recoveryTimer, directController, relayDelay = 250, probeDelay = 15000, terminalText = '';
  let heldOutput = [], heldBytes = 0;
  let textDecoder = new TextDecoder('utf-8', { fatal: true }), panelSequence = 0, targetSequence = 0, targetPending;
  const panelRequests = new Map();
  const failure = (message, status = 409) => Object.assign(new Error(message), { status, outcome: 'rejected' });
  function finishPanel(id, error, value) {
    const pending = panelRequests.get(id); if (!pending) return;
    panelRequests.delete(id); clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
    error ? pending.reject(error) : pending.resolve(value);
  }
  function finishTarget(error, value) {
    if (!targetPending) return;
    const pending = targetPending; targetPending = undefined; clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
    claiming = false; heldOutput = []; heldBytes = 0;
    if (!ended) { pause(false); scheduleDirect(); } error ? pending.reject(error) : pending.resolve(value);
  }
  function emit(type, data) {
    const event = ['message', 'target'].includes(type) ? new MessageEvent(type, { data }) : new Event(type);
    socket[`on${type}`]?.(event); socket.dispatchEvent(event);
  }
  function pause(value) { if (value !== isPaused) { isPaused = value; paused(value); } }
  function send(peer, value) {
    if (!peer || peer.gone || peer.buffered() > 256 * 1024) throw new Error('path unavailable'); peer.send(value);
  }
  function close(reason = '') {
    if (ended) return;
    if (targetPending) reason = 'target-unknown';
    socket.lastError = reason;
    if (['input-unknown', 'input-pressure', 'target-unknown'].includes(reason)) parent.postMessage({ type: 'codex-stream-reset', frame: new URLSearchParams(location.search).get('frame'), reason }, location.origin);
    for (const peer of peers.values()) { try { if (peer.ready) send(peer, { type: 'end' }); } catch {} }
    ended = true; directController?.abort();
    for (const id of [...panelRequests.keys()]) finishPanel(id, failure('直连查询已取消'));
    finishTarget(failure('终端切换结果未知，请重新选择'));
    for (const timer of [relayTimer, directTimer, promotionTimer, recoveryTimer]) clearTimeout(timer);
    for (const peer of peers.values()) { peer.gone = true; clearTimeout(peer.timer); clearTimeout(peer.deadline); clearTimeout(peer.startTimer); peer.wait?.reject(new Error('closed')); peer.prepareWait?.reject(new Error('closed')); peer.close(); }
    peers.clear(); active = undefined; inputSizes.clear(); terminalText = ''; pause(false);
    for (const name of ['online', 'offline']) window.removeEventListener(name, wake);
    navigator.connection?.removeEventListener('change', wake); document.removeEventListener('visibilitychange', wake);
    emit('close');
  }
  function lost(peer) {
    if (!peer || peer.gone || ended) return;
    for (const [id, pending] of panelRequests) if (pending.peer === peer) finishPanel(id, failure('直连查询已中断'));
    if (targetPending?.peer === peer) { close('target-unknown'); return; }
    peer.gone = true; clearTimeout(peer.timer); clearTimeout(peer.deadline); clearTimeout(peer.startTimer); peer.wait?.reject(new Error('path lost')); peer.prepareWait?.reject(new Error('path lost'));
    if (peers.get(peer.kind) === peer) peers.delete(peer.kind); peer.close();
    if (active === peer) {
      active = undefined; claiming = false; pause(true); changed();
      if (peer.kind === 'direct') { routes.changed(); issue('connection'); }
      recoveryTimer ??= setTimeout(() => close('resume-timeout'), 12000);
      const backup = peers.get('relay'); if (backup?.ready) void activate(backup); else ensureRelay();
    }
    if (peer.kind === 'relay') ensureRelay(); else scheduleDirect();
  }
  function ping(peer) {
    if (peer.gone || ended || !peer.ready || peer.ping) return;
    const nonce = ++peer.nonce; peer.ping = nonce;
    peer.deadline = setTimeout(() => lost(peer), 2000);
    try { send(peer, { type: 'ping', id: nonce }); } catch { lost(peer); }
  }
  function heartbeat(peer, delay = 3000) {
    const due = performance.now() + delay;
    if (peer.timer && peer.due <= due) return;
    clearTimeout(peer.timer);
    peer.timer = undefined; peer.due = due;
    if (!document.hidden && navigator.onLine && !peer.gone && !ended && !peer.ping) peer.timer = setTimeout(() => { peer.timer = undefined; ping(peer); }, delay);
  }
  function receive(peer, value) {
    if (ended || peer.gone) return;
    try {
      if (!value || typeof value !== 'object') throw new Error();
      if (value.type === 'welcome') {
        if (value.id !== id || !integer(value.epoch)) throw new Error();
        if (opened && value.epoch === 0 && (out || sent)) return close('session-expired');
        // A standby's delayed welcome cannot advance the active writer or an
        // in-flight target switch. Only activation commits that boundary.
        if (!active || peer === active && !targetPending) epoch = Math.max(epoch, value.epoch);
        peer.epoch = value.epoch; peer.handoff = value.handoff === 1; peer.panel = value.panel === 1;
        peer.terminalSwitch = value.terminalSwitch === 1 && (peer.kind === 'direct' || value.terminalSwitchRelay === 1);
        peer.ready = true; clearTimeout(peer.startTimer); heartbeat(peer);
        if (peer.prepareWait || peer.wait?.handoff !== undefined) { peer.prepareWait?.reject(new Error('busy')); peer.wait?.reject(new Error('busy')); return; }
        if (peer.wait && claiming) { send(peer, { type: 'activate', epoch: value.epoch, out, input: sent }); return; }
        peer.welcome?.(); if (!active && !claiming) void activate(peer); return;
      }
      if (value.type === 'pong') {
        if (!integer(value.id) || value.id !== peer.ping) return;
        clearTimeout(peer.deadline); peer.ping = 0; heartbeat(peer); return;
      }
      if (value.type === 'reset') return close(value.reason || 'session-reset');
      if (value.type === 'panel-result') {
        const pending = panelRequests.get(value.id);
        if (!pending || pending.peer !== peer || pending.epoch !== value.epoch || peer !== active || value.epoch !== epoch) return;
        finishPanel(value.id, value.ok === true ? null : failure(value.error?.message || '直连查询失败', value.error?.status), value.value); return;
      }
      if (value.type === 'switched') {
        const pending = targetPending;
        if (!pending || pending.peer !== peer || pending.id !== value.id || !integer(value.epoch) || value.epoch <= epoch || !integer(value.out) || value.out < out || value.input !== sent || value.target?.terminalId !== pending.target.terminalId || value.target?.terminalToken !== pending.target.terminalToken) throw new Error();
        epoch = value.epoch; out = value.out; inputAck = sent; peer.epoch = epoch;
        inputSizes.clear(); inputBytes = 0; terminalText = ''; textDecoder = new TextDecoder('utf-8', { fatal: true }); Object.assign(terminal, value.target);
        for (const id of [...panelRequests.keys()]) finishPanel(id, failure('终端查看目标已变化'));
        emit('target', value.target); finishTarget(null, value.target);
        for (const other of [...peers.values()]) if (other !== peer) lost(other);
        changed(); ensureRelay(); return;
      }
      if (value.type === 'switch-result' && targetPending?.peer === peer && targetPending.id === value.id && value.epoch === epoch && value.ok === false) {
        const held = heldOutput; finishTarget(failure(value.error?.message || '终端暂不可切换', value.error?.status));
        for (const [from, chunk] of held) receive(from, chunk); return;
      }
      if (value.type === 'held' && peer === active && value.epoch === epoch) { peer.holdWait?.(); peer.holdWait = undefined; return; }
      if (value.type === 'prepared') {
        const pending = peer.prepareWait;
        if (!pending || pending.id !== value.id) return;
        if (value.epoch !== epoch || value.input !== sent) throw new Error();
        pending.resolve(); return;
      }
      if (value.type === 'wait') { if (value.prepare !== undefined) { if (peer.prepareWait?.id === value.prepare) peer.prepareWait.reject(new Error('busy')); } else { peer.wait?.reject(new Error('busy')); peer.wait = undefined; } return; }
      if (value.type === 'active') {
        if (!peer.wait || !integer(value.epoch) || !integer(value.out) || value.out > out || value.input !== sent) throw new Error();
        epoch = value.epoch; active = peer; peer.epoch = epoch; inputAck = value.input; inputSizes.clear(); inputBytes = 0;
        heldOutput = []; heldBytes = 0;
        clearTimeout(recoveryTimer); recoveryTimer = undefined;
        const waiter = peer.wait; peer.wait = undefined; claiming = false;
        if (!opened) { opened = true; emit('open'); }
        changed(); waiter.resolve(); return;
      }
      if (value.type === 'input-ack') {
        if (peer !== active || value.epoch !== epoch || !integer(value.id) || value.id > sent) return;
        inputAck = Math.max(inputAck, value.id);
        for (const [n, size] of inputSizes) if (n <= inputAck) { inputBytes -= size; inputSizes.delete(n); }
        return;
      }
      if (value.type !== 'chunk' || peer !== active || value.epoch !== epoch) return;
      if (claiming) {
        if (typeof value.data !== 'string' || value.data.length > 16384 || (heldBytes += value.data.length) > 1400 * 1024 || heldOutput.length >= 1024) throw new Error();
        heldOutput.push([peer, value]); return;
      }
      if (!integer(value.at) || typeof value.data !== 'string' || value.data.length > 16384) throw new Error();
      const bytes = decode(value.data); if (!bytes.length || bytes.length > CHUNK) throw new Error();
      if (value.at + bytes.length <= out) { send(peer, { type: 'ack', epoch, at: out }); return; }
      if (value.at !== out) throw new Error();
      out += bytes.length;
      if (terminal) {
        terminalText += textDecoder.decode(bytes, { stream: true }); if (terminalText.length > 128 * 1024) throw new Error();
        let newline;
        while ((newline = terminalText.indexOf('\n')) >= 0) { const line = terminalText.slice(0, newline); terminalText = terminalText.slice(newline + 1); emit('message', line); }
      } else emit('message', bytes.buffer);
      send(peer, { type: 'ack', epoch, at: out });
    } catch { lost(peer); }
  }
  async function activate(peer, planned = false) {
    if (ended || transitioning || peer.gone || !peer.ready || active === peer || document.hidden || !navigator.onLine) return false;
    transitioning = true;
    let approved = false, heldPeer, handoff, committing = false; const wasOpened = opened, previous = active;
    try {
      if (planned) {
        if (!idle() || inputAck !== sent || routes.remaining()) return false;
        const controller = new AbortController();
        approved = await prepare(controller.signal); if (!approved || ended || peer.gone || !settled() || document.hidden || !navigator.onLine) return false;
      }
      pause(true);
      // Drain releases before freezing the output offset. The new candidate
      // can then fence the old writer without waiting for the old network.
      const deadline = performance.now() + 1500;
      while (active && (inputAck !== sent || (planned && !settled())) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (planned && (inputAck !== sent || !settled())) return false;
      claiming = true;
      if (planned && active) {
        if (peer.handoff) {
          if (prepareSequence >= 2 ** 40) throw new Error('handoff limit');
          handoff = ++prepareSequence;
          await new Promise((resolve, reject) => {
            const finish = error => { clearTimeout(timer); peer.prepareWait = undefined; error ? reject(error) : resolve(); };
            const timer = setTimeout(() => finish(new Error('prepare timeout')), 2500);
            peer.prepareWait = { id: handoff, resolve: () => finish(), reject: finish };
            try { send(peer, { type: 'prepare', id: handoff, epoch, out, input: sent }); } catch (error) { finish(error); }
          });
        } else {
          heldPeer = active;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { heldPeer.holdWait = undefined; reject(new Error('hold timeout')); }, 2000);
            heldPeer.holdWait = () => { clearTimeout(timer); resolve(); };
            send(heldPeer, { type: 'hold', epoch });
          });
        }
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.wait = undefined; reject(new Error('activation timeout')); }, 2500);
        peer.wait = { handoff, resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
        try { send(peer, { type: 'activate', epoch, out, input: sent, ...(handoff === undefined ? {} : { handoff }) }); committing = true; }
        catch (error) { peer.wait.reject(error); peer.wait = undefined; }
      });
      if (wasOpened) routes.changed(); relayDelay = 250; return true;
    } catch (error) {
      if (error.message !== 'busy') { lost(peer); if (committing && active === previous) { active = undefined; pause(true); } }
      return false;
    }
    finally {
      claiming = false; transitioning = false;
      if (handoff !== undefined && active !== peer && !peer.gone) { try { send(peer, { type: 'cancel-prepare', epoch, id: handoff }); } catch { lost(peer); } }
      if (heldPeer && active === heldPeer && !heldPeer.gone) { try { send(heldPeer, { type: 'unhold', epoch }); } catch { lost(heldPeer); } }
      const held = heldOutput; heldOutput = []; heldBytes = 0;
      if (active) for (const [from, value] of held) receive(from, value);
      if (active) pause(false);
      if (!active && !ended) { ensureRelay(); promotionTimer = setTimeout(() => { const relay = peers.get('relay'); if (relay?.ready) void activate(relay); }, 250); }
      if (approved) parent.postMessage({ type: 'codex-direct-finished', frame: new URLSearchParams(location.search).get('frame') }, location.origin);
    }
  }
  function peerFor(kind, send, close, buffered, deferred = false) {
    const peer = { kind, send, close, buffered, ready: false, gone: false, epoch: 0, nonce: 0, ping: 0 };
    if (!deferred) peer.startTimer = setTimeout(() => lost(peer), 12000); peers.set(kind, peer); return peer;
  }
  function ensureRelay() {
    if (ended || peers.has('relay') || relayTimer || document.hidden || !navigator.onLine) return;
    relayTimer = setTimeout(() => {
      relayTimer = undefined;
      if (ended || peers.has('relay') || document.hidden || !navigator.onLine) return;
      const url = new URL('/session/connect', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      for (const [key, value] of Object.entries({ viewer, streamId: id, mode: terminal ? 'terminal' : 'desktop', ...(terminal || {}) })) url.searchParams.set(key, value);
      const ws = new WebSocket(url), peer = peerFor('relay', value => ws.send(JSON.stringify(value)), () => ws.close(), () => ws.bufferedAmount);
      ws.addEventListener('open', () => { if (!ended && !peer.gone) ws.send(JSON.stringify({ type: 'auth', csrf })); });
      ws.addEventListener('message', event => { try { if (typeof event.data !== 'string' || event.data.length > 24576) throw new Error(); receive(peer, JSON.parse(event.data)); } catch { lost(peer); } });
      ws.addEventListener('close', () => lost(peer)); ws.addEventListener('error', () => lost(peer));
      relayDelay = Math.min(4000, relayDelay * 2);
    }, opened ? relayDelay : 0);
  }
  function scheduleDirect(delay = probeDelay) {
    if (ended || targetPending || directController || peers.has('direct') || !canTryDirect() || document.hidden || !navigator.onLine || active?.kind === 'direct') return;
    const wait = Math.max(delay, routes.remaining()), due = performance.now() + wait;
    if (directTimer && directDue <= due) return;
    clearTimeout(directTimer); directDue = due;
    directTimer = setTimeout(() => { directTimer = undefined; void connectDirect(); }, wait);
  }
  async function promote(peer) {
    if (ended || targetPending || peer.gone || active === peer || document.hidden || !navigator.onLine) return;
    if (!active || (idle() && !routes.remaining())) await activate(peer, !!active);
    if (!ended && !peer.gone && active !== peer) { clearTimeout(promotionTimer); promotionTimer = setTimeout(() => void promote(peer), Math.max(1000, routes.remaining())); }
  }
  async function connectDirect() {
    if (ended || targetPending || directController || peers.has('direct') || document.hidden || !navigator.onLine || !canTryDirect()) return;
    const controller = directController = new AbortController(); let transport, peer;
    try {
      transport = await desktopTransport(viewer, live => { if (!live && peer) lost(peer); }, { probe: true, signal: controller.signal, terminal, streamId: id, bootstrap, failed: issue });
      if (!transport) throw new Error();
      const channel = transport.video(); channel.binaryType = 'arraybuffer';
      peer = peerFor('direct', value => sendControl(channel, value), () => transport.close(), () => channel.bufferedAmount, true); peer.transport = transport;
      const decoder = controlDecoder(value => receive(peer, value), () => lost(peer));
      channel.addEventListener('message', event => { if (!peer.gone) decoder.push(event.data); }); channel.addEventListener('close', () => lost(peer)); channel.addEventListener('error', () => lost(peer));
      await transport.start(); await transport.control.request('ping', {});
      if (active) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, STABLE_ROUTE); controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); });
      if (ended || peer.gone || controller.signal.aborted) throw new Error();
      await transport.control.request('ping', {}); await transport.control.request('activate', {});
      await new Promise((resolve, reject) => { peer.welcome = resolve; transport.viewerReady(); const timer = setTimeout(() => reject(new Error('no standby')), 3000); peer.welcome = () => { clearTimeout(timer); resolve(); }; });
      probeDelay = 15000; void promote(peer);
    } catch { if (peer) lost(peer); else transport?.close(); if (!controller.signal.aborted) probeDelay = Math.min(60000, probeDelay * 2); }
    finally { if (directController === controller) directController = undefined; scheduleDirect(); }
  }
  function wake() {
    if (ended) return;
    if (document.hidden || !navigator.onLine) {
      clearTimeout(directTimer); directTimer = undefined;
      clearTimeout(relayTimer); relayTimer = undefined;
      for (const peer of peers.values()) { clearTimeout(peer.timer); peer.timer = undefined; clearTimeout(peer.deadline); peer.ping = 0; }
      if (!navigator.onLine) for (const peer of [...peers.values()]) lost(peer);
      return;
    }
    for (const peer of peers.values()) if (peer.ready && !peer.ping) heartbeat(peer, 250);
    ensureRelay(); scheduleDirect(1000); const direct = peers.get('direct'); if (direct?.ready) void promote(direct);
  }
  Object.assign(socket, { binaryType: 'arraybuffer', protocol: '', onopen: null, onclose: null, onmessage: null, onerror: null, session: true,
    close: () => close(), reconnect: () => lost(active), stats: async () => active?.transport?.stats() || null,
    panelRequest(action, body = {}, signal) {
      const peer = active;
      if (ended || !peer?.ready || signal?.aborted) return Promise.reject(failure('会话通道未就绪'));
      if (action === 'switch-terminal') {
        if (!terminal || !peer.terminalSwitch || targetPending || transitioning || claiming || !targetIdle() || inputAck !== sent || targetSequence >= 2147483647) return Promise.reject(failure('终端仍有操作进行中，本次切换未发送'));
        const target = { terminalId: body.terminalId, terminalToken: body.terminalToken };
        if (!['main', 'aux1', 'aux2', 'aux3'].includes(target.terminalId) || typeof target.terminalToken !== 'string' || !/^%\d{1,10}:\d{1,10}$/.test(target.terminalToken)) return Promise.reject(failure('终端目标无效', 400));
        return new Promise((resolve, reject) => {
          const id = ++targetSequence, abort = () => close('target-unknown');
          targetPending = { id, target, peer, resolve, reject, signal, abort, timer: setTimeout(abort, 8000) };
          signal?.addEventListener('abort', abort, { once: true }); pause(true); claiming = true;
          if (peer.kind === 'relay') {
            // Retire probes admitted for the previous pane. Their completion
            // cannot race a target change on the retained relay connection.
            clearTimeout(directTimer); directTimer = undefined; clearTimeout(promotionTimer);
            directController?.abort(); const candidate = peers.get('direct'); if (candidate) lost(candidate);
          }
          try { send(peer, { type: 'switch-terminal', id, epoch, input: sent, target }); } catch { close('target-unknown'); }
        });
      }
      if (peer.kind !== 'direct' || !peer.panel || !['state', 'terminals'].includes(action) || [...panelRequests.values()].some(p => p.action === action) || panelSequence >= 2147483647) return Promise.reject(failure('该直连查询正在处理或不受支持', 429));
      return new Promise((resolve, reject) => {
        const id = ++panelSequence, abort = () => finishPanel(id, failure('直连查询已取消'));
        panelRequests.set(id, { action, peer, epoch, resolve, reject, signal, abort, timer: setTimeout(() => finishPanel(id, failure('直连查询超时', 504)), 5000) }); signal?.addEventListener('abort', abort, { once: true });
        try { send(peer, { type: 'panel', id, epoch, action }); } catch { finishPanel(id, failure('直连查询未发送')); }
      });
    },
    send(data) {
      if (!active || claiming || ended || !opened) throw new Error('session paused');
      const bytes = terminal ? new TextEncoder().encode(data + '\n') : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      if (!bytes.length || bytes.length > 128 * 1024 || inputSizes.size >= 64 || inputBytes + bytes.length > 128 * 1024) { close('input-pressure'); throw new Error('input pressure'); }
      const id = ++sent, parts = Math.ceil(bytes.length / CHUNK); inputSizes.set(id, bytes.length); inputBytes += bytes.length;
      try { for (let part = 0; part < parts; part++) send(active, { type: 'input', epoch, id, part, parts, data: encode(bytes.subarray(part * CHUNK, (part + 1) * CHUNK)) }); }
      catch { lost(active); }
    },
  });
  Object.defineProperties(socket, { readyState: { enumerable: true, get: () => ended ? 3 : opened ? 1 : 0 }, direct: { enumerable: true, get: () => active?.kind === 'direct' }, panelReady: { get: () => !ended && active?.kind === 'direct' && active.panel === true }, terminalSwitch: { get: () => !!terminal && !ended && active?.ready === true && active.terminalSwitch === true }, bufferedAmount: { enumerable: true, get: () => inputBytes + (active?.buffered() || 0) } });
  for (const name of ['online', 'offline']) window.addEventListener(name, wake);
  navigator.connection?.addEventListener('change', wake); document.addEventListener('visibilitychange', wake);
  return { socket, start() { ensureRelay(); scheduleDirect(0); }, close, wake,
    get paused() { return isPaused; }, get transport() { return active?.transport || null; }, get idle() { return inputAck === sent; } };
}
