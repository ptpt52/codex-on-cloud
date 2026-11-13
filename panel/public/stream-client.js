import { desktopTransport, canTryDirect } from './rtc.js';
import { controlDecoder, sendControl } from '/control.js';
import { routePolicy, STABLE_ROUTE, directRetry } from './transport-policy.js';
import { TERMINAL_IDS } from '/terminal-slots.js';
import { createRoundTrip, createHeartbeatPolicy } from '/health.js';
import { nodeURL } from '/node-scope.js';

const CHUNK = 12 * 1024, integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2 ** 40;
const encode = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

// One browser-visible channel. Network paths may change; the consumer and its
// parser stay attached. Only downstream bytes can be replayed, never inputs.
export function createStreamClient({ viewer, csrf, terminal, standby = false, bootstrap, idle = () => true, settled = idle, targetIdle = settled, canSwitchTarget = targetIdle, prepare = async () => true, paused = () => {}, changed = () => {}, measured = () => {}, issue = () => {}, trace = () => {} }) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const socket = new EventTarget(), peers = new Map(), routes = routePolicy(), inputSizes = new Map();
  let active, ended = false, opened = false, out = 0, epoch = 0, sent = 0, inputAck = 0, inputBytes = 0, isPaused = false, claiming = false, transitioning = false, prepareSequence = 0;
  let relayTimer, directTimer, directDue = 0, promotionTimer, recoveryTimer, directController, relayDelay = 250, probeDelay = 15000, terminalText = '';
  let heldOutput = [], heldBytes = 0;
  let directExpedited = false, directHalted = false, directAttempts = 0, pauseTerminal = false;
  let lastPath = '';
  let textDecoder = new TextDecoder('utf-8', { fatal: true }), panelSequence = 0, targetSequence = 0, targetPending;
  const panelRequests = new Map();
  const failure = (message, status = 409) => Object.assign(new Error(message), { status, outcome: 'rejected' });
  const creating = () => [...panelRequests.values()].some(p => ['create-terminal', 'open-terminal'].includes(p.action));
  const panelFailure = (action, message, status = 409, outcome) => Object.assign(failure(message, status), { outcome: outcome || (['create-terminal', 'open-terminal'].includes(action) ? 'unknown' : 'rejected') });
  const switchBusy = message => Object.assign(failure(message), { code: 'terminal_switch_busy' });
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
  function cancelTarget(error) {
    const held = heldOutput;
    finishTarget(error);
    for (const [peer, value] of held) receive(peer, value);
  }
  async function prepareTarget(pending) {
    // One admitted selection, at most 1.5 seconds, no network switch sent yet.
    // Hold old output within the existing byte/count limits so continuous
    // rendering and its acknowledgments cannot keep the terminal busy forever.
    const deadline = performance.now() + 1500, { peer, signal } = pending;
    while (targetPending === pending && !pending.sent) {
      if (ended || active !== peer || peer.gone || !peer.writable() || document.hidden || !navigator.onLine || signal?.aborted || !canSwitchTarget()) {
        cancelTarget(switchBusy('当前操作或连接已变化，切换未发送；准备好后请再点目标终端')); return;
      }
      if (performance.now() >= deadline) {
        cancelTarget(switchBusy('终端仍在处理，切换未发送；稍后请再点目标终端')); return;
      }
      if (targetIdle() && inputAck === sent) {
        pending.sent = true; claiming = true;
        pending.timer = setTimeout(pending.abort, 8000);
        try { send(peer, { type: 'switch-terminal', id: pending.id, epoch, input: sent, target: pending.target }); }
        catch { close('target-unknown'); }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  function emit(type, data) {
    const event = ['message', 'target'].includes(type) ? new MessageEvent(type, { data }) : new Event(type);
    socket[`on${type}`]?.(event); socket.dispatchEvent(event);
  }
  function pause(value) {
    value ||= active?.heartbeatPaused === true;
    const terminalSwitch = value && !!targetPending;
    if (value !== isPaused || terminalSwitch !== pauseTerminal) { isPaused = value; pauseTerminal = terminalSwitch; paused(value, { terminalSwitch }); }
  }
  function send(peer, value) {
    if (!peer || peer.gone || !peer.writable() || peer.buffered() > 256 * 1024) throw new Error('path unavailable'); peer.send(value);
  }
  function close(reason = '') {
    if (ended) return;
    const uncertainTarget = targetPending?.sent === true;
    if (uncertainTarget) reason = 'target-unknown';
    socket.lastError = reason; trace('session-ended', { reason: reason || 'closed', queuedBytes: inputBytes });
    if (['input-unknown', 'input-pressure', 'target-unknown'].includes(reason)) parent.postMessage({ type: 'codex-stream-reset', frame: new URLSearchParams(location.search).get('frame'), reason, eventId: id, path: active?.kind || lastPath }, location.origin);
    for (const peer of peers.values()) { try { if (peer.ready) send(peer, { type: 'end' }); } catch {} }
    ended = true; directController?.abort();
    for (const [id, pending] of panelRequests) finishPanel(id, panelFailure(pending.action, '连接已关闭，操作结果请核对终端列表'));
    finishTarget(uncertainTarget ? failure('终端切换结果未知，请重新选择') : switchBusy('连接已关闭，切换未发送；恢复后请再点目标终端'));
    for (const timer of [relayTimer, directTimer, promotionTimer, recoveryTimer]) clearTimeout(timer);
    for (const peer of peers.values()) { peer.gone = true; clearTimeout(peer.timer); clearTimeout(peer.deadline); clearTimeout(peer.startTimer); peer.wait?.reject(new Error('closed')); peer.prepareWait?.reject(new Error('closed')); peer.close(); }
    peers.clear(); active = undefined; inputSizes.clear(); terminalText = ''; pause(false);
    for (const name of ['online', 'offline']) window.removeEventListener(name, wake);
    navigator.connection?.removeEventListener('change', wake); document.removeEventListener('visibilitychange', wake);
    emit('close');
  }
  function healthy(peer) { return peer?.ready && !peer.gone && !peer.health.suspect && peer.writable() && performance.now() - peer.healthyAt <= 10000; }
  function lost(peer, reason = 'closed') {
    if (!peer || peer.gone || ended) return;
    for (const [id, pending] of panelRequests) if (pending.peer === peer) finishPanel(id, panelFailure(pending.action, '连接已中断，操作结果请核对终端列表'));
    if (targetPending?.peer === peer) {
      if (targetPending.sent) { close('target-unknown'); return; }
      // The old target remains authoritative; normal route recovery resumes
      // it, without retrying this selection or classifying it as committed.
      finishTarget(switchBusy('连接正在恢复，切换未发送；恢复后请再点目标终端'));
    }
    trace('path-lost', { path: peer.kind, reason, queuedBytes: inputBytes + peer.buffered() });
    peer.gone = true; clearTimeout(peer.timer); clearTimeout(peer.deadline); clearTimeout(peer.startTimer); peer.wait?.reject(new Error('path lost')); peer.prepareWait?.reject(new Error('path lost'));
    if (peers.get(peer.kind) === peer) peers.delete(peer.kind); peer.close();
    if (active === peer) {
      active = undefined; claiming = false; pause(true); changed();
      if (peer.kind === 'direct') { routes.changed(); issue(reason === 'heartbeat' ? 'heartbeat' : 'connection'); }
      recoveryTimer ??= setTimeout(() => close('resume-timeout'), 12000);
      const backup = peers.get('relay');
      if (healthy(backup)) void activate(backup);
      else { if (backup?.ready) heartbeat(backup, 0); ensureRelay(); }
    }
    if (peer.kind === 'relay') ensureRelay(); else scheduleDirect();
  }
  function ping(peer) {
    if (peer.gone || ended || !peer.ready || peer.ping) return;
    const nonce = ++peer.nonce; peer.ping = nonce;
    const timeout = peer.health.suspect ? peer.health.confirmationMs : peer.health.timeoutMs;
    peer.deadline = setTimeout(() => {
      trace('heartbeat-timeout', { path: peer.kind, durationMs: timeout, queuedBytes: peer.buffered() });
      peer.latency.clear(); if (peer === active) measured();
      const alternate = [...peers.values()].some(other => other !== peer && healthy(other));
      if (peer.health.miss() === 1 && !alternate && peer.writable()) {
        peer.ping = 0;
        if (peer === active) { peer.heartbeatPaused = true; pause(true); if (peer.kind === 'direct') issue('heartbeat-suspect'); }
        ping(peer);
      } else lost(peer, 'heartbeat');
    }, timeout);
    peer.sentAt = performance.now();
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
        peer.terminalCreate = value.terminalCreate === 1;
        peer.terminalOpen = value.terminalOpen === 1;
        peer.terminalSwitch = value.terminalSwitch === 1 && (peer.kind === 'direct' || value.terminalSwitchRelay === 1);
        if (!peer.ready) trace(peer.kind === 'relay' ? 'relay-ready' : 'direct-ready', { path: peer.kind, durationMs: Math.round(performance.now() - peer.startedAt) });
        peer.ready = true; peer.healthyAt = performance.now(); clearTimeout(peer.startTimer); heartbeat(peer);
        if (peer.prepareWait || peer.wait?.handoff !== undefined) { peer.prepareWait?.reject(new Error('busy')); peer.wait?.reject(new Error('busy')); return; }
        if (peer.wait && claiming) { send(peer, { type: 'activate', epoch: value.epoch, out, input: sent }); return; }
        peer.welcome?.(); if (!active && !claiming) void activate(peer); return;
      }
      if (value.type === 'pong') {
        if (!integer(value.id) || !peer.ping || value.id !== peer.ping) return;
        const wasHeartbeatPaused = peer.heartbeatPaused; peer.heartbeatPaused = false;
        peer.latency.set(performance.now() - peer.sentAt); peer.health.sample(performance.now() - peer.sentAt);
        peer.healthyAt = performance.now();
        clearTimeout(peer.deadline); peer.ping = 0; heartbeat(peer);
        if (peer.networkProbePending) { peer.networkProbePending = false; peer.networkProbe = true; directExpedited = false; if (active !== peer) void promote(peer); }
        if (peer === active) {
          if (wasHeartbeatPaused && !transitioning && !targetPending && !claiming) { pause(false); if (peer.kind === 'direct') issue(''); }
          measured();
        } else if (!active && !claiming) void activate(peer);
        return;
      }
      if (value.type === 'reset') return close(value.reason || 'session-reset');
      if (value.type === 'panel-result') {
        const pending = panelRequests.get(value.id);
        if (!pending || pending.peer !== peer || pending.epoch !== value.epoch || peer !== active || value.epoch !== epoch) return;
        finishPanel(value.id, value.ok === true ? null : panelFailure(pending.action, value.error?.message || '连接操作失败', value.error?.status, value.error?.outcome), value.value); return;
      }
      if (value.type === 'switched') {
        const pending = targetPending;
        if (!pending || pending.peer !== peer || pending.id !== value.id || !integer(value.epoch) || value.epoch <= epoch || !integer(value.out) || value.out < out || value.input !== sent || value.target?.terminalId !== pending.target.terminalId || value.target?.terminalToken !== pending.target.terminalToken) throw new Error();
        epoch = value.epoch; out = value.out; inputAck = sent; peer.epoch = epoch;
        inputSizes.clear(); inputBytes = 0; terminalText = ''; textDecoder = new TextDecoder('utf-8', { fatal: true }); Object.assign(terminal, value.target);
        for (const id of [...panelRequests.keys()]) finishPanel(id, failure('终端查看目标已变化'));
        directHalted = false; directAttempts = 0; probeDelay = 15000;
        emit('target', value.target); finishTarget(null, value.target);
        for (const other of [...peers.values()]) if (other !== peer) lost(other);
        changed(); ensureRelay(); return;
      }
      if (value.type === 'switch-result' && targetPending?.peer === peer && targetPending.id === value.id && value.epoch === epoch && value.ok === false) {
        cancelTarget(failure(value.error?.message || '终端暂不可切换', value.error?.status)); return;
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
        trace('path-active', { path: peer.kind, queuedBytes: inputBytes });
        epoch = value.epoch; active = peer; lastPath = peer.kind; peer.epoch = epoch; inputAck = value.input; inputSizes.clear(); inputBytes = 0;
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
      if (claiming || targetPending) {
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
    if (ended || transitioning || creating() || peer.gone || !peer.ready || peer.health.suspect || active === peer || document.hidden || !navigator.onLine) return false;
    transitioning = true;
    let approved = false, heldPeer, handoff, committing = false; const wasOpened = opened, previous = active;
    try {
      if (planned) {
        if (!idle() || inputAck !== sent || peer.networkProbePending || routes.remaining() && !peer.networkProbe) return false;
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
      peer.networkProbe = false;
      if (peer.kind === 'direct') directExpedited = false;
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
  function peerFor(kind, send, close, buffered, deferred = false, writable = () => true) {
    const peer = { kind, startedAt: performance.now(), send, close, buffered, writable, ready: false, gone: false, epoch: 0, nonce: 0, ping: 0, latency: createRoundTrip(), health: createHeartbeatPolicy() };
    if (!deferred) peer.startTimer = setTimeout(() => lost(peer), 12000); peers.set(kind, peer); return peer;
  }
  function ensureRelay() {
    if (ended || peers.has('relay') || relayTimer || document.hidden || !navigator.onLine) return;
    relayTimer = setTimeout(() => {
      relayTimer = undefined;
      if (ended || peers.has('relay') || document.hidden || !navigator.onLine) return;
      const url = new URL('/session/connect', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      for (const [key, value] of Object.entries({ viewer, streamId: id, mode: terminal ? 'terminal' : 'desktop', ...(standby ? { standby: '1' } : {}), ...(terminal || {}) })) url.searchParams.set(key, value);
      trace('relay-start', { path: 'relay' });
      const ws = new WebSocket(nodeURL(url)), peer = peerFor('relay', value => ws.send(JSON.stringify(value)), () => ws.close(), () => ws.bufferedAmount, false, () => ws.readyState === WebSocket.OPEN);
      ws.addEventListener('open', () => { trace('relay-open', { path: 'relay', durationMs: Math.round(performance.now() - peer.startedAt) }); if (!ended && !peer.gone) ws.send(JSON.stringify({ type: 'auth', csrf })); });
      ws.addEventListener('message', event => { try { if (typeof event.data !== 'string' || event.data.length > 24576) throw new Error(); receive(peer, JSON.parse(event.data)); } catch { lost(peer); } });
      ws.addEventListener('close', () => lost(peer)); ws.addEventListener('error', () => lost(peer));
      relayDelay = Math.min(4000, relayDelay * 2);
    }, opened ? relayDelay : 0);
  }
  function scheduleDirect(delay = probeDelay) {
    if (ended || directHalted || targetPending || directController || peers.has('direct') || !canTryDirect() || document.hidden || !navigator.onLine || active?.kind === 'direct') return;
    const wait = directExpedited ? Math.max(Math.min(delay, 1000), routes.networkWait()) : Math.max(delay, routes.remaining()), due = performance.now() + wait;
    if (directTimer && directDue <= due) return;
    clearTimeout(directTimer); directDue = due;
    trace('retry', { path: 'direct', waitMs: Math.round(wait) });
    directTimer = setTimeout(() => { directTimer = undefined; void connectDirect(); }, wait);
  }
  async function promote(peer) {
    if (ended || targetPending || peer.gone || peer.health.suspect || active === peer || document.hidden || !navigator.onLine) return;
    if (!active || (idle() && !peer.networkProbePending && (!routes.remaining() || peer.networkProbe))) await activate(peer, !!active);
    if (!ended && !peer.gone && active !== peer) { clearTimeout(promotionTimer); promotionTimer = setTimeout(() => void promote(peer), Math.max(1000, peer.networkProbe ? 0 : routes.remaining())); }
  }
  async function connectDirect() {
    if (ended || directHalted || targetPending || directController || peers.has('direct') || document.hidden || !navigator.onLine || !canTryDirect()) return;
    trace('direct-start', { path: 'direct' });
    const expedited = directExpedited; directExpedited = false;
    if (expedited) routes.networkProbeStarted();
    const controller = directController = new AbortController(); let transport, peer, failureReason = 'negotiation';
    try {
      transport = await desktopTransport(viewer, live => { if (!live && peer) lost(peer); }, { probe: true, signal: controller.signal, terminal, streamId: id, standby, bootstrap, failed: reason => { failureReason = reason; issue(reason); }, trace });
      if (!transport) throw new Error();
      const channel = transport.video(); channel.binaryType = 'arraybuffer';
      peer = peerFor('direct', value => sendControl(channel, value), () => transport.close(), () => channel.bufferedAmount, true, () => channel.readyState === 'open'); peer.transport = transport;
      peer.networkProbe = expedited;
      const decoder = controlDecoder(value => receive(peer, value), () => lost(peer));
      channel.addEventListener('message', event => { if (!peer.gone) decoder.push(event.data); }); channel.addEventListener('close', () => lost(peer)); channel.addEventListener('error', () => lost(peer));
      await transport.start(); await transport.control.request('ping', {});
      if (active) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, STABLE_ROUTE); controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); });
      if (ended || peer.gone || controller.signal.aborted) throw new Error();
      await transport.control.request('ping', {}); await transport.control.request('activate', {});
      await new Promise((resolve, reject) => { peer.welcome = resolve; transport.viewerReady(); const timer = setTimeout(() => reject(new Error('no standby')), 3000); peer.welcome = () => { clearTimeout(timer); resolve(); }; });
      peer.networkProbe ||= directExpedited; directExpedited = false;
      directAttempts = 0; probeDelay = 15000; void promote(peer);
    } catch (error) {
      if (peer) lost(peer); else transport?.close();
      if (!controller.signal.aborted) {
        const retry = directRetry(error?.reason || failureReason, directAttempts++);
        directHalted = retry.stop; probeDelay = retry.delay;
      }
    }
    finally { if (directController === controller) directController = undefined; scheduleDirect(); }
  }
  function wake(event) {
    if (ended) return;
    trace('network-change', { reason: document.hidden ? 'hidden' : !navigator.onLine ? 'offline' : event?.type === 'visibilitychange' ? 'visible' : event?.type === 'online' ? 'online' : 'changed' });
    if (document.hidden || !navigator.onLine) {
      directExpedited = false;
      if (targetPending && !targetPending.sent) cancelTarget(switchBusy('页面已隐藏或离线，切换未发送；返回后请再点目标终端'));
      clearTimeout(directTimer); directTimer = undefined;
      clearTimeout(relayTimer); relayTimer = undefined;
      for (const peer of peers.values()) { clearTimeout(peer.timer); peer.timer = undefined; clearTimeout(peer.deadline); peer.ping = 0; peer.latency.clear(); peer.health.cancel(); }
      measured();
      if (!navigator.onLine) for (const peer of [...peers.values()]) lost(peer);
      return;
    }
    for (const peer of peers.values()) if (peer.ready && !peer.ping) heartbeat(peer, 250);
    if (active?.kind !== 'direct') {
      directExpedited = true;
      const candidate = peers.get('direct'); if (candidate?.ready) candidate.networkProbePending = true;
    }
    ensureRelay(); scheduleDirect(1000); const direct = peers.get('direct'); if (direct?.ready) void promote(direct);
  }
  Object.assign(socket, { binaryType: 'arraybuffer', protocol: '', onopen: null, onclose: null, onmessage: null, onerror: null, session: true,
    close: () => close(), reconnect: () => lost(active), stats: async () => active?.transport?.stats() || null,
    panelRequest(action, body = {}, signal) {
      const peer = active;
      if (ended || !peer?.ready || signal?.aborted) return Promise.reject(failure('会话通道未就绪'));
      if (!peer.writable()) { lost(peer); return Promise.reject(failure('连接正在关闭，本次操作未发送')); }
      if (action === 'switch-terminal') {
        if (!terminal || !peer.terminalSwitch || targetPending || creating() || transitioning || claiming || !canSwitchTarget() || targetSequence >= 2147483647) return Promise.reject(switchBusy('终端仍有操作进行中，切换未发送；完成后请再点目标终端'));
        const target = { terminalId: body.terminalId, terminalToken: body.terminalToken };
        if (!TERMINAL_IDS.includes(target.terminalId) || typeof target.terminalToken !== 'string' || !/^%\d{1,10}:\d{1,10}$/.test(target.terminalToken)) return Promise.reject(failure('终端目标无效', 400));
        return new Promise((resolve, reject) => {
          const id = ++targetSequence, abort = () => {
            if (targetPending?.id !== id) return;
            if (targetPending.sent) close('target-unknown');
            else cancelTarget(switchBusy('切换已取消且未发送；需要时请再点目标终端'));
          };
          const pending = targetPending = { id, target, peer, resolve, reject, signal, abort, sent: false };
          signal?.addEventListener('abort', abort, { once: true }); pause(true);
          if (peer.kind === 'relay') {
            // Retire probes admitted for the previous pane. Their completion
            // cannot race a target change on the retained relay connection.
            clearTimeout(directTimer); directTimer = undefined; clearTimeout(promotionTimer);
            directExpedited = false;
            directController?.abort(); const candidate = peers.get('direct'); if (candidate) lost(candidate);
          }
          void prepareTarget(pending);
        });
      }
      const mutation = ['create-terminal', 'open-terminal'].includes(action);
      const capable = action === 'create-terminal' ? terminal && peer.terminalCreate : !terminal && peer.terminalOpen;
      if ((mutation ? !capable || creating() || targetPending || transitioning || claiming : peer.kind !== 'direct' || !peer.panel || !['state', 'terminals'].includes(action)) || [...panelRequests.values()].some(p => p.action === action) || panelSequence >= 2147483647) return Promise.reject(failure('连接操作正在处理或不受支持，本次未发送', 429));
      if (mutation && new TextEncoder().encode(JSON.stringify(body)).length > 1024) return Promise.reject(failure('终端操作参数超过 1 KiB，本次未发送', 413));
      return new Promise((resolve, reject) => {
        const id = ++panelSequence, abort = () => finishPanel(id, panelFailure(action, '连接请求已取消，操作结果请核对终端列表'));
        panelRequests.set(id, { action, peer, epoch, resolve, reject, signal, abort, timer: setTimeout(() => finishPanel(id, panelFailure(action, '连接请求超时，操作结果请核对终端列表', 504)), mutation ? 6500 : 5000) }); signal?.addEventListener('abort', abort, { once: true });
        try { send(peer, { type: 'panel', id, epoch, action, ...(mutation ? { body } : {}) }); } catch { finishPanel(id, panelFailure(action, '连接请求未完成')); }
      });
    },
    send(data) {
      const peer = active;
      if (!peer || claiming || ended || !opened) throw new Error('session paused');
      // CLOSING can be observable before the close event (notably WebKit).
      // No bytes were admitted: don't advance the sequence or fabricate an
      // unknown input on resume. Actual send failures remain unreplayed.
      if (!peer.writable()) { lost(peer); throw failure('连接正在关闭，本次操作未发送'); }
      const bytes = terminal ? new TextEncoder().encode(data + '\n') : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      if (!bytes.length || bytes.length > 128 * 1024 || inputSizes.size >= 64 || inputBytes + bytes.length > 128 * 1024) { close('input-pressure'); throw new Error('input pressure'); }
      const id = ++sent, parts = Math.ceil(bytes.length / CHUNK); inputSizes.set(id, bytes.length); inputBytes += bytes.length;
      try { for (let part = 0; part < parts; part++) send(peer, { type: 'input', epoch, id, part, parts, data: encode(bytes.subarray(part * CHUNK, (part + 1) * CHUNK)) }); }
      catch { lost(peer); }
    },
  });
  Object.defineProperties(socket, { readyState: { enumerable: true, get: () => ended ? 3 : opened ? 1 : 0 }, direct: { enumerable: true, get: () => active?.kind === 'direct' }, rttMs: { get: () => !ended && active?.ready && !active.gone ? active.latency.value : null }, panelReady: { get: () => !ended && active?.kind === 'direct' && active.panel === true }, terminalOpen: { get: () => !terminal && !ended && active?.ready === true && active.terminalOpen === true }, terminalCreate: { get: () => !!terminal && !ended && active?.ready === true && active.terminalCreate === true }, terminalSwitch: { get: () => !!terminal && !ended && active?.ready === true && active.terminalSwitch === true }, bufferedAmount: { enumerable: true, get: () => inputBytes + (active?.buffered() || 0) } });
  for (const name of ['online', 'offline']) window.addEventListener(name, wake);
  navigator.connection?.addEventListener('change', wake); document.addEventListener('visibilitychange', wake);
  return { socket, start() { ensureRelay(); scheduleDirect(0); }, close, wake,
    get paused() { return isPaused; }, get transport() { return active?.transport || null; }, get idle() { return inputAck === sent; } };
}
