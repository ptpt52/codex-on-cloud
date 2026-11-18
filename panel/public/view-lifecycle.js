import { createRoundTrip } from './health.js';

const terminalKey = value => typeof value === 'string' && /^(?:main|aux[1-7]):%\d{1,10}:\d{1,10}$/.test(value);
function view(element, epoch, mode = 'desktop', key = '', noticeTarget = '') {
  return { element, epoch, mode, key, desiredKey: key, noticeTarget, loaded: false, state: 'idle', transport: '', paused: false,
    moduleReady: false, firstFrame: false, probe: '', probeReason: '',
    panelReady: false, panelCapabilitiesKnown: false, terminalSwitchReady: false, terminalCreateReady: false, terminalOpenReady: false, terminalAttachment: false, attachmentState: '',
    dimensions: null, geometry: null, scale: 0, scaleRevision: -1, reviewing: false, composing: false, touchInput: false,
    nativeIdle: false, resizeReady: false, frameReady: mode !== 'desktop', activationPending: false, inputNoticeKey: '', network: null, issue: '', latency: createRoundTrip() };
}
function invalidate(entry) {
  entry.panelReady = entry.panelCapabilitiesKnown = entry.terminalSwitchReady = entry.terminalCreateReady = entry.terminalOpenReady = false;
}
const validSize = (value, max) => Number.isInteger(value) && value > 0 && value <= max;
function network(value) {
  const endpoint = value => value && (value.address === null || typeof value.address === 'string' && value.address.length <= 253 && /^[a-zA-Z0-9:.%-]+$/.test(value.address)) && (value.port === null || validSize(value.port, 65535));
  if (!value || !['IPv4', 'IPv6', 'unknown'].includes(value.family) || !['UDP', 'TCP', 'unknown'].includes(value.protocol) || !endpoint(value.local) || !endpoint(value.remote) || !(value.rttMs === null || Number.isInteger(value.rttMs) && value.rttMs >= 0 && value.rttMs <= 600000)) return null;
  const copy = value => ({ address: value.address, port: value.port, type: ['host', 'srflx', 'prflx', 'relay'].includes(value.type) ? value.type : 'unknown' });
  return { family: value.family, protocol: value.protocol, rttMs: value.rttMs, local: copy(value.local), remote: copy(value.remote) };
}

// Exactly one foreground view and at most one parked view. A swap moves the
// record itself; target, geometry and capabilities have one source of truth.
// This controller owns no task, network retry, input queue or replay policy.
export function createViewLifecycle(element) {
  let serial = 0, active = view(element, serial), standby = null;
  const live = entry => entry === active || !!standby && entry === standby;
  const canSwap = (mode, key) => !!standby && standby.mode === mode && active.loaded &&
    !(mode === 'terminal' && standby.key !== key && (standby.state !== 'connected' || standby.paused || !standby.terminalSwitchReady));
  return {
    get active() { return active; }, get standby() { return standby; },
    match(source, epoch) { return [active, standby].find(entry => entry?.loaded && entry.element.contentWindow === source && String(entry.epoch) === epoch) || null; },
    reset(mode, element = active.element) {
      if (standby) throw Error('dispose standby before resetting active view');
      const dimensions = active.dimensions;
      active = view(element, ++serial, mode); active.dimensions = dimensions;
    },
    begin(mode, key = '') {
      active.mode = mode; active.frameReady = mode !== 'desktop'; active.key = active.desiredKey = key; active.loaded = true; active.state = 'connecting';
      return active;
    },
    prepare(element, mode, key = '', noticeTarget = '') {
      if (standby || mode === active.mode) throw Error('only one other mode can be parked');
      standby = view(element, ++serial, mode, key, noticeTarget); standby.loaded = true; standby.state = 'connecting'; return standby;
    },
    discard() { const previous = standby; standby = null; return previous; },
    invalidate(entry = active) { if (live(entry)) invalidate(entry); },
    suspend() {
      invalidate(active); active.state = 'reconnecting'; active.paused = false;
      active.firstFrame = false; active.probe = 'retrying'; active.probeReason = '';
      active.nativeIdle = active.resizeReady = active.composing = active.touchInput = active.activationPending = false;
      if (active.mode === 'desktop') active.frameReady = false;
      active.latency.clear();
    },
    canSwap,
    swap(mode, key, noticeTarget = '') {
      if (!canSwap(mode, key)) return false;
      const previous = active; active = standby; standby = previous; standby.noticeTarget = noticeTarget;
      if (mode === 'terminal' && terminalKey(key)) active.desiredKey = key;
      active.composing = active.touchInput = active.nativeIdle = active.resizeReady = false;
      if (mode === 'desktop') active.frameReady = false;
      active.network = null; active.issue = ''; active.latency.clear();
      if (active.state !== 'connected') invalidate(active);
      return true;
    },
    requestTarget(entry, key) { if (!live(entry) || entry.mode !== 'terminal' || !terminalKey(key)) return false; entry.desiredKey = key; return true; },
    confirmTarget(entry, key) {
      if (!live(entry) || entry.desiredKey !== key || !terminalKey(key)) return false;
      entry.key = key; entry.geometry = null; entry.reviewing = false; return true;
    },
    cancelTarget(entry) { if (live(entry)) entry.desiredKey = entry.key; },
    inputReady(entry = active) { return entry === active && entry.loaded && entry.state === 'connected' && !entry.paused && entry.frameReady && !entry.activationPending && entry.key === entry.desiredKey && (!entry.terminalAttachment || entry.attachmentState === 'ready'); },
    update(entry, value, { revision, fontSize, terminalSwitching = false, issues = [], probeReasons = [] } = {}) {
      if (!live(entry)) return false;
      if (value.type === 'codex-desktop' && value.state === 'ready') entry.moduleReady = true;
      else if (value.type === 'codex-view-first-frame') entry.firstFrame = true;
      else if (value.type === 'codex-connection-progress') {
        if (!['probing', 'gathering', 'queued', 'signaling', 'connecting', 'ready', 'retrying', 'stopped'].includes(value.probe)) return false;
        entry.probe = value.probe; entry.probeReason = probeReasons.includes(value.probeReason) ? value.probeReason : '';
      } else if (value.type === 'codex-desktop' && ['connected', 'connecting', 'disconnected'].includes(value.state)) {
        if (value.state === 'connected') {
          const transport = value.transport === 'direct' ? 'direct' : entry.mode === 'terminal' ? 'terminal' : 'relay';
          if (entry.state !== 'connected' || entry.transport !== transport) entry.latency.clear();
          entry.state = 'connected'; entry.transport = transport;
        } else {
          entry.state = value.state === 'disconnected' || entry.state === 'reconnecting' ? 'reconnecting' : 'connecting';
          entry.firstFrame = false;
          invalidate(entry); entry.latency.clear(); entry.scaleRevision = -1;
          entry.frameReady = entry.mode !== 'desktop'; entry.resizeReady = entry.nativeIdle = false;
        }
      } else if (value.type === 'codex-panel-state') {
        const connected = entry.state === 'connected';
        entry.panelCapabilitiesKnown = connected && !entry.paused;
        entry.panelReady = connected && entry.transport === 'direct' && value.ready === true;
        entry.terminalSwitchReady = connected && entry.mode === 'terminal' && value.terminalSwitch === true;
        entry.terminalCreateReady = connected && entry.mode === 'terminal' && value.terminalCreate === true;
        entry.terminalOpenReady = connected && entry.mode === 'desktop' && value.terminalOpen === true;
        if (entry.mode === 'terminal' && value.terminalAttachment === true) {
          entry.terminalAttachment = true;
          if (['idle', 'attaching', 'ready', 'exited', 'failed'].includes(value.attachmentState)) entry.attachmentState = value.attachmentState;
        }
      } else if (value.type === 'codex-terminal-attachment' && entry.mode === 'terminal' && ['idle', 'attaching', 'ready', 'exited', 'failed', 'expired'].includes(value.state)) {
        entry.terminalAttachment = true; entry.attachmentState = value.state;
        if (value.state === 'expired') entry.state = 'idle';
      } else if (value.type === 'codex-stream-state' && typeof value.paused === 'boolean') {
        // Target admission has its own busy guard; it must not block itself
        // by being treated as an unrelated route handoff.
        entry.paused = value.paused && !(entry === active && terminalSwitching && value.terminalSwitch === true);
        if (value.paused) entry.panelCapabilitiesKnown = false;
      } else if (value.type === 'codex-terminal-size' && entry.mode === 'terminal' && validSize(value.cols, 500) && value.cols >= 2 && validSize(value.rows, 200)) {
        entry.geometry = { cols: value.cols, rows: value.rows, fontSize: Number.isFinite(value.fontSize) && value.fontSize >= 10 && value.fontSize <= 112 ? value.fontSize : fontSize };
      } else if (value.type === 'codex-terminal-history' && entry.mode === 'terminal' && typeof value.reviewing === 'boolean') entry.reviewing = value.reviewing;
      else if (value.type === 'codex-desktop-view' && value.revision === revision) {
        entry.nativeIdle = value.idle === true;
        if (typeof value.frameReady === 'boolean') entry.frameReady = value.frameReady;
        if (typeof value.resizeReady === 'boolean') entry.resizeReady = value.resizeReady;
        if (Number.isFinite(value.scale) && value.scale > 0 && value.scale <= 16) { entry.scale = value.scale; entry.scaleRevision = value.revision; }
        if (validSize(value.width, 16384) && validSize(value.height, 16384)) entry.dimensions = { width: value.width, height: value.height };
      } else if (value.type === 'codex-transport') {
        if (typeof value.issue === 'string' && (issues.includes(value.issue) || value.issue === '')) entry.issue = value.issue;
        entry.network = network(value.details); entry.latency.set(value.rttMs);
      } else return false;
      return true;
    },
  };
}
