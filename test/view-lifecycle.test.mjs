import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewLifecycle } from '../panel/public/view-lifecycle.js';

test('module, first-frame and probe diagnostics follow the view without granting input readiness', () => {
  const views = createViewLifecycle({ contentWindow: {} }); views.begin('desktop');
  const entry = views.active;
  views.update(entry, { type: 'codex-desktop', state: 'ready' });
  views.update(entry, { type: 'codex-view-first-frame' });
  views.update(entry, { type: 'codex-connection-progress', probe: 'stopped', probeReason: 'auth' }, { probeReasons: ['auth'] });
  assert.equal(entry.moduleReady, true); assert.equal(entry.firstFrame, true); assert.equal(entry.probe, 'stopped'); assert.equal(entry.probeReason, 'auth');
  assert.equal(views.inputReady(), false);
  views.update(entry, { type: 'codex-desktop', state: 'disconnected' });
  assert.equal(entry.moduleReady, true); assert.equal(entry.firstFrame, false);
});
const element = () => ({ contentWindow: {} });
const main = 'main:%0:4000', other = 'aux1:%1:4001';
const connected = (views, entry, transport = 'direct') => {
  const live = views.update(entry, { type: 'codex-desktop', state: 'connected', transport });
  if (live && entry.mode === 'desktop') views.update(entry, { type: 'codex-desktop-view', revision: 0, frameReady: true }, { revision: 0 });
  return live;
};
const capabilities = (views, entry) => views.update(entry, { type: 'codex-panel-state', ready: true, terminalSwitch: true, terminalCreate: true, terminalOpen: true });

test('view swaps retain records, geometry and capabilities while input remains exclusive to the active view', () => {
  const views = createViewLifecycle(element()); views.begin('desktop');
  const desktop = views.active; connected(views, desktop); capabilities(views, desktop);
  const terminal = views.prepare(element(), 'terminal', main); connected(views, terminal); capabilities(views, terminal);
  views.update(terminal, { type: 'codex-terminal-size', cols: 80, rows: 24, fontSize: 15 });
  views.update(terminal, { type: 'codex-terminal-history', reviewing: true });
  assert.equal(views.inputReady(desktop), true); assert.equal(views.inputReady(terminal), false);
  for (let n = 0; n < 5; n++) {
    assert.equal(views.swap('terminal', main), true); assert.equal(views.active, terminal); assert.equal(views.standby, desktop);
    assert.deepEqual(views.active.geometry, { cols: 80, rows: 24, fontSize: 15 }); assert.equal(views.active.reviewing, true);
    assert.equal(views.active.terminalSwitchReady, true); assert.equal(views.active.terminalOpenReady, false);
    assert.equal(views.swap('desktop', ''), true); assert.equal(views.active, desktop); assert.equal(views.active.terminalOpenReady, true);
    assert.equal(views.active.terminalSwitchReady, false); assert.equal(views.active.nativeIdle, false); assert.equal(views.active.resizeReady, false);
  }
  assert.throws(() => views.prepare(element(), 'terminal', main));
});

test('retired frame generations and sources cannot update a replacement that reuses the iframe', () => {
  const frame = element(), views = createViewLifecycle(frame); views.begin('terminal', main);
  const retired = views.active, epoch = String(retired.epoch); views.reset('terminal'); views.begin('terminal', other);
  assert.equal(views.match(frame.contentWindow, epoch), null); assert.equal(views.match({}, String(views.active.epoch)), null);
  assert.equal(views.match(frame.contentWindow, String(views.active.epoch)), views.active);
  assert.equal(connected(views, retired), false); assert.equal(views.confirmTarget(retired, main), false);
  assert.equal(views.active.key, other); assert.equal(views.active.state, 'connecting');
});

test('a replacement iframe rejects the retired source even when it sends the current epoch', () => {
  const previous = element(), next = element(), views = createViewLifecycle(previous); views.begin('desktop');
  const retired = views.active; views.reset('desktop', next); views.begin('desktop');
  assert.equal(views.active.element, next); assert.equal(views.match(previous.contentWindow, String(views.active.epoch)), null);
  assert.equal(views.match(next.contentWindow, String(views.active.epoch)), views.active); assert.equal(connected(views, retired), false);
});

test('desired terminal identity blocks input until its matching confirmed result and cancellation restores the actual identity', () => {
  const views = createViewLifecycle(element()); views.begin('terminal', main); connected(views, views.active);
  assert.equal(views.requestTarget(views.active, other), true); assert.equal(views.active.key, main); assert.equal(views.inputReady(), false);
  assert.equal(views.confirmTarget(views.active, main), false); assert.equal(views.inputReady(), false);
  views.cancelTarget(views.active); assert.equal(views.active.desiredKey, main); assert.equal(views.inputReady(), true);
  views.requestTarget(views.active, other); assert.equal(views.confirmTarget(views.active, other), true);
  assert.equal(views.inputReady(), true); assert.equal(views.active.key, other);
});

test('disconnected parked viewers invalidate stale capabilities and cannot promise a different terminal attachment', () => {
  const views = createViewLifecycle(element()); views.begin('desktop'); connected(views, views.active);
  const terminal = views.prepare(element(), 'terminal', main); connected(views, terminal); capabilities(views, terminal);
  assert.equal(views.canSwap('terminal', other), true);
  views.update(terminal, { type: 'codex-desktop', state: 'disconnected' });
  assert.equal(terminal.panelReady, false); assert.equal(terminal.terminalSwitchReady, false); assert.equal(views.canSwap('terminal', other), false);
  assert.equal(views.swap('terminal', main), true); assert.equal(views.inputReady(), false);
  assert.equal(views.active.panelCapabilitiesKnown, false);
});

test('promoting a different parked terminal retains its actual key until target confirmation', () => {
  const views = createViewLifecycle(element()); views.begin('desktop'); connected(views, views.active);
  const terminal = views.prepare(element(), 'terminal', main); connected(views, terminal); capabilities(views, terminal);
  assert.equal(views.swap('terminal', other), true);
  assert.equal(views.active.key, main); assert.equal(views.active.desiredKey, other); assert.equal(views.inputReady(), false);
  assert.equal(views.confirmTarget(terminal, main), false);
  assert.equal(views.confirmTarget(terminal, other), true); assert.equal(views.inputReady(), true);
});

test('background updates share validation but do not change foreground geometry or input readiness', () => {
  const views = createViewLifecycle(element()); views.begin('terminal', main); connected(views, views.active);
  const desktop = views.prepare(element(), 'desktop'); connected(views, desktop);
  views.update(desktop, { type: 'codex-desktop-view', revision: 3, width: 1920, height: 1080, scale: .5, idle: true, resizeReady: true }, { revision: 3 });
  assert.deepEqual(desktop.dimensions, { width: 1920, height: 1080 }); assert.equal(views.active.dimensions, null);
  assert.equal(views.update(desktop, { type: 'codex-desktop-view', revision: 2, width: 1, height: 1 }, { revision: 3 }), false);
  views.update(views.active, { type: 'codex-stream-state', paused: true, terminalSwitch: true }, { terminalSwitching: true });
  assert.equal(views.active.paused, false); assert.equal(views.active.panelCapabilitiesKnown, false);
  views.update(views.active, { type: 'codex-stream-state', paused: true }); assert.equal(views.inputReady(), false);
  views.discard(); assert.equal(views.update(desktop, { type: 'codex-panel-state', ready: true }), false);
});

test('desktop activation keeps input blocked until matching frame and target confirmation, without blocking control admission', () => {
  const views = createViewLifecycle(element()); views.begin('terminal', main); connected(views, views.active);
  const desktop = views.prepare(element(), 'desktop'); connected(views, desktop); capabilities(views, desktop);
  views.swap('desktop', ''); desktop.activationPending = true;
  assert.equal(views.inputReady(), false); assert.equal(desktop.terminalOpenReady, true);
  views.update(desktop, { type: 'codex-desktop-view', revision: 3, frameReady: true }, { revision: 2 }); assert.equal(desktop.frameReady, false);
  views.update(desktop, { type: 'codex-desktop-view', revision: 3, frameReady: true }, { revision: 3 }); assert.equal(views.inputReady(), false);
  desktop.activationPending = false; assert.equal(views.inputReady(), true);
});

test('suspended views lose all input and control readiness but retain terminal identity and geometry', () => {
  const views = createViewLifecycle(element()); views.begin('terminal', main); connected(views, views.active); capabilities(views, views.active);
  views.update(views.active, { type: 'codex-terminal-size', cols: 80, rows: 24 });
  views.suspend(); assert.equal(views.inputReady(), false); assert.equal(views.active.panelReady, false); assert.equal(views.active.terminalSwitchReady, false);
  assert.equal(views.active.key, main); assert.equal(views.active.geometry.cols, 80); assert.equal(views.active.composing, false);
});


test('a new desktop viewer cannot accept input on connect before its first painted frame', () => {
  const views = createViewLifecycle(element()); views.begin('desktop');
  views.update(views.active, { type: 'codex-desktop', state: 'connected' }); assert.equal(views.inputReady(), false);
  views.update(views.active, { type: 'codex-desktop-view', revision: 0, frameReady: true }, { revision: 0 }); assert.equal(views.inputReady(), true);
});

test('a reconnecting desktop drops old painting and resize readiness before accepting a new connection', () => {
  const views = createViewLifecycle(element()); views.begin('desktop'); connected(views, views.active);
  views.update(views.active, { type: 'codex-desktop-view', revision: 1, frameReady: true, resizeReady: true, idle: true }, { revision: 1 });
  views.update(views.active, { type: 'codex-desktop', state: 'disconnected' });
  views.update(views.active, { type: 'codex-desktop', state: 'connected' });
  assert.equal(views.inputReady(), false); assert.equal(views.active.resizeReady, false); assert.equal(views.active.nativeIdle, false);
  views.update(views.active, { type: 'codex-desktop-view', revision: 1, frameReady: true }, { revision: 1 });
  assert.equal(views.inputReady(), true);
});
