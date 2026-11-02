import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryStyles, TERMINAL_THEME, HISTORY_STYLE_LIMIT } from '../panel/public/terminal-history-style.js';

const text = value => value.runs.map(run => run.text).join('');
test('history styling preserves literal Unicode, spaces, indentation and line endings', () => {
  const source = '  中文😀\t<table> literal & text\r\n    code();\n';
  const value = parseHistoryStyles(source);
  assert.equal(text(value), source); assert.equal(value.simplified, false);
  assert.equal(value.runs[0].style.color, TERMINAL_THEME.foreground);
  assert.equal(value.runs[0].style.backgroundColor, TERMINAL_THEME.background);
});
test('history uses the live palette, bold bright colors and attribute resets', () => {
  const value = parseHistoryStyles('\x1b[31mred\x1b[1mbold\x1b[22mnormal\x1b[3;4;9;53mdecorated\x1b[0mdefault');
  assert.deepEqual(value.runs.map(run => run.text), ['red', 'bold', 'normal', 'decorated', 'default']);
  assert.equal(value.runs[0].style.color, TERMINAL_THEME.red);
  assert.equal(value.runs[1].style.color, TERMINAL_THEME.brightRed); assert.equal(value.runs[1].style.fontWeight, 'bold');
  assert.equal(value.runs[2].style.color, TERMINAL_THEME.red); assert.equal(value.runs[2].style.fontWeight, 'normal');
  assert.equal(value.runs[3].style.fontStyle, 'italic'); assert.equal(value.runs[3].style.textDecorationLine, 'underline line-through overline');
  assert.equal(value.runs[4].style.color, TERMINAL_THEME.foreground); assert.equal(value.runs[4].style.textDecorationLine, 'none');
});
test('history supports indexed colors, RGB, background, inverse, dim and underline colors', () => {
  for (const [index, expected] of [[0, TERMINAL_THEME.black], [15, TERMINAL_THEME.brightWhite], [16, '#000000'], [21, '#0000ff'], [231, '#ffffff'], [232, '#080808'], [255, '#eeeeee']]) {
    assert.equal(parseHistoryStyles(`\x1b[38;5;${index}mcolor`).runs[0].style.color, expected);
  }
  const value = parseHistoryStyles('\x1b[38;2;1;128;255;48;2;20;30;40mRGB\x1b[7minverse\x1b[27;2mdim\x1b[22;8mhidden\x1b[0;4:3;58:2::4:5:6munderline');
  assert.equal(value.runs[0].style.color, '#0180ff'); assert.equal(value.runs[0].style.backgroundColor, '#141e28');
  assert.equal(value.runs[1].style.color, '#141e28'); assert.equal(value.runs[1].style.backgroundColor, '#0180ff');
  assert.equal(value.runs[2].style.color, 'rgba(1,128,255,0.5)');
  assert.equal(value.runs[3].style.color, value.runs[3].style.backgroundColor);
  assert.equal(value.runs[4].style.textDecorationStyle, 'wavy'); assert.equal(value.runs[4].style.textDecorationColor, '#040506');
  assert.equal(parseHistoryStyles('\x1b[38:2::7:8:9mcolon').runs[0].style.color, '#070809');
});
test('history drops OSC, DCS, terminal queries and control strings without executing them or changing text positions', () => {
  const source = 'before\x1b]52;c;clipboard-secret\x07\x1b[6n\x1b[2J\x1bPqsecret\x1b\\\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\x9d52;c;c1-secret\x9c\x90dcs-secret\x9c\x00\x08after\x1b[31';
  assert.equal(text(parseHistoryStyles(source)), 'beforelinkafter');
  const plain = parseHistoryStyles('\x1b[1;31mplain\x1b[0m', false);
  assert.equal(text(plain), 'plain'); assert.equal(plain.runs[0].style.color, TERMINAL_THEME.foreground);
  assert.equal(plain.runs[0].style.fontWeight, 'normal');
});
test('malformed and unsupported style parameters cannot inject CSS or consume unbounded resources', () => {
  const value = parseHistoryStyles('\x1b[38;2;999;0;0mplain\x1b[38;5;256mstill plain\x1b[' + '1;'.repeat(100) + '31mlong\x1b[?1mprivate');
  assert.equal(text(value), 'plainstill plainlongprivate'); assert.equal(value.runs[0].style.color, TERMINAL_THEME.foreground);
  assert.equal(value.runs[0].style.fontWeight, 'normal');
  assert.throws(() => parseHistoryStyles('x'.repeat(65537)), RangeError);
});
test('style run bounds simplify excessive styling while retaining every character', () => {
  const value = parseHistoryStyles('\x1b[31ma\x1b[32mb'.repeat(3000));
  assert.equal(value.simplified, true); assert.ok(value.runs.length <= HISTORY_STYLE_LIMIT + 1);
  assert.equal(text(value), 'ab'.repeat(3000));
});
