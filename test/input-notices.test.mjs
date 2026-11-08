import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputNotices, INPUT_NOTICE_LIMIT } from '../panel/public/input-notices.js';

test('dismissal belongs to an event, including duplicates and parked frames, without acknowledging execution', () => {
  const notices = createInputNotices(() => 100);
  const event = { key: 'stream:1:abc', source: 'stream', mode: 'terminal', standby: true, reason: 'input-unknown' };
  const record = notices.add(event, { activate: false }); assert.equal(notices.current, null);
  notices.activate(record.key); assert.match(notices.current.message, /后台网页终端/);
  notices.dismiss(record.key); assert.equal(notices.current, null);
  notices.add(event); notices.activate(record.key); assert.equal(notices.current, null);
  assert.equal(notices.snapshot()[0].dismissed, true); assert.match(notices.snapshot()[0].message, /结果未知/);
  notices.add({ ...event, key: 'stream:1:def', standby: false, reason: 'input-pressure' });
  assert.match(notices.current.message, /发送缓冲达到上限/); assert.equal(notices.snapshot().length, 2);
  notices.current.dismissed = true; assert.equal(notices.current.dismissed, false);
  notices.clear(); assert.equal(notices.current, null); assert.deepEqual(notices.snapshot(), []);
});

test('source and operation are bounded metadata, with no payload or exception text retained', () => {
  const notices = createInputNotices();
  notices.add({ key: 'assistant:1', source: 'assistant', action: 'key', keyName: 'Enter', target: '主终端', reason: 'timeout', path: 'direct', text: 'PRIVATE', error: 'PRIVATE' });
  assert.match(notices.current.message, /输入助手 · 主终端：Enter 按键结果未知/);
  assert.match(notices.current.detail, /超时.*WebRTC/);
  assert.equal(JSON.stringify(notices.snapshot()).includes('PRIVATE'), false);
  assert.equal(notices.add({ key: 'bad', source: 'PRIVATE' }), null);
  for (let i = 0; i < 1000; i++) notices.add({ key: `history:${i}`, source: 'history', action: 'paste', target: '\0' + '长'.repeat(10000), reason: 'previous', keyName: 'PRIVATE', path: 'PRIVATE' });
  assert.equal(notices.snapshot().length, INPUT_NOTICE_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(notices.snapshot())) < 64 * 1024);
  assert.equal(notices.current.target.length, 24); assert.equal(JSON.stringify(notices.snapshot()).includes('PRIVATE'), false);
  assert.match(notices.current.message, /桌面执行服务.*上一项粘贴结果未知/);
});
