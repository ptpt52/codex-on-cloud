import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceDiagnostics } from '../panel/service-diagnostics.mjs';

const row = (name, { state = 'active', load = 'loaded', result = 'success', restarts = name === 'panel' ? 2 : 0 } = {}) => `Id=codex-cloud-${name}.service\nLoadState=${load}\nActiveState=${state}\nResult=${result}\nNRestarts=${restarts}`;
const output = ['panel', 'manager', 'actions', 'files'].map(name => row(name)).join('\n\n');
test('service diagnostics share one bounded fixed-unit command and expose only selected fields', async () => {
  let calls = 0;
  const read = createServiceDiagnostics(async (command, args, options) => {
    calls++; assert.equal(command, 'systemctl');
    assert.deepEqual(args, ['--user', 'show', 'codex-cloud-panel.service', 'codex-cloud-manager.service', 'codex-cloud-actions.service', 'codex-cloud-files.service', '--property=Id,LoadState,ActiveState,Result,NRestarts']);
    assert.equal(options.maxBuffer, 4096); assert.equal(options.timeout, 1500); return { stdout: output };
  });
  const values = await Promise.all(Array.from({ length: 12 }, read));
  assert.equal(calls, 1); assert.equal(values[0].panel.restarts, 2); assert.equal(values[0].manager.state, 'active');
  assert.deepEqual(values[0].files, { state: 'active', restarts: 0, limited: false });
  assert.deepEqual(Object.keys(values[0]), ['available', 'panel', 'manager', 'actions', 'files']);
  assert.deepEqual(await read(), values[0]); assert.equal(calls, 1);
});

test('file recovery limits and missing units do not hide the other services or require desktop mode', async () => {
  for (const name of ['panel', 'files']) {
    for (const result of ['start-limit-hit', 'signal']) {
      const stdout = output.replace(row(name), row(name, { state: 'failed', result, restarts: 3 }));
      const value = await createServiceDiagnostics(async () => ({ stdout }))();
      assert.equal(value[name].limited, true); assert.equal(value.manager.state, 'active');
    }
  }
  const stdout = output.replace(row('files'), 'Id=codex-cloud-files.service\nLoadState=not-found\nActiveState=inactive').replace('codex-cloud-actions.service', 'codex-cloud-terminal.service');
  const value = await createServiceDiagnostics(async (_command, args) => {
    assert.ok(args.includes('codex-cloud-terminal.service')); assert.ok(!args.includes('codex-cloud-actions.service'));
    return { stdout };
  }, 'terminal')();
  assert.deepEqual(value.files, { state: 'missing', restarts: 0, limited: false });
  assert.equal(value.terminal.state, 'active'); assert.equal(value.panel.restarts, 2);
});

test('invalid, oversized or unavailable service diagnostics remain unknown and never expose command errors', async () => {
  for (const stdout of ['', output.repeat(10), output.replace('NRestarts=2', 'NRestarts=invalid'), output.replace('codex-cloud-panel.service', 'unknown.service'), output.replace('codex-cloud-panel.service', '__proto__'), output.replace('LoadState=loaded', 'LoadState=invalid'), output.replace('Id=codex-cloud-files.service', 'Id=codex-cloud-panel.service'), output + '\nId=duplicate', output.replace(row('files'), row('files', { load: 'not-found', state: 'inactive', restarts: 1 }))]) {
    assert.deepEqual(await createServiceDiagnostics(async () => ({ stdout }))(), { available: false });
  }
  assert.deepEqual(await createServiceDiagnostics(async () => { throw Error('private stderr'); })(), { available: false });
});
