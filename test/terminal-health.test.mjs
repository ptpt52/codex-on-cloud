import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalHealth } from '../panel/public/terminal-health.js';

function fixture(t, send = () => true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const packets = []; let failures = 0;
  const health = createTerminalHealth(nonce => { packets.push(nonce); return send(nonce); }, () => failures++);
  return { health, packets, get failures() { return failures; }, tick: duration => t.mock.timers.tick(duration) };
}

test('terminal health sends one probe after three seconds and fails once two seconds later', t => {
  const f = fixture(t); f.health.start(); f.tick(2999); assert.deepEqual(f.packets, []);
  f.tick(1); assert.deepEqual(f.packets, [1]); f.tick(1999); assert.equal(f.failures, 0);
  f.tick(1); assert.equal(f.failures, 1); f.tick(10000); f.health.wake(); f.tick(5000);
  assert.deepEqual(f.packets, [1]); assert.equal(f.failures, 1);
});

test('healthy terminal probes schedule the next check without overlapping a pending probe', t => {
  const f = fixture(t); f.health.start(); f.tick(3000); f.health.receive(1); f.tick(2999);
  assert.deepEqual(f.packets, [1]); f.tick(1); assert.deepEqual(f.packets, [1, 2]);
  f.health.receive(1); f.tick(1999); assert.equal(f.failures, 0); f.health.receive(2);
  f.tick(3000); assert.deepEqual(f.packets, [1, 2, 3]); f.health.close(); f.tick(10000); assert.equal(f.failures, 0);
});

test('wake replaces a regular pending probe and repeated network events cannot postpone its fresh deadline', t => {
  const f = fixture(t); f.health.start(); f.tick(3000); f.health.wake();
  f.tick(100); f.health.wake(); f.tick(100); f.health.wake(); f.tick(50);
  assert.deepEqual(f.packets, [1, 2]);
  for (let i = 0; i < 19; i++) { f.health.wake(); f.health.receive(1); f.tick(100); }
  assert.equal(f.failures, 0); f.health.wake(); f.tick(100); assert.equal(f.failures, 1);
  assert.deepEqual(f.packets, [1, 2]);
});

test('suspending cancels deadlines, ignores late echoes and resumes with a new nonce', t => {
  const f = fixture(t); f.health.start(); f.tick(3000); f.health.suspend(); f.tick(10000); f.health.receive(1);
  assert.equal(f.failures, 0); assert.deepEqual(f.packets, [1]);
  f.health.wake(); f.tick(250); assert.deepEqual(f.packets, [1, 2]); f.health.receive(1); f.tick(2000);
  assert.equal(f.failures, 1);
});

test('send failure and malformed or future replies fail closed while disposal cancels every callback', t => {
  const f = fixture(t, () => false); f.health.wake(); f.tick(250); assert.equal(f.failures, 1);
  for (const nonce of [0, -1, 2, 2147483648, '1', null, {}]) {
    let failures = 0; const health = createTerminalHealth(() => true, () => failures++);
    health.start(); f.tick(3000); health.receive(nonce); assert.equal(failures, 1); health.close();
  }
  let failures = 0; const health = createTerminalHealth(() => true, () => failures++);
  health.wake(); f.tick(250); health.close(); health.wake(); health.start(); health.receive(1); f.tick(10000); assert.equal(failures, 0);
});
