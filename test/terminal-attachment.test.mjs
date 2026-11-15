import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalAttachment } from '../panel/terminal-attachment.mjs';

function fixture(overrides = {}) {
  const sources = [], states = [], bytes = []; let expired = 0, fatal = 0;
  const attachment = createTerminalAttachment({
    connect(hooks) { const source = { hooks, writes: [], closes: 0, write(bytes) { this.writes.push(bytes); }, close() { this.closes++; } }; sources.push(source); return source; },
    changed: state => states.push(state), push: value => bytes.push(value), expired: () => expired++, fatal: () => fatal++, idleMs: 30, ...overrides,
  });
  return { attachment, sources, states, bytes, get expired() { return expired; }, get fatal() { return fatal; } };
}
test('attachment transitions fence retired output and never queue input while detached', () => {
  const f = fixture(); f.attachment.attach(); const first = f.sources[0];
  assert.throws(() => f.attachment.write('early')); first.hooks.ready(); f.attachment.write('once');
  first.hooks.close('target-exited'); assert.equal(f.attachment.status.state, 'exited'); assert.equal(first.closes, 1);
  assert.throws(() => f.attachment.write('late')); f.attachment.attach(); first.hooks.push('stale'); first.hooks.ready(); first.hooks.close('helper-failed');
  assert.deepEqual(f.bytes, []); assert.equal(f.attachment.status.state, 'attaching');
  f.sources[1].hooks.ready(); f.sources[1].hooks.push('new'); assert.deepEqual(f.bytes, ['new']); assert.deepEqual(first.writes, ['once']);
  f.attachment.close(); assert.equal(f.sources[1].closes, 1);
});
test('reattachment cancels the detached deadline and disposal releases it', async () => {
  const f = fixture(); f.attachment.attach(); f.sources[0].hooks.close('helper-timeout');
  f.attachment.attach(); f.sources[1].hooks.ready(); await delay(50); assert.equal(f.expired, 0);
  f.sources[1].hooks.close('helper-failed'); await delay(50); assert.equal(f.expired, 1); f.attachment.close();
});
test('authorization revocation from a state notification prevents launching a helper', () => {
  let attachment, launches = 0;
  attachment = createTerminalAttachment({ connect() { launches++; }, changed() { attachment.close(); }, push() {}, expired() {}, fatal() {} });
  attachment.attach(); assert.equal(launches, 0);
});
test('protocol failure remains fatal rather than becoming a detached terminal', () => {
  const f = fixture(); f.attachment.attach(); f.sources[0].hooks.close('protocol'); assert.equal(f.fatal, 1); f.attachment.close();
});
