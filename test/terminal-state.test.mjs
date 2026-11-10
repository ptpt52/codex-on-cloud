import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalState, DRAFT_LIMIT, DRAFT_SLOTS, STATE_LIMIT, TERMINAL_STATE_KEY } from '../panel/public/terminal-state.js';
const main = { id: 'main', token: '%0:4000' }, auxiliary = { id: 'aux1', token: '%1:4100' }, current = { id: '', token: '' };
function memory() { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }

test('shared-origin nodes with identical pane identities keep independent drafts and do not adopt unscoped legacy text', () => {
  const storage = memory(); Object.defineProperty(storage, 'length', { get: () => storage.map.size }); storage.key = index => [...storage.map.keys()][index] ?? null;
  createTerminalState(storage).save(main, 'legacy machine draft');
  const a = createTerminalState(storage, 'a'.repeat(32)), b = createTerminalState(storage, 'b'.repeat(32));
  assert.equal(a.read(main), ''); a.save(main, 'node A'); a.choose(main); assert.equal(b.read(main), ''); assert.equal(b.selection, null);
  b.save(main, 'node B'); assert.equal(createTerminalState(storage, 'a'.repeat(32)).read(main), 'node A');
  assert.equal(createTerminalState(storage, 'b'.repeat(32)).read(main), 'node B'); assert.equal(createTerminalState(storage).read(main), 'legacy machine draft');
});

test('node draft persistence has bounded namespace count and preserves prior nodes instead of evicting unsent text', () => {
  const storage = memory(); Object.defineProperty(storage, 'length', { get: () => storage.map.size }); storage.key = index => [...storage.map.keys()][index] ?? null;
  for (let n = 0; n < 16; n++) createTerminalState(storage, n.toString(16).padStart(32, '0')).save(main, 'keep');
  const next = createTerminalState(storage, 'f'.repeat(32)); next.save(main, 'still available in this tab'); assert.equal(next.persistenceFailed, true); assert.equal(next.read(main), 'still available in this tab'); assert.equal(storage.length, 16);
  assert.equal(createTerminalState(storage, '0'.repeat(32)).read(main), 'keep');
});

test('terminal drafts and selection survive reconstruction without crossing identities', () => {
  const storage = memory(), state = createTerminalState(storage);
  assert.equal(state.save(main, '主终端\n中文'), true); state.save(auxiliary, '日志'); state.choose(auxiliary);
  const restored = createTerminalState(storage);
  assert.deepEqual(restored.selection, auxiliary); assert.equal(restored.read(main), '主终端\n中文'); assert.equal(restored.read(auxiliary), '日志');
  assert.equal(restored.read({ ...auxiliary, token: '%1:4200' }), '');
});
test('all eight user terminals and the current window retain separate bounded drafts', () => {
  const storage = memory(), state = createTerminalState(storage);
  const identities = [current, main, ...Array.from({ length: 7 }, (_, index) => ({ id: `aux${index + 1}`, token: `%${index + 1}:${4100 + index}` }))];
  for (const identity of identities) assert.equal(state.save(identity, `草稿 ${identity.id}`), true);
  state.choose(identities.at(-1));
  const restored = createTerminalState(storage);
  for (const identity of identities) assert.equal(restored.read(identity), `草稿 ${identity.id}`);
  assert.deepEqual(restored.selection, identities.at(-1));
  assert.equal(restored.choose({ id: 'aux8', token: '%8:4200' }), false);
});
test('draft slots, individual text and escaped serialized state have explicit bounds', () => {
  const storage = memory(), state = createTerminalState(storage), identities = Array.from({ length: DRAFT_SLOTS }, (_, index) => ({ id: 'aux1', token: `%1:${4100 + index}` }));
  for (const identity of identities) assert.equal(state.save(identity, '\0'.repeat(DRAFT_LIMIT)), true);
  assert.equal(state.save({ id: 'aux2', token: '%2:5000' }, '超过容量'), false);
  assert.equal(state.save(identities[0], 'x'.repeat(DRAFT_LIMIT + 1)), false);
  assert.equal(state.read(identities[0]).length, DRAFT_LIMIT); assert.ok(storage.getItem(TERMINAL_STATE_KEY).length <= STATE_LIMIT);
  state.save(identities[1], ''); assert.equal(state.save({ id: 'aux2', token: '%2:5000' }, '新草稿'), true);
});
test('legacy draft migration adopts an unassigned draft once and never overwrites an existing terminal draft', () => {
  const storage = memory(); storage.setItem('codex-cloud.draft', '旧版草稿');
  const state = createTerminalState(storage); assert.equal(state.read(current), '旧版草稿');
  assert.equal(state.adoptWindow(main), true); assert.equal(state.read(main), '旧版草稿'); assert.equal(state.read(current), '');
  assert.equal(storage.getItem('codex-cloud.draft'), null);
  state.save(current, '另一份草稿'); assert.equal(state.adoptWindow(main), false); assert.equal(state.read(current), '另一份草稿');
});
test('stale cleanup preserves live and currently edited drafts', () => {
  const state = createTerminalState(memory()); const old = { id: 'aux2', token: '%2:4200' };
  state.save(main, '保留'); state.save(auxiliary, '仍在编辑'); state.save(old, '过期'); state.save(current, '未指定');
  assert.equal(state.stale([main], auxiliary), 1); state.clearStale([main], auxiliary);
  assert.equal(state.read(main), '保留'); assert.equal(state.read(auxiliary), '仍在编辑'); assert.equal(state.read(old), ''); assert.equal(state.read(current), '未指定');
});
test('storage denial preserves bounded drafts in memory and reports persistence failure', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const state = createTerminalState(storage); assert.equal(state.save(main, '不要丢失'), true); state.choose(main);
  assert.equal(state.read(main), '不要丢失'); assert.equal(state.persistenceFailed, true);
});
test('malformed identities and oversized saved state cannot restore an unsafe target', () => {
  const storage = memory(); storage.setItem(TERMINAL_STATE_KEY, ' '.repeat(STATE_LIMIT + 1));
  const state = createTerminalState(storage); assert.equal(state.selection, null);
  assert.equal(state.choose({ id: 'main', token: 'untrusted' }), false); assert.equal(state.save({ id: '__proto__', token: '%0:1' }, 'bad'), false);
});
