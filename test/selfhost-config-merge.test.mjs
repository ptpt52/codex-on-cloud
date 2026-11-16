import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { mergeCredentials, mergeEnvironment } from '../selfhost/config-merge.mjs';

test('three-way environment restoration changes owned values and retains comments, formatting and multiline notes', () => {
  const before = ' export PUBLIC_ORIGIN = \'https://old.example.test\' # address\r\nNODE_ID=old\r\nNOTES="first\nNODE_ID=inside-note\nlast"\r\nCOLOR=red\r\n';
  const managed = before.replace('https://old.example.test', 'https://center.example.test').replace('NODE_ID=old', 'NODE_ID=new') + 'ENTRY_BASE_PATH=/node/a/ # keep me\r\n';
  const current = managed.replace('COLOR=red', 'COLOR=blue') + '# operator comment\r\nNEW_OPTION=enabled\r\n';
  const restored = mergeEnvironment(current, managed, before), values = parseEnv(restored);
  assert.equal(values.PUBLIC_ORIGIN, 'https://old.example.test'); assert.equal(values.NODE_ID, 'old');
  assert.equal(values.NOTES, 'first\nNODE_ID=inside-note\nlast'); assert.equal(values.COLOR, 'blue'); assert.equal(values.NEW_OPTION, 'enabled');
  assert.equal(values.ENTRY_BASE_PATH, undefined); assert(restored.includes('# keep me')); assert(restored.includes('# operator comment\r\n'));
  assert(restored.startsWith(' export PUBLIC_ORIGIN = \'https://old.example.test\' # address\r\n'));
  assert.equal(mergeEnvironment(restored, managed, before), restored);
});

test('owned-field conflicts and duplicates fail without including values in errors', () => {
  const before = 'PUBLIC_ORIGIN=https://old.example.test\n', after = 'PUBLIC_ORIGIN=https://center.example.test\n';
  assert.throws(() => mergeEnvironment('PUBLIC_ORIGIN=https://private-operator.example.test\n', after, before), error => /未覆盖/.test(error.message) && !error.message.includes('private-operator'));
  assert.throws(() => mergeEnvironment(after + ' export PUBLIC_ORIGIN=duplicate\n', after, before), /重复/);
  assert.throws(() => mergeEnvironment('PUBLIC_ORIGIN="unterminated', after, before), /引号未闭合/);
});

test('environment merges enforce byte bounds before returning output', () => {
  assert.throws(() => mergeEnvironment('#' + 'x'.repeat(65536), '', ''), /64 KiB/);
  const full = '#' + 'x'.repeat(65532) + '\n';
  assert.throws(() => mergeEnvironment(full, '', 'PUBLIC_ORIGIN=https://center.example.test\n'), /64 KiB/);
});

test('login note restoration owns only the workbench address and preserves other edits', () => {
  const before = '工作台：https://old.example.test\n用户名：admin\n', after = before.replace('old', 'center');
  const current = after.replace('用户名：admin', '用户名：operator') + '# additional note\n';
  const restored = mergeCredentials(current, after, before);
  assert.equal(restored, current.replace('center', 'old')); assert.equal(mergeCredentials(restored, after, before), restored);
  assert.throws(() => mergeCredentials(current.replace('center', 'foreign'), after, before), /未覆盖/);
  assert.throws(() => mergeCredentials(after + '工作台：duplicate\n', after, before), /重复/);
});
