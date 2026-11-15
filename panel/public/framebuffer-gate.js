const installations = new WeakMap();
export const FRAME_RESUME_TIMEOUT = 6000, FRAME_COVERAGE_PIXELS = 4096 * 4096;

function requests(messages) {
  let installation = installations.get(messages);
  if (installation) return installation;
  const original = messages.fbUpdateRequest, gates = new WeakMap();
  if (typeof original !== 'function') throw Error('Unsupported noVNC frame requests');
  messages.fbUpdateRequest = function (socket, ...args) {
    if (!gates.get(socket)?.suppressed()) return original.call(this, socket, ...args);
  };
  installation = { original, gates }; installations.set(messages, installation); return installation;
}
const bits = value => { value -= (value >>> 1) & 0x55555555; value = (value & 0x33333333) + ((value >>> 2) & 0x33333333); return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24; };

// Adapter for pinned noVNC 1.7.0. Never pause its byte stream or its ACKs:
// finish decoding in-flight updates, then gate requests at protocol boundaries.
// Resume coverage uses at most 2 MiB, discarded on completion/park/close.
export function createFramebufferGate(rfb, messages, { changed = () => {}, failed = () => {} } = {}) {
  const originals = { rect: rfb._handleRect, update: rfb._framebufferUpdate, continuous: rfb._updateContinuousUpdates, normal: rfb._normalMsg };
  if (Object.values(originals).some(value => typeof value !== 'function') || typeof messages.enableContinuousUpdates !== 'function') throw Error('Unsupported noVNC frame decoder');
  const installation = requests(messages), socket = rfb._sock;
  let closed = false, initialized = false, standby = false, waiting = false, busy = false, refreshSent = false;
  let generation = 0, frameGeneration = 0, frameOpen = false, pixels = false, timer, coverage, painting = false;
  const suppressed = () => initialized && (standby || waiting);
  installation.gates.set(socket, { suppressed });
  function stopContinuous() {
    if (rfb._enabledContinuousUpdates) messages.enableContinuousUpdates(socket, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
    rfb._enabledContinuousUpdates = false;
  }
  function liveUpdates() {
    if (closed || standby || waiting || !initialized) return;
    if (rfb._supportsContinuousUpdates) { rfb._enabledContinuousUpdates = true; originals.continuous.call(rfb); }
    else installation.original.call(messages, socket, true, 0, 0, rfb._fbWidth, rfb._fbHeight);
  }
  function refresh() {
    if (closed || !waiting || busy || !initialized || refreshSent) return;
    clearTimeout(timer); timer = setTimeout(fail, FRAME_RESUME_TIMEOUT);
    stopContinuous(); refreshSent = true; coverage = null; painting = false;
    installation.original.call(messages, socket, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
  }
  function cover(x, y, width, height) {
    const columns = rfb._fbWidth, rows = rfb._fbHeight;
    if (![x, y, width, height, columns, rows].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > columns || y + height > rows) return;
    if (!coverage || coverage.width !== columns || coverage.height !== rows) coverage = { width: columns, height: rows, count: 0, words: null };
    if (coverage.count === columns * rows) return;
    if (x === 0 && y === 0 && width === columns && height === rows) { coverage.count = columns * rows; return; }
    if (columns * rows > FRAME_COVERAGE_PIXELS) return; // A full rectangle or bounded cold fallback is required.
    coverage.words ||= new Uint32Array(Math.ceil(columns * rows / 32));
    for (let row = y; row < y + height; row++) {
      let start = row * columns + x; const end = start + width;
      while (start < end) {
        const index = start >>> 5, offset = start & 31, length = Math.min(32 - offset, end - start);
        const mask = ((0xffffffff >>> (32 - length)) << offset) >>> 0;
        coverage.count += bits(mask & ~coverage.words[index]); coverage.words[index] |= mask; start += length;
      }
    }
  }
  rfb._handleRect = function () {
    const { x, y, width, height, encoding } = this._FBU, complete = originals.rect.call(this);
    if (complete && (encoding >= 0 || encoding === -260) && width > 0 && height > 0) {
      pixels = true;
      if (waiting && refreshSent && !busy && frameGeneration === generation && encoding !== 1) cover(x, y, width, height);
    }
    return complete;
  };
  rfb._framebufferUpdate = function () {
    if (!frameOpen) { frameOpen = true; frameGeneration = generation; pixels = false; }
    const complete = originals.update.call(this);
    if (!complete) return complete;
    frameOpen = false;
    if (!initialized && pixels) { initialized = true; if (standby || waiting) stopContinuous(); changed(); refresh(); }
    if (waiting && refreshSent && !busy && !painting && coverage && coverage.count === coverage.width * coverage.height) {
      const version = generation; painting = true;
      void this._display.flush().then(() => {
        if (closed || standby || busy || version !== generation) return;
        waiting = false; painting = false; coverage = null; clearTimeout(timer); changed(); liveUpdates();
      }, () => { if (!closed && version === generation) fail(); });
    }
    return complete;
  };
  rfb._updateContinuousUpdates = function () {
    if (suppressed()) { this._enabledContinuousUpdates = false; return; }
    return originals.continuous.call(this);
  };
  rfb._normalMsg = function () {
    const end = this._FBU.rects === 0 && this._sock.rQpeek8() === 150, complete = originals.normal.call(this);
    // A late EndOfContinuousUpdates must not leave a resumed viewer dormant.
    if (complete && end) { if (suppressed()) this._enabledContinuousUpdates = false; else liveUpdates(); }
    return complete;
  };
  function close() {
    if (closed) return;
    closed = true; generation++; clearTimeout(timer); coverage = null; installation.gates.delete(socket);
    rfb._handleRect = originals.rect; rfb._framebufferUpdate = originals.update; rfb._updateContinuousUpdates = originals.continuous; rfb._normalMsg = originals.normal;
  }
  function fail() { close(); failed(); }
  return {
    get blocked() { return closed || !initialized || standby || waiting; },
    setStandby(value, options = {}) {
      if (closed) return;
      const nextBusy = options.busy === true;
      if (value !== standby) {
        standby = value; generation++; coverage = null; refreshSent = painting = false; clearTimeout(timer);
        waiting = !standby;
        if (initialized) stopContinuous();
        changed();
      }
      if (waiting && nextBusy && !busy) { clearTimeout(timer); generation++; refreshSent = painting = false; coverage = null; }
      busy = nextBusy; refresh();
    },
    close,
  };
}
