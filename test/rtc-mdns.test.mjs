import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import multicastDNS from 'multicast-dns';
import { createMDNSLookup, MDNS_TIMEOUT } from '../panel/rtc-mdns.mjs';

function fixture(ipv6 = false) {
  const socket = new EventEmitter(), queries = [];
  let created = 0, destroyed = 0;
  socket.query = (questions, callback) => { queries.push(questions); callback?.(); };
  socket.destroy = () => destroyed++;
  const lookup = createMDNSLookup({ address: '192.168.16.224', ipv6, create(options) {
    assert.deepEqual(options, { interface: '192.168.16.224', bind: '0.0.0.0' }); created++; return socket;
  } });
  return { lookup, socket, queries, get created() { return created; }, get destroyed() { return destroyed; } };
}
const answer = (name, data, type = 'A', ttl = 120) => ({ name, data, type, ttl });

test('mDNS finds matching A records beyond the first answer, normalizes names and handles additional records', async () => {
  const f = fixture(); assert.equal(f.created, 0);
  const first = f.lookup.lookup('Chrome-uuid.local'), duplicate = f.lookup.lookup('chrome-uuid.LOCAL.');
  assert.equal(first, duplicate); assert.equal(f.created, 1); assert.equal(f.queries.length, 1);
  f.socket.emit('response', { answers: [answer('unrelated.local', '192.168.16.1'), answer('chrome-uuid.local', 'fd00::1', 'AAAA'),
    answer('CHROME-UUID.local.', '192.168.16.3')] });
  assert.equal(await first, '192.168.16.3');
  const second = f.lookup.lookup('second.local');
  f.socket.emit('response', { additionals: [answer('second.local', '192.168.16.4')] });
  assert.equal(await second, '192.168.16.4');
  assert.equal(await f.lookup.lookup('Chrome-uuid.local'), '192.168.16.3');
  f.lookup.close(); f.lookup.close(); assert.equal(f.destroyed, 1);
});

test('mDNS accepts only permitted IP families, ignores goodbye records and bounds queries and timeouts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.lookup.lookup('chrome.local'); const rejected = assert.rejects(pending, /No mDNS response/);
  f.socket.emit('response', { answers: [answer('chrome.local', '8.8.8.8'), answer('chrome.local', '192.168.16.1', 'A', 0),
    answer('chrome.local', '240e:3bc::2', 'AAAA'), answer('other.local', '192.168.16.1')] });
  t.mock.timers.tick(1000); assert.equal(f.queries.length, 2);
  t.mock.timers.tick(MDNS_TIMEOUT - 1000); await rejected;
  t.mock.timers.tick(10000); assert.equal(f.queries.length, 2); f.lookup.close();
  const v6 = fixture(true), result = v6.lookup.lookup('chrome.local');
  assert.deepEqual(v6.queries[0].map(value => value.type), ['A', 'AAAA']);
  v6.socket.emit('response', { answers: [answer('chrome.local', 'fd00::1', 'AAAA'), answer('chrome.local', '240e:3bc::2', 'AAAA')] });
  assert.equal(await result, '240e:3bc::2'); v6.lookup.close();
});

test('mDNS limits a peer to eight names, cancels pending lookups and ignores late replies after close or socket error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), pending = [];
  await assert.rejects(f.lookup.lookup('external.example'), /Invalid/); assert.equal(f.created, 0);
  for (let i = 0; i < 8; i++) pending.push(assert.rejects(f.lookup.lookup(`chrome-${i}.local`), /closed/));
  await assert.rejects(f.lookup.lookup('ninth.local'), /Too many/); assert.equal(f.queries.length, 8);
  f.socket.emit('error', new Error('denied')); await Promise.all(pending); assert.equal(f.destroyed, 1);
  t.mock.timers.tick(10000); assert.equal(f.queries.length, 8);
  f.socket.emit('response', { answers: [answer('chrome-0.local', '192.168.16.3')] });
  await assert.rejects(f.lookup.lookup('chrome-0.local'), /Invalid/);
});

test('real UDP multicast resolves a Chrome-style name from a multi-record response and releases its socket', async t => {
  const name = `codex-test-${randomUUID()}.local`;
  const responder = multicastDNS({ interface: '127.0.0.1', bind: '0.0.0.0' });
  const lookup = createMDNSLookup({ address: '127.0.0.1' });
  t.after(async () => { lookup.close(); await new Promise(resolve => responder.destroy(resolve)); });
  await once(responder, 'ready', { signal: AbortSignal.timeout(2000) });
  let queries = 0;
  responder.on('query', packet => {
    if (!packet.questions.some(question => question.name === name)) return;
    queries++;
    responder.respond([answer('unrelated.local', '192.168.1.1'), answer(name, 'fd00::1', 'AAAA'), answer(name, '127.0.0.1')]);
  });
  assert.equal(await lookup.lookup(name), '127.0.0.1');
  assert.equal(queries, 1); lookup.close();
});
