import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceDiagnostics } from '../panel/service-diagnostics.mjs';

const output = ['panel', 'manager', 'actions'].map(name => `Id=codex-cloud-${name}.service\nActiveState=active\nResult=success\nNRestarts=${name === 'panel' ? 2 : 0}`).join('\n\n');
test('service diagnostics share one bounded fixed-unit command and expose only selected fields', async () => {
  let calls = 0;
  const read = createServiceDiagnostics(async (command, args, options) => { calls++; assert.equal(command, 'systemctl'); assert.equal(args[0], '--user'); assert.equal(options.maxBuffer, 4096); return { stdout: output }; });
  const values = await Promise.all(Array.from({ length: 12 }, read));
  assert.equal(calls, 1); assert.equal(values[0].panel.restarts, 2); assert.equal(values[0].manager.state, 'active');
  const limited = await createServiceDiagnostics(async () => ({ stdout: output.replace('Result=success', 'Result=start-limit-hit') }))(); assert.equal(limited.panel.limited, true);
  for (const stdout of ['', output.repeat(10), output.replace('NRestarts=2', 'NRestarts=invalid'), output.replace('codex-cloud-panel.service', 'unknown.service')]) assert.deepEqual(await createServiceDiagnostics(async () => ({ stdout }))(), { available: false });
  assert.deepEqual(await createServiceDiagnostics(async () => { throw Error('private stderr'); })(), { available: false });
});
