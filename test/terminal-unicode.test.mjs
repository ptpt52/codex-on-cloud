import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalWidthProvider, validTerminalWidths, terminalGraphemeRanges } from '../panel/public/terminal-unicode.js';

test('node Unicode widths preserve combining cells, emoji columns and unknown characters', () => {
  const provider = terminalWidthProvider({ key: '0'.repeat(64), ranges: [[0x301, 0x301, 0], [0x4e00, 0x9fff, 2], [0x1f4c1, 0x1f4c1, 2]] });
  assert.equal(provider.wcwidth('中'.codePointAt(0)), 2);
  assert.equal(provider.wcwidth('📁'.codePointAt(0)), 2);
  assert.equal(provider.wcwidth('🧪'.codePointAt(0)), 1);
  assert.equal(provider.charProperties(0x301, 2), 3);
  assert.equal(provider.charProperties(0x301, 4), 5);
  assert.equal(provider.charProperties(0x301, 0), 0);
  assert.equal(validTerminalWidths({ key: '0'.repeat(64), ranges: Array(1025).fill([0, 0, 0]) }), false);
  assert.throws(() => terminalWidthProvider({}), TypeError);
});

test('combined emoji reserve the whole backend cell range without joining ordinary text', () => {
  assert.deepEqual(terminalGraphemeRanges('A👩‍💻B🇨🇳C👍🏻D'), [[1, 6], [7, 11], [12, 16]]);
  assert.deepEqual(terminalGraphemeRanges('Ae\u0301B中文'), [[1, 3]]);
});

const modernWidths = { key: '1'.repeat(64), combine: 21, ranges: [[0x200d, 0x200d, 0], [0x4e00, 0x9fff, 2], [0xfe0f, 0xfe0f, 0], [0x1f000, 0x1faff, 2]] };
test('modern tmux combines emoji contextually and respects its bounded UTF-8 cells', () => {
  const width = (text, combine) => {
    const provider = terminalWidthProvider({ ...modernWidths, combine }); let previous = 0, total = 0;
    for (const point of text) {
      const next = provider.charProperties(point.codePointAt(0), previous);
      total += ((next >>> 1) & 3) - (next & 1 ? (previous >>> 1) & 3 : 0); previous = next;
    }
    return total;
  };
  for (const text of ['A👩‍💻B', 'A👍🏻B', 'A🇨🇳B', 'A✈️B']) assert.equal(width(text, 21), 4, text);
  assert.equal(width('A👩‍👩‍👧‍👦B', 21), 6);
  assert.equal(width('A👩‍👩‍👧‍👦B', 32), 4);
  assert.equal(width('A👍🏻B', 0), 6);
  assert.equal(width('A🏻B', 21), 4, 'a modifier cannot join a plain ASCII base');
  for (const combine of [true, 1, 20, 33, null]) assert.equal(validTerminalWidths({ ...modernWidths, combine }), false);
});
