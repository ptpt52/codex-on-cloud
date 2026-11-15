import test from 'node:test';
import assert from 'node:assert/strict';
import { createFramebufferGate, FRAME_RESUME_TIMEOUT } from '../panel/public/framebuffer-gate.js';
function setup({ continuous = false, flush = () => Promise.resolve(), failed } = {}) {
  const requests = [], controls = []; let changes = 0, marker = 0, rectangles = [];
  const messages = { fbUpdateRequest: (_, incremental) => requests.push(incremental), enableContinuousUpdates: (_, enabled) => controls.push(enabled) };
  const rfb = { _sock: { rQpeek8: () => marker }, _fbWidth: 8, _fbHeight: 4, _FBU: { rects: 0 }, _display: { flush },
    _supportsContinuousUpdates: continuous, _enabledContinuousUpdates: continuous,
    _handleRect() { return true; },
    _framebufferUpdate() { for (const rect of rectangles) { this._FBU = { ...rect, rects: 1 }; this._handleRect(); } this._FBU.rects = 0; return true; },
    _updateContinuousUpdates() { if (this._enabledContinuousUpdates) messages.enableContinuousUpdates(this._sock, true); },
    _normalMsg() { this._supportsContinuousUpdates = true; this._enabledContinuousUpdates = false; return true; },
  };
  const original = { ...rfb }, gate = createFramebufferGate(rfb, messages, { changed: () => changes++, failed });
  const frame = (rects = [{ x: 0, y: 0, width: 8, height: 4, encoding: 0 }]) => { rectangles = rects; rfb._framebufferUpdate(); messages.fbUpdateRequest(rfb._sock, true); };
  const end = () => { marker = 150; rfb._normalMsg(); marker = 0; };
  return { rfb, original, messages, gate, requests, controls, frame, end, get changes() { return changes; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('parked desktop decodes initial pixels, suppresses further requests and waits for focus before refreshing', async () => {
  const s = setup(); s.gate.setStandby(true); assert.equal(s.gate.blocked, true);
  s.frame(); assert.deepEqual(s.requests, []);
  s.gate.setStandby(false, { busy: true }); assert.deepEqual(s.requests, []);
  s.gate.setStandby(false); assert.deepEqual(s.requests, [false]);
  s.frame(); assert.equal(s.gate.blocked, true); await tick(); assert.equal(s.gate.blocked, false);
  assert.deepEqual(s.requests, [false, true]); s.gate.close();
});
test('resume requires full non-copy coverage, counts overlapping rectangles once and waits for painting', async () => {
  let paint; const s = setup({ flush: () => new Promise(resolve => { paint = resolve; }) }); s.frame(); s.gate.setStandby(true); s.gate.setStandby(false);
  s.frame([{ x: 0, y: 0, width: 8, height: 4, encoding: 1 }]); assert.equal(paint, undefined);
  const top = { x: 0, y: 0, width: 8, height: 2, encoding: 0 };
  s.frame([top, top]); assert.equal(paint, undefined); assert.equal(s.gate.blocked, true);
  s.frame([{ ...top, y: 2 }]); assert.equal(typeof paint, 'function'); assert.equal(s.gate.blocked, true);
  paint(); await tick(); assert.equal(s.gate.blocked, false); s.gate.close();
});
test('full coverage followed by overlapping rectangles is still complete and stale paint never unlocks another activation', async () => {
  const paints = []; const s = setup({ flush: () => new Promise(resolve => paints.push(resolve)) }); s.frame(); s.gate.setStandby(true); s.gate.setStandby(false);
  s.frame([{ x: 0, y: 0, width: 8, height: 4, encoding: 0 }, { x: 0, y: 0, width: 1, height: 1, encoding: 0 }]); assert.equal(paints.length, 1);
  s.gate.setStandby(true); paints[0](); await tick(); assert.equal(s.gate.blocked, true);
  s.gate.setStandby(false); s.frame(); paints[1](); await tick(); assert.equal(s.gate.blocked, false); s.gate.close();
});
test('continuous updates stop while parked, tolerate late end markers and restart after painted refresh', async () => {
  const s = setup({ continuous: true }); s.frame(); s.gate.setStandby(true);
  s.rfb._enabledContinuousUpdates = true; s.rfb._updateContinuousUpdates(); assert.equal(s.rfb._enabledContinuousUpdates, false);
  assert.deepEqual(s.controls, [false]); s.end(); assert.equal(s.rfb._enabledContinuousUpdates, false);
  s.gate.setStandby(false); s.frame(); await tick(); assert.equal(s.rfb._enabledContinuousUpdates, true);
  s.end(); assert.equal(s.rfb._enabledContinuousUpdates, true); assert.deepEqual(s.controls, [false, true, true]); s.gate.close();
});
test('busy activation has no timeout and resume timeout closes only adapter and restores original decoder', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let failures = 0;
  const s = setup({ failed: () => failures++ }); s.frame(); s.gate.setStandby(true); s.gate.setStandby(false, { busy: true });
  t.mock.timers.tick(FRAME_RESUME_TIMEOUT * 2); assert.equal(failures, 0);
  s.gate.setStandby(false); t.mock.timers.tick(FRAME_RESUME_TIMEOUT); assert.equal(failures, 1);
  assert.equal(s.rfb._framebufferUpdate, s.original._framebufferUpdate); assert.equal(s.gate.blocked, true);
  s.gate.close(); t.mock.timers.tick(FRAME_RESUME_TIMEOUT); assert.equal(failures, 1);
});
