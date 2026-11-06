import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { forwardHeartbeat } from '../panel/forward-heartbeat.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new EventEmitter(), failures = [];
  Object.assign(socket, { readyState: 1, isPaused: false, pings: 0, ping(value) { this.pings++; this.challenge = value; } });
  forwardHeartbeat(socket, code => failures.push(code));
  t.after(() => socket.emit('close'));
  return { socket, failures, tick: milliseconds => t.mock.timers.tick(milliseconds) };
}

test('TCP backpressure cannot cause a false heartbeat failure, and resuming probes the transport again', t => {
  const f = fixture(t);
  f.tick(15000); assert.equal(f.socket.pings, 1);
  const stale = f.socket.challenge; f.socket.isPaused = true;
  f.tick(30000); assert.deepEqual(f.failures, []);
  // This Pong arrived during physical receive suspension; it cannot replace a
  // fresh probe when the application starts consuming again.
  f.socket.emit('pong', stale); f.socket.isPaused = false;
  f.tick(15000); assert.equal(f.socket.pings, 4);
  f.socket.emit('pong', stale); f.tick(15000); assert.deepEqual(f.failures, []);
  f.socket.emit('pong', f.socket.challenge); f.tick(15000); assert.deepEqual(f.failures, []);
});

test('a healthy transport with a stalled TCP consumer is bounded independently of network liveness', t => {
  const f = fixture(t); f.socket.isPaused = true;
  for (let n = 0; n < 4; n++) { f.socket.emit('pong'); f.tick(15000); }
  assert.deepEqual(f.failures, ['tcp_peer_stalled']); assert.equal(f.socket.pings, 3);
  f.tick(60000); assert.equal(f.failures.length, 1);
});

test('missing Pongs release the heartbeat exactly once', t => {
  const f = fixture(t); f.tick(30000); assert.deepEqual(f.failures, []);
  f.tick(15000); assert.deepEqual(f.failures, ['heartbeat_timeout']);
  f.tick(60000); assert.equal(f.failures.length, 1);
});

test('real ws exposes receive suspension without mistaking queued control frames for network loss', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const accepted = once(server, 'connection'), client = new WebSocket('ws://127.0.0.1:' + server.address().port);
  const opened = once(client, 'open'), [socket] = await accepted; await opened;
  t.after(async () => { socket.terminate(); client.terminate(); await new Promise(resolve => server.close(resolve)); });
  const failures = []; forwardHeartbeat(socket, code => failures.push(code));
  const first = once(socket, 'pong'); t.mock.timers.tick(15000); await first;
  socket.pause(); assert.equal(socket.isPaused, true);
  client.pong('stale'); t.mock.timers.tick(30000); assert.deepEqual(failures, []);
  socket.resume(); assert.equal(socket.isPaused, false);
  const resumed = once(socket, 'pong'); t.mock.timers.tick(15000); await resumed;
  assert.deepEqual(failures, []);
});

test('closing a stream cancels its heartbeat and synchronous ping errors stay classified', t => {
  const f = fixture(t); f.socket.emit('close'); f.tick(60000); assert.deepEqual(f.failures, []);
  const socket = new EventEmitter(), failures = [];
  Object.assign(socket, { readyState: 1, ping() { throw Error('private network details'); } });
  forwardHeartbeat(socket, code => failures.push(code)); f.tick(15000);
  assert.deepEqual(failures, ['helper_disconnected']);
});
