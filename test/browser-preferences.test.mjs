import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPreferences, decodeBrowserPreferences, BROWSER_PREFERENCES_KEY, BROWSER_PREFERENCES_LIMIT } from '../panel/public/browser-preferences.js';
function storage(text = null) {
  return { text, getItem(key) { assert.equal(key, BROWSER_PREFERENCES_KEY); return this.text; }, setItem(key, value) {
    assert.equal(key, BROWSER_PREFERENCES_KEY); assert.ok(value.length <= BROWSER_PREFERENCES_LIMIT); this.text = value;
  } };
}
test('browser preferences validate fields independently and discard server fields and credentials', () => {
  const value = decodeBrowserPreferences(JSON.stringify({ layout: 2, zoom: 'bad', pan: 'bad', terminalFontSize: 22, keepAwake: true,
    terminalHistoryRows: 5000, terminalWidthMode: 'manual', width: 4000, fontSize: 28, csrf: 'must not store', password: 'must not store' }));
  assert.equal(value.zoom, 'width'); assert.equal(value.pan, false); assert.equal(value.terminalFontSize, 22); assert.equal(value.keepAwake, true);
  assert.equal(value.terminalHistoryRows, 5000); assert.equal(value.terminalWidthMode, 'manual');
  for (const key of ['width','fontSize','csrf','password']) assert.equal(Object.hasOwn(value, key), false);
});
test('legacy layouts retain folding and dragging while malformed, oversized and invalid fields use bounded defaults', () => {
  const value = decodeBrowserPreferences(JSON.stringify({ zoom: 2, pan: true, collapsed: false, controlsCollapsed: false, autoResolution: true }));
  assert.equal(value.zoom, 'width'); assert.equal(value.autoResolution, false); assert.equal(value.pan, true); assert.equal(value.collapsed, false);
  for (const input of ['null', '[]', '{', 'x'.repeat(BROWSER_PREFERENCES_LIMIT + 1)]) assert.equal(decodeBrowserPreferences(input).terminalFontSize, 15);
  const invalid = decodeBrowserPreferences(JSON.stringify({ layout: 2, terminalFontSize: '20', terminalHistoryRows: 999999, keepAwake: 1, pointerMode: 'invalid' }));
  assert.equal(invalid.terminalFontSize, 15); assert.equal(invalid.terminalHistoryRows, 10000); assert.equal(invalid.keepAwake, false); assert.equal(invalid.pointerMode, 'touch');
});
test('separate browsers are isolated and stale pages merge only changed fields without changing their active view', () => {
  const firstStorage = storage(), otherStorage = storage(), first = createBrowserPreferences(firstStorage), stale = createBrowserPreferences(firstStorage);
  first.update({ terminalFontSize: 20, keepAwake: true });
  stale.update({ controlsCollapsed: false });
  const refreshed = createBrowserPreferences(firstStorage).value;
  assert.equal(refreshed.terminalFontSize, 20); assert.equal(refreshed.keepAwake, true); assert.equal(refreshed.controlsCollapsed, false);
  assert.equal(stale.value.terminalFontSize, 15); assert.equal(stale.value.keepAwake, false);
  assert.equal(createBrowserPreferences(otherStorage).value.terminalFontSize, 15); assert.equal(otherStorage.text, null);
});
test('unavailable browser storage keeps in-page preferences and never persists unrecognized fields', () => {
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  for (const source of [undefined, denied]) {
    const preferences = createBrowserPreferences(source); preferences.update({ terminalFontSize: 18, keepAwake: true });
    assert.equal(preferences.value.terminalFontSize, 18); assert.equal(preferences.value.keepAwake, true); assert.equal(preferences.persisted, false);
  }
  let writes = 0;
  const unreadable = createBrowserPreferences({ getItem() { throw Error('unreadable'); }, setItem() { writes++; } });
  unreadable.update({ terminalFontSize: 21 });
  assert.equal(unreadable.value.terminalFontSize, 21); assert.equal(unreadable.persisted, false); assert.equal(writes, 0);
  const source = storage(), preferences = createBrowserPreferences(source);
  preferences.update({ terminalFontSize: 99, csrf: 'never', width: 4000, mode: 'terminal' });
  assert.equal(preferences.value.terminalFontSize, 15); assert.equal(preferences.value.mode, 'terminal');
  assert.equal(Object.hasOwn(JSON.parse(source.text), 'csrf'), false); assert.equal(Object.hasOwn(JSON.parse(source.text), 'width'), false);
});

test('mode standby is off by default, validates a boolean and stays within browser storage', () => {
  assert.equal(decodeBrowserPreferences(null).modeStandby, false);
  assert.equal(decodeBrowserPreferences(JSON.stringify({ layout: 2, modeStandby: 1 })).modeStandby, false);
  const source = storage(), preferences = createBrowserPreferences(source);
  preferences.update({ modeStandby: true });
  assert.equal(createBrowserPreferences(source).value.modeStandby, true);
  assert.equal(createBrowserPreferences(storage()).value.modeStandby, false);
});
