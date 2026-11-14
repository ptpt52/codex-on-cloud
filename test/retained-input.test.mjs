import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedEdit, createRetainedInput } from '../panel/public/retained-input.js';

test('retained edits distinguish cumulative recognition, real repetition, corrections and grapheme deletion', () => {
  assert.deepEqual(retainedEdit('这是语音', '这是语音输入'), { erase: 0, text: '输入' });
  assert.deepEqual(retainedEdit('你好', '你好你好'), { erase: 0, text: '你好' });
  assert.deepEqual(retainedEdit('语音输出', '语音输入'), { erase: 1, text: '入' });
  assert.deepEqual(retainedEdit('a👨‍👩‍👧‍👦', 'a'), { erase: 1, text: '' });
  assert.deepEqual(retainedEdit('一致', '一致'), { erase: 0, text: '' });
  assert.throws(() => retainedEdit('字'.repeat(513), ''), /范围过大/);
  assert.throws(() => retainedEdit('', '字'.repeat(11000)), /32 KiB/);
});

test('abandoned or rejected snapshots cannot become a new baseline or run a delayed composition', async () => {
  let value = '第一段'; const edits = [];
  const input = createRetainedInput({ read: () => value, apply: edit => { edits.push(edit); return false; }, rejected: assert.fail });
  assert.equal(input.flush(), false); assert.equal(input.value, '');
  input.finalize(); input.reset(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(edits.length, 1);
});
