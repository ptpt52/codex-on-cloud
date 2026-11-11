import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResponseBytes } from '../native/response-body.mjs';
import { installFrpc } from '../selfhost/frpc.mjs';

test('bounded response reads preserve empty, exact-limit and fragmented binary data', async () => {
  assert.deepEqual(await readResponseBytes(new Response(''), 0), Buffer.alloc(0));
  const expected = Buffer.alloc(65539); for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
  let offset = 0;
  const body = new ReadableStream({ pull(controller) { if (offset === expected.length) return controller.close(); controller.enqueue(expected.subarray(offset, ++offset)); } });
  assert.deepEqual(await readResponseBytes(new Response(body), expected.length), expected);
});

test('oversize decoded responses stop at the byte bound even with a smaller Content-Length', async () => {
  let cancelled = false, pulled = 0;
  const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(readResponseBytes(new Response(body, { headers: { 'content-length': '1' } }), 4096), /超过大小上限/);
  assert.equal(cancelled, true); assert(pulled <= 6);
});

test('oversize cancellation does not wait for an unresponsive producer cleanup', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2)); }, cancel() { return new Promise(() => {}); } });
  await assert.rejects(readResponseBytes(new Response(body), 1), /超过大小上限/);
});

test('frpc installer rejects and cancels an advertised oversize package before writing artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-frpc-size-')); t.after(() => rm(root, { recursive: true, force: true }));
  let cancelled = false;
  const request = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } });
  await assert.rejects(installFrpc({ root, arch: 'x64', platform: 'linux', request }), /超过 64 MiB/);
  assert.equal(cancelled, true); assert.deepEqual(await readdir(join(root, 'data', 'selfhost-node', 'bin')), []);
});
