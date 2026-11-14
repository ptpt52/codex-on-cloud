// A bounded width table supplied by this node's tmux backend. Unlisted
// codepoints occupy one cell, including characters unknown to older hosts.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function validTerminalWidths(value) {
  if (!value || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || !Array.isArray(value.ranges) || value.ranges.length > 1024) return false;
  if (value.combine !== undefined && ![0, 21, 32].includes(value.combine)) return false;
  let previous = -1;
  for (const range of value.ranges) {
    if (!Array.isArray(range) || range.length !== 3) return false;
    const [start, end, width] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= previous || end < start || end > 0x10ffff || ![0, 2].includes(width)) return false;
    previous = end;
  }
  return true;
}
export function terminalWidthProvider(value) {
  if (!validTerminalWidths(value)) throw new TypeError('invalid terminal widths');
  const ranges = value.ranges;
  const wcwidth = codepoint => {
    let low = 0, high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1, [start, end, width] = ranges[middle];
      if (codepoint < start) high = middle - 1;
      else if (codepoint > end) low = middle + 1;
      else return width;
    }
    return 1;
  };
  return { version: 'node', wcwidth, charProperties(codepoint, preceding) {
    let width = wcwidth(codepoint);
    if (value.combine) {
      const bytes = codepoint < 0x80 ? 1 : codepoint < 0x800 ? 2 : codepoint < 0x10000 ? 3 : 4;
      const previousBytes = (preceding >>> 3) & 63, previousWidth = (preceding >>> 1) & 3;
      const zwj = codepoint === 0x200d, vs = codepoint === 0xfe0f;
      const modifier = (codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff) || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff);
      const zero = width === 0 || zwj || vs;
      const join = previousWidth > 0 && previousBytes + bytes <= value.combine &&
        (zero || (modifier && previousBytes > 1) || !!(preceding & 512));
      width = join ? (vs || (modifier && !zero) ? 2 : previousWidth) : zero ? 0 : width;
      return ((join ? previousBytes + bytes : bytes) << 3) | (zwj ? 512 : 0) | (width << 1) | Number(join);
    }
    const previousWidth = (preceding >> 1) & 3, join = width === 0 && previousWidth > 0;
    if (join) width = previousWidth;
    return (width << 1) | Number(join);
  } };
}
export function terminalGraphemeRanges(text) {
  const ranges = [];
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment.length > (segment.codePointAt(0) > 0xffff ? 2 : 1)) ranges.push([index, index + segment.length]);
  }
  return ranges;
}
