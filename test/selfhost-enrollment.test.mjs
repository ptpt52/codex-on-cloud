import test from 'node:test';
import assert from 'node:assert/strict';
import { queryEnrollment } from '../selfhost/enrollment.mjs';
import { enrollmentCredential } from '../selfhost/protocol.mjs';

const intent = { target: { origin: 'https://desk.example.test', slug: 'node-a', nodeId: 'a'.repeat(32) }, mode: 'terminal', operation: { id: 'b'.repeat(32), proof: 'cocj_' + 'p'.repeat(43) }, ca: null };
const accepted = { version: 1, state: 'accepted', operationId: intent.operation.id, slug: intent.target.slug, nodeId: intent.target.nodeId, mode: intent.mode, credential: enrollmentCredential(intent.operation, intent.target.nodeId, intent.mode) };

test('receipt queries keep the private proof out of URLs and refuse mismatched identities or credentials', async () => {
  const request = async (url, options) => {
    assert.equal(url, intent.target.origin + '/api/join-result'); assert(!url.includes(intent.operation.proof));
    assert.equal(options.redirect, 'error'); assert.equal(JSON.parse(options.body).operation.proof, intent.operation.proof);
    return new Response(JSON.stringify(accepted));
  };
  assert.equal((await queryEnrollment(intent, { request })).credential, accepted.credential);
  for (const patch of [{ operationId: 'c'.repeat(32) }, { nodeId: 'c'.repeat(32) }, { slug: 'another' }, { mode: 'desktop' }, { credential: 'cocn_' + 'z'.repeat(43) }]) {
    await assert.rejects(queryEnrollment(intent, { request: async () => new Response(JSON.stringify({ ...accepted, ...patch })) }), /身份或凭据无效/);
  }
});

test('unavailable or legacy receipts remain unknown and are never retried as enrollment', async () => {
  let requests = 0;
  const request = async url => { requests++; assert(url.endsWith('/api/join-result')); return new Response('{}', { status: 404 }); };
  assert.equal((await queryEnrollment(intent, { request })).state, 'unknown'); assert.equal(requests, 1);
  assert.deepEqual(await queryEnrollment({ ...intent, operation: null }, { request }), { state: 'unknown', reason: 'legacy_receipt' });
  assert.equal(requests, 1);
});
