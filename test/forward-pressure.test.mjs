import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createForwardPressure, FORWARD_PRESSURE_MS } from '../panel/forward-pressure.mjs';
import { createForwardMux } from '../panel/forward-mux.mjs';
import { forwardChannel } from '../panel/forward-channel.mjs';
import { createFlowBudget } from '../panel/flow-budget.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tcp = new EventEmitter(), ws = Object.assign(new EventEmitter(), { readyState: 1, pause() { this.paused = true; }, resume() { this.paused = false; } });
  const failures = [], pressure = createForwardPressure(tcp, ws, code => failures.push(code));
  t.after(pressure.close); return { tcp, ws, failures, pressure };
}

test('continuous TCP backpressure has one absolute deadline and releases its listeners', t => {
  const f = fixture(t); f.pressure.pause();
  t.mock.timers.tick(FORWARD_PRESSURE_MS / 2); f.pressure.pause();
  t.mock.timers.tick(FORWARD_PRESSURE_MS / 2 - 1); assert.deepEqual(f.failures, []);
  t.mock.timers.tick(1); assert.deepEqual(f.failures, ['tcp_peer_stalled']);
  assert.equal(f.tcp.listenerCount('drain'), 0); assert.equal(f.tcp.listenerCount('close'), 0); assert.equal(f.ws.listenerCount('close'), 0);
  f.pressure.pause(); t.mock.timers.tick(FORWARD_PRESSURE_MS); assert.equal(f.failures.length, 1);
});

test('TCP drain cancels pressure expiry, normal idle streams persist, and either close cleans up', t => {
  const f = fixture(t);
  t.mock.timers.tick(10 * FORWARD_PRESSURE_MS); assert.deepEqual(f.failures, []);
  f.pressure.pause(); t.mock.timers.tick(FORWARD_PRESSURE_MS - 1); f.tcp.emit('drain');
  assert.equal(f.ws.paused, false);
  t.mock.timers.tick(10 * FORWARD_PRESSURE_MS); assert.deepEqual(f.failures, []);
  f.pressure.pause(); f.ws.emit('close'); t.mock.timers.tick(FORWARD_PRESSURE_MS); assert.deepEqual(f.failures, []);
  const tcp = new EventEmitter(), ws = Object.assign(new EventEmitter(), { pause() {} });
  const pressure = createForwardPressure(tcp, ws, () => assert.fail('closed target expired twice'));
  pressure.pause(); tcp.emit('close'); assert.equal(ws.listenerCount('close'), 0); t.mock.timers.tick(FORWARD_PRESSURE_MS);
});

const frame = (op, id, text = '') => { const body = Buffer.from(text), value = Buffer.alloc(5 + body.length); value[0] = op; value.writeUInt32BE(id, 1); body.copy(value, 5); return value; };
test('expiring one paused mux stream preserves the shared WebSocket and another rule', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const packets = [], sockets = [], failures = [];
  const physical = { readyState: 1, bufferedAmount: 0, send(bytes, callback) { packets.push(bytes); callback?.(); }, terminate() { assert.fail('pressure retired the physical WSS'); } };
  const mux = createForwardMux(physical, { valid: () => true, healthy: () => true, connect(socket, record) {
    sockets.push(socket);
    if (record.slow) {
      const tcp = new EventEmitter(), pressure = createForwardPressure(tcp, socket, code => { failures.push(code); socket.terminate(); });
      socket.on('message', () => pressure.pause());
    } else socket.on('message', bytes => socket.send(bytes));
  } });
  t.after(() => mux.close());
  mux.receive(frame(4, 1)); mux.receive(frame(1, 1, '{"slow":true}'));
  mux.receive(frame(4, 2)); mux.receive(frame(1, 2, '{}'));
  mux.receive(frame(2, 1, 'unread target'));
  t.mock.timers.tick(FORWARD_PRESSURE_MS);
  assert.deepEqual(failures, ['tcp_peer_stalled']); assert.equal(mux.streams, 1); assert.equal(sockets[0].readyState, 3); assert.equal(sockets[1].readyState, 1);
  mux.receive(frame(2, 2, 'other rule still works')); await new Promise(resolve => setImmediate(resolve));
  assert(packets.some(bytes => bytes[0] === 2 && bytes.readUInt32BE(1) === 2 && bytes.subarray(5).toString() === 'other rule still works'));
});

test('a stalled direct target returns shared credits while its sibling remains usable', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signal = () => { const handlers = new Set(); return { subscribe(fn) { handlers.add(fn); return { unSubscribe: () => handlers.delete(fn) }; }, emit(value) { for (const fn of [...handlers]) fn(value); } }; };
  const native = () => { const channel = { readyState: 'open', bufferedAmount: 0, onMessage: signal(), stateChange: signal(), error: signal(), send() {}, close() { this.readyState = 'closed'; this.stateChange.emit('closed'); } }; return channel; };
  const budget = createFlowBudget(), slow = forwardChannel(native(), { budget }), sibling = forwardChannel(native(), { budget }), tcp = new EventEmitter();
  t.after(() => { slow.terminate(); sibling.terminate(); });
  createForwardPressure(tcp, slow, () => slow.terminate()).pause();
  slow.send(Buffer.alloc(16384)); assert.equal(budget.used, 16384);
  t.mock.timers.tick(FORWARD_PRESSURE_MS); assert.equal(budget.used, 0); assert.equal(sibling.readyState, 1);
  sibling.send(Buffer.alloc(16384)); assert.equal(budget.used, 16384);
});
