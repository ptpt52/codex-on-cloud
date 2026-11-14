import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalWidthProvider } from '../panel/public/terminal-unicode.js';
import { parseHistoryStyles, findHistoryMatches, captureHistoryBuffer, historyText, historyMatchRanges, historyHighlightRanges, wrapHistoryRows, TERMINAL_THEME, HISTORY_STYLE_LIMIT, HISTORY_TEXT_LIMIT } from '../panel/public/terminal-history-style.js';

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
  assert.throws(() => parseHistoryStyles('x'.repeat(HISTORY_TEXT_LIMIT + 1)), RangeError);
});
test('style run bounds simplify excessive styling while retaining every character', () => {
  const value = parseHistoryStyles('\x1b[31ma\x1b[32mb'.repeat(3000));
  assert.equal(value.simplified, true); assert.ok(value.runs.length <= HISTORY_STYLE_LIMIT + 1);
  assert.equal(text(value), 'ab'.repeat(3000));
});

test('history find is literal, case insensitive and keeps original Unicode offsets', () => {
  assert.deepEqual(findHistoryMatches('a.*b A.*B <img> [x]', 'a.*b').matches, [{ start: 0, end: 4 }, { start: 5, end: 9 }]);
  assert.deepEqual(findHistoryMatches('K k K 😀中文😀', 'k').matches, [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }]);
  assert.deepEqual(findHistoryMatches('K k K 😀中文😀', '😀').matches, [{ start: 6, end: 8 }, { start: 10, end: 12 }]);
  assert.deepEqual(findHistoryMatches('[x]', '[x]').matches, [{ start: 0, end: 3 }]);
  assert.deepEqual(findHistoryMatches('abc', ''), { matches: [], limited: false });
});

test('history find bounds query length and match count without regular expression execution', () => {
  const matches = findHistoryMatches('a'.repeat(5000), 'a'); assert.equal(matches.matches.length, 1000); assert.equal(matches.limited, true);
  assert.equal(findHistoryMatches('a'.repeat(128), 'a'.repeat(10000)).matches.length, 1);
  assert.equal(findHistoryMatches('(a+)+$', '(a+)+$').matches.length, 1);
  assert.throws(() => findHistoryMatches('x'.repeat(HISTORY_TEXT_LIMIT + 1), 'x'), RangeError);
});

test('history searches and copies logical lines while displaying soft-wrapped rows', () => {
  const original = 'ABC  中文123456\nHARD\nBREAK';
  const parsed = wrapHistoryRows(parseHistoryStyles(original), 6, point => point >= 0x4e00 ? 2 : 1);
  assert.equal(historyText(parsed), original);
  assert.equal(text(parsed), 'ABC  \n中文12\n3456\nHARD\nBREAK');
  const matches = historyMatchRanges(parsed, findHistoryMatches(historyText(parsed), '文123').matches);
  assert.equal(text(parsed).slice(matches[0].start, matches[0].end), '文12\n3');
  assert.equal(historyText(parsed, matches[0].start, matches[0].end), '文123');
  assert.deepEqual(findHistoryMatches(historyText(parsed), 'HARDBREAK').matches, []);
});

test('joined history wraps complete modern tmux emoji cells, including a selector that widens its base', () => {
  const unicode = terminalWidthProvider({ key: '1'.repeat(64), combine: 21, ranges: [[0x200d, 0x200d, 0], [0xfe0f, 0xfe0f, 0], [0x1f000, 0x1faff, 2]] });
  for (const emoji of ['✈️', '👍🏻', '👩‍💻', '🇨🇳']) {
    const original = 'ABC' + emoji + 'D', parsed = wrapHistoryRows(parseHistoryStyles(original), 4, unicode);
    assert.equal(text(parsed), 'ABC\n' + emoji + 'D'); assert.equal(historyText(parsed), original);
  }
});

test('partial matches highlight complete graphemes and shared emoji keep every navigation result', () => {
  for (const [text, query] of [['👩‍💻', '👩'], ['👩‍💻', '💻'], ['👍🏻', '🏻'], ['✈️', '\ufe0f'], ['🇨🇳', '🇨'], ['e\u0301', '\u0301']]) {
    const ranges = historyHighlightRanges(text, findHistoryMatches(text, query).matches);
    assert.deepEqual(ranges, [{ start: 0, end: text.length, indexes: [0] }]);
  }
  const family = '👩‍👩‍👧‍👦';
  assert.deepEqual(historyHighlightRanges(family, findHistoryMatches(family, '👩').matches), [{ start: 0, end: family.length, indexes: [0, 1] }]);
});

test('local history capture retains the reading window, colors and byte bounds using public buffer cells', () => {
  const lines = Array.from({ length: 20000 }, (_, index) => `ROW-${String(index).padStart(4, '0')} ` + 'x'.repeat(190));
  const cell = char => ({ getWidth: () => 1, getChars: () => char, isAttributeDefault: () => false, getFgColorMode: () => 1, getBgColorMode: () => 0, isFgRGB: () => false, isFgPalette: () => true, getFgColor: () => 1,
    isBgRGB: () => false, isBgPalette: () => false, getBgColor: () => 0, isBold: () => 1, isDim: () => 0, isItalic: () => 0,
    isUnderline: () => 0, isInverse: () => 0, isInvisible: () => 0, isStrikethrough: () => 0, isOverline: () => 0 });
  const buffer = { length: lines.length, viewportY: 600, getNullCell: () => ({}), getLine: index => ({ length: lines[index].length,
    translateToString: () => lines[index], getCell: (col, target) => Object.assign(target, cell(lines[index][col])) }) };
  const value = captureHistoryBuffer({ buffer: { active: buffer }, cols: 200 }), captured = text(value);
  assert.ok(Buffer.byteLength(captured) <= HISTORY_TEXT_LIMIT); assert.ok(Buffer.byteLength(captured) > 65536);
  assert.ok(captured.startsWith('ROW-0600')); assert.ok(!captured.includes('ROW-0000'));
  assert.equal(value.truncated, true); assert.equal(value.viewportRow, 0); assert.equal(value.runs[0].style.color, TERMINAL_THEME.brightRed);
  assert.equal(value.runs[0].style.fontWeight, 'bold'); assert.ok(value.runs.length <= HISTORY_STYLE_LIMIT + 1);
});
