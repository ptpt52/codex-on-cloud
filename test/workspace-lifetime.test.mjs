import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceLifetime } from '../panel/public/workspace-lifetime.js';

test('page restoration revalidates the workspace without replaying feature operations and disposal removes hooks', () => {
  const target = new EventTarget(), calls = [];
  const feature = name => ({ suspend() { calls.push(name + ':suspend'); }, dispose() { calls.push(name + ':dispose'); } });
  const lifecycle = createWorkspaceLifetime(target, { features: [feature('files'), feature('clipboard')], onHide: () => calls.push('invalidate'), onShow: () => calls.push('revalidate') });
  target.dispatchEvent(new Event('pagehide')); target.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(calls, ['invalidate', 'files:suspend', 'clipboard:suspend', 'revalidate']);
  lifecycle.dispose(); lifecycle.dispose(); target.dispatchEvent(new Event('pagehide')); target.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(calls.slice(4), ['files:dispose', 'clipboard:dispose']);
});
test('the workspace feature registry is fixed and bounded', () => {
  assert.throws(() => createWorkspaceLifetime(new EventTarget(), { features: Array(9).fill({}) }));
  assert.throws(() => createWorkspaceLifetime(new EventTarget(), { features: null }));
});
