import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { attachTerminal } from '../panel/terminal-bridge.mjs';

function helper(t, outputWindow = 65536) {
  const child = new EventEmitter(), ws = new EventEmitter(), responses = [], commands = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close')); };
  ws.readyState = 1; ws.bufferedAmount = 0; ws.send = raw => responses.push(JSON.parse(raw)); ws.terminate = () => { ws.readyState = 3; };
  const bridge = attachTerminal(ws, { socketPath: '/isolated/flow.sock', terminalId: 'main', terminalToken: 'isolated', valid: () => true, verify: async () => true, launch: () => child });
  t.after(() => bridge.close());
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', bytes => { const value = JSON.parse(bytes.toString()); commands.push(value); if (value.id) emit({ type: 'result', id: value.id, ok: true }); });
  emit({ type: 'ready', outputWindow });
  return { child, ws, bridge, responses, commands, emit, message: value => ws.emit('message', Buffer.from(JSON.stringify(value)), false) };
}

test('render backpressure leaves control results, sizes and view changes flowing on the same helper', async t => {
  const app = helper(t); await delay(0);
  for (let n = 0; n < 8; n++) app.emit({ type: 'output', data: Buffer.alloc(8192, 65).toString('base64') });
  await delay(0);
  app.message({ type: 'control', id: 1, action: 'key', key: 'Enter' });
  app.message({ type: 'resize', id: 2, cols: 100, rows: 30 });
  app.message({ type: 'view', id: 3, standby: true });
  app.message({ type: 'health', nonce: 1 }); await delay(0);
  assert.equal(app.child.stdout.isPaused(), false); assert.equal(app.bridge.idle, true);
  assert.equal(app.responses.filter(v => v.type === 'result' && v.id === 1 && v.ok).length, 1);
  assert.equal(app.responses.filter(v => v.type === 'health').length, 1);
  assert.deepEqual(app.commands.map(v => v.action), ['input', 'resize', 'view']);
  app.message({ type: 'ack', bytes: 65536 }); await delay(0);
  assert.deepEqual(app.commands.at(-1), { action: 'output-ack', bytes: 65536 }); assert.equal(app.bridge.idle, true);
  app.emit({ type: 'output', data: Buffer.from('continued').toString('base64') }); await delay(0);
  assert.equal(app.responses.at(-1).data, Buffer.from('continued').toString('base64'));
  assert.equal(app.commands.filter(v => v.action === 'input').length, 1);
});

test('flow helpers cannot exceed the credit window or accept forged renderer acknowledgments', async t => {
  for (const invalid of ['excess-output', 'excess-ack', 'invalid-window']) await t.test(invalid, async t => {
    const app = helper(t, invalid === 'invalid-window' ? 0 : 65536); await delay(0);
    if (invalid === 'excess-output') { for (let n = 0; n < 9; n++) app.emit({ type: 'output', data: Buffer.alloc(8192).toString('base64') }); }
    if (invalid === 'excess-ack') app.message({ type: 'ack', bytes: 1 });
    await delay(0); assert.equal(app.ws.readyState, 3);
  });
});
