// Match the pinned xterm 6 palette. Only text and SGR attributes reach the DOM;
// no terminal parser, HTML, URLs, clipboard operations or network requests.
import { HISTORY_BYTES, MAX_HISTORY_ROWS } from './terminal-history-limits.js';
const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const ansi = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
export const TERMINAL_THEME = Object.freeze({ background: '#222222', foreground: '#e7eee9', cursor: '#f7971d', selectionBackground: '#584329',
  ...Object.fromEntries(names.map((name, index) => [name, ansi[index]])) });
export const HISTORY_STYLE_LIMIT = 4096;
export const HISTORY_TEXT_LIMIT = HISTORY_BYTES, HISTORY_SEARCH_LIMIT = 1000, HISTORY_QUERY_LIMIT = 128;
const defaults = () => ({ fg: null, bg: null, underlineColor: null, bold: false, dim: false, italic: false, underline: 0, inverse: false, hidden: false, strike: false, overline: false });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
const rgb = values => '#' + values.map(value => value.toString(16).padStart(2, '0')).join('');
function color(index) {
  if (index < 16) return ansi[index];
  if (index >= 232) return rgb(Array(3).fill(8 + (index - 232) * 10));
  const levels = [0, 95, 135, 175, 215, 255], value = index - 16;
  return rgb([levels[Math.floor(value / 36)], levels[Math.floor(value / 6) % 6], levels[value % 6]]);
}
function css(attrs) {
  let foreground = attrs.inverse ? attrs.bg : attrs.fg;
  const background = attrs.inverse ? attrs.fg : attrs.bg;
  if (attrs.bold && Number.isInteger(foreground) && foreground < 8) foreground += 8;
  let fg = foreground === null ? TERMINAL_THEME[attrs.inverse ? 'background' : 'foreground'] : typeof foreground === 'number' ? color(foreground) : foreground;
  const bg = background === null ? TERMINAL_THEME[attrs.inverse ? 'foreground' : 'background'] : typeof background === 'number' ? color(background) : background;
  if (attrs.hidden) fg = bg;
  if (attrs.dim && !attrs.hidden) fg = `rgba(${[1, 3, 5].map(start => parseInt(fg.slice(start, start + 2), 16)).join(',')},0.5)`;
  const decorations = [attrs.underline ? 'underline' : '', attrs.strike ? 'line-through' : '', attrs.overline ? 'overline' : ''].filter(Boolean).join(' ');
  return { color: fg, backgroundColor: bg, fontWeight: attrs.bold ? 'bold' : 'normal', fontStyle: attrs.italic ? 'italic' : 'normal',
    textDecorationLine: decorations || 'none', textDecorationStyle: ['solid', 'solid', 'double', 'wavy', 'dotted', 'dashed'][attrs.underline] || 'solid',
    textDecorationColor: attrs.underlineColor === null ? 'currentColor' : typeof attrs.underlineColor === 'number' ? color(attrs.underlineColor + (attrs.bold && attrs.underlineColor < 8 ? 8 : 0)) : attrs.underlineColor };
}
function extended(parts) {
  if (parts[0] === 5 && parts.length === 2 && byte(parts[1])) return parts[1];
  if (parts[0] === 2 && (parts.length === 4 || parts.length === 5) && parts.slice(-3).every(byte)) return rgb(parts.slice(-3));
  return undefined;
}
function sgr(attrs, parameters) {
  const parts = parameters.split(';');
  for (let index = 0; index < parts.length; index++) {
    const sub = parts[index].split(':'), value = Number(sub[0]);
    if (value === 0) attrs = defaults();
    else if (value === 1) attrs.bold = true;
    else if (value === 2) attrs.dim = true;
    else if (value === 3) attrs.italic = true;
    else if (value === 4) attrs.underline = sub.length === 1 ? 1 : Math.min(5, Number(sub[1]) || 0);
    else if (value === 7) attrs.inverse = true;
    else if (value === 8) attrs.hidden = true;
    else if (value === 9) attrs.strike = true;
    else if (value === 21) attrs.underline = 2;
    else if (value === 22) attrs.bold = attrs.dim = false;
    else if (value === 23) attrs.italic = false;
    else if (value === 24) attrs.underline = 0;
    else if (value === 27) attrs.inverse = false;
    else if (value === 28) attrs.hidden = false;
    else if (value === 29) attrs.strike = false;
    else if (value >= 30 && value <= 37) attrs.fg = value - 30;
    else if (value >= 40 && value <= 47) attrs.bg = value - 40;
    else if (value >= 90 && value <= 97) attrs.fg = value - 90 + 8;
    else if (value >= 100 && value <= 107) attrs.bg = value - 100 + 8;
    else if ([38, 48, 58].includes(value)) {
      let parameters;
      if (sub.length > 1) parameters = sub.slice(1).map(Number);
      else {
        const count = parts[index + 1] === '2' ? 4 : parts[index + 1] === '5' ? 2 : 1;
        parameters = parts.slice(index + 1, index + 1 + count).map(Number); index += count;
      }
      const color = extended(parameters);
      if (color !== undefined) attrs[value === 38 ? 'fg' : value === 48 ? 'bg' : 'underlineColor'] = color;
    } else if (value === 39) attrs.fg = null;
    else if (value === 49) attrs.bg = null;
    else if (value === 53) attrs.overline = true;
    else if (value === 55) attrs.overline = false;
    else if (value === 59) attrs.underlineColor = null;
  }
  return attrs;
}
function appendRun(parsed, value, style) {
  if (!value) return;
  const { runs } = parsed, key = JSON.stringify(style), last = runs.at(-1);
  if (!parsed.simplified && last?.key === key) { last.text += value; return; }
  if (runs.length >= HISTORY_STYLE_LIMIT) {
    parsed.simplified = true;
    if (runs.length === HISTORY_STYLE_LIMIT) runs.push({ text: value, style: css(defaults()), key: '' });
    else runs.at(-1).text += value;
  } else runs.push({ text: value, style, key });
}
export function parseHistoryStyles(text, styled = true) {
  if (typeof text !== 'string' || text.length > HISTORY_TEXT_LIMIT) throw new RangeError('history text bound');
  let attrs = defaults(), index = 0;
  const parsed = { runs: [], simplified: false };
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 27 || [144, 152, 155, 157, 158, 159].includes(code)) {
      const kind = code === 27 ? text[++index] : ({ 144: 'P', 152: 'X', 155: '[', 157: ']', 158: '^', 159: '_' })[code]; index++;
      if (kind === '[') {
        const start = index;
        while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x3f) index++;
        const final = text.charCodeAt(index);
        if (final >= 0x40 && final <= 0x7e) {
          const parameters = text.slice(start, index);
          if (styled && final === 109 && parameters.length <= 128 && /^[\d;:]*$/.test(parameters)) attrs = sgr(attrs, parameters);
          index++;
        }
      } else if ([']', 'P', '_', '^', 'X'].includes(kind)) {
        while (index < text.length) {
          const value = text.charCodeAt(index++);
          if (value === 156 || (kind === ']' && value === 7)) break;
          if (value === 27 && text[index] === '\\') { index++; break; }
        }
      } else {
        while (index < text.length && text.charCodeAt(index - 1) >= 0x20 && text.charCodeAt(index - 1) <= 0x2f) index++;
      }
    } else if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159)) index++;
    else {
      const start = index++;
      while (index < text.length) {
        const next = text.charCodeAt(index);
        if ((next < 32 && ![9, 10, 13].includes(next)) || (next >= 127 && next <= 159)) break;
        index++;
      }
      appendRun(parsed, text.slice(start, index), css(attrs));
    }
  }
  return parsed;
}
export function findHistoryMatches(text, query) {
  if (text.length > HISTORY_TEXT_LIMIT) throw new RangeError('history text bound');
  query = query.slice(0, HISTORY_QUERY_LIMIT).replace(/[\uD800-\uDBFF]$/, '');
  if (!query) return { matches: [], limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), matches = [];
  let found;
  while ((found = pattern.exec(text))) {
    if (matches.length === HISTORY_SEARCH_LIMIT) return { matches, limited: true };
    matches.push({ start: found.index, end: found.index + found[0].length });
  }
  return { matches, limited: false };
}
export function captureHistoryBuffer(term) {
  const buffer = term.buffer.active, encoder = new TextEncoder(), rows = [], older = [], parsed = { runs: [], simplified: false, softBreaks: [] };
  const plainStyle = css(defaults());
  let bytes = 0, truncated = false;
  const first = Math.min(buffer.viewportY, buffer.length - 1), last = Math.min(buffer.length - 1, first + MAX_HISTORY_ROWS + 199);
  function row(index, prepend = false) {
    const line = buffer.getLine(index), wraps = index + 1 < buffer.length && buffer.getLine(index + 1)?.isWrapped;
    let end = Math.min(line?.length || 0, term.cols);
    // Keep real spaces inside a wrapped command, excluding unused filler
    // before a wide character which had to move to the next row.
    if (wraps) while (end && line.getCell(end - 1)?.getWidth() && !line.getCell(end - 1)?.getChars()) end--;
    const text = line?.translateToString(!wraps, 0, end).slice(0, HISTORY_TEXT_LIMIT) || '';
    const length = encoder.encode(text).length + 1;
    if (bytes + length > HISTORY_TEXT_LIMIT) { truncated = true; return false; }
    bytes += length; (prepend ? older : rows).push({ index, text }); return true;
  }
  for (let index = first; index <= last; index++) if (!row(index)) break;
  for (let index = first - 1; index >= 0; index--) if (!row(index, true)) break;
  rows.unshift(...older.reverse());
  const cell = buffer.getNullCell();
  let offset = 0;
  for (let index = 0; index < rows.length; index++) {
    const source = rows[index], line = buffer.getLine(source.index); let length = 0, runText = '', runKey, runStyle;
    const flush = () => { appendRun(parsed, runText, runStyle); runText = ''; };
    for (let col = 0; col < Math.min(line.length, term.cols) && length < source.text.length; col++) {
      if (parsed.simplified) { flush(); appendRun(parsed, source.text.slice(length), plainStyle); break; }
      line.getCell(col, cell); if (!cell.getWidth()) continue;
      const chars = (cell.getChars() || ' ').slice(0, source.text.length - length); length += chars.length;
      if (cell.isAttributeDefault()) {
        if (runKey !== 'default') { flush(); runKey = 'default'; runStyle = plainStyle; }
      } else {
        const flags = [cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()].map(Boolean);
        // The pinned xterm cell exposes extended underline attributes beyond
        // the public boolean. Keep them in the key as well as the saved CSS.
        const underlineStyle = cell.getUnderlineStyle?.() ?? (flags[3] ? 1 : 0);
        const underlineColor = cell.isUnderlineColorRGB?.() ? '#' + cell.getUnderlineColor().toString(16).padStart(6, '0')
          : cell.isUnderlineColorPalette?.() ? cell.getUnderlineColor() : null;
        const key = [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), ...flags, underlineStyle, underlineColor].join(':');
        if (key !== runKey) {
          flush(); runKey = key;
          const value = (foreground) => {
            const mode = foreground ? cell.isFgRGB() : cell.isBgRGB(), palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
            const color = foreground ? cell.getFgColor() : cell.getBgColor();
            return mode ? '#' + color.toString(16).padStart(6, '0') : palette ? color : null;
          };
          const [bold, dim, italic, , inverse, hidden, strike, overline] = flags;
          runStyle = css({ ...defaults(), fg: value(true), bg: value(false), bold, dim, italic, underline: underlineStyle, underlineColor, inverse, hidden, strike, overline });
        }
      }
      runText += chars;
    }
    flush();
    offset += source.text.length;
    if (index < rows.length - 1) {
      if (buffer.getLine(rows[index + 1].index)?.isWrapped) parsed.softBreaks.push(offset);
      appendRun(parsed, '\n', plainStyle); offset++;
    }
  }
  return { ...parsed, truncated: truncated || rows[0]?.index > 0 || rows.at(-1)?.index < buffer.length - 1,
    viewportRow: Math.max(0, first - (rows[0]?.index || 0)) };
}
// Physical row breaks are for display only. Search, clipboard and downloads
// retain hard newlines while joining soft wraps, with no second text buffer.
export function historyText(parsed, start = 0, end = Infinity) {
  const text = parsed.runs.map(run => run.text).join(''); end = Math.min(end, text.length);
  let cursor = start, result = '';
  for (const point of parsed.softBreaks || []) {
    if (point < start) continue;
    if (point >= end) break;
    result += text.slice(cursor, point); cursor = point + 1;
  }
  return result + text.slice(cursor, end);
}
export function historyMatchRanges(parsed, matches) {
  const breaks = parsed.softBreaks || [];
  const visual = (offset, inclusive) => {
    let low = 0, high = breaks.length;
    while (low < high) {
      const middle = (low + high) >>> 1, logical = breaks[middle] - middle;
      if (logical < offset || (inclusive && logical === offset)) low = middle + 1; else high = middle;
    }
    return offset + low;
  };
  return matches.map(match => ({ start: visual(match.start, true), end: visual(match.end, false) }));
}
function* historyCells(text, unicode) {
  let properties = 0, start = 0, offset = 0, width = 0, cell = '';
  for (const char of text) {
    if (char === '\n' || char === '\r' || char === '\t') {
      if (cell) yield { offset: start, text: cell, width };
      yield { offset, text: char, width: 0 }; offset += char.length;
      properties = 0; cell = ''; continue;
    }
    const next = unicode.charProperties?.(char.codePointAt(0), properties);
    const scalar = next === undefined ? unicode.wcwidth(char.codePointAt(0)) : (next >>> 1) & 3;
    const join = next === undefined ? scalar === 0 && !!cell : !!(next & 1);
    if (!join && cell) { yield { offset: start, text: cell, width }; cell = ''; }
    if (!cell) start = offset;
    cell += char; offset += char.length;
    width = next === undefined && join ? width : scalar; properties = next || 0;
  }
  if (cell) yield { offset: start, text: cell, width };
}
export function wrapHistoryRows(parsed, cols, widths) {
  const unicode = typeof widths === 'function' ? { wcwidth: widths } : widths;
  const result = { runs: [], simplified: parsed.simplified, softBreaks: [] };
  // capture-pane -J retains the last row's empty padding. Match ordinary
  // capture-pane's trimmed line endings before placing the joined text.
  const source = parsed.runs.map(run => run.text).join(''), padding = [], pattern = / +(?=\n|$)/g;
  let found;
  while ((found = pattern.exec(source))) {
    if (padding.length >= MAX_HISTORY_ROWS + 200) { result.simplified = true; break; }
    padding.push([found.index, found.index + found[0].length]);
  }
  const trimmed = { runs: [], simplified: parsed.simplified };
  let sourceOffset = 0, paddingIndex = 0;
  for (const run of parsed.runs) {
    let text = '';
    for (const char of run.text) {
      while (paddingIndex < padding.length && padding[paddingIndex][1] <= sourceOffset) paddingIndex++;
      const skip = paddingIndex < padding.length && sourceOffset >= padding[paddingIndex][0];
      sourceOffset += char.length;
      if (skip) continue;
      text += char;
    }
    appendRun(trimmed, text, run.style);
  }
  // Find row boundaries using the same context-sensitive cells as xterm.
  // A modifier can widen its previous cell; wrap the complete cell together.
  const breaks = []; let column = 0;
  for (const cell of historyCells(trimmed.runs.map(run => run.text).join(''), unicode)) {
    if (cell.text === '\n' || cell.text === '\r') column = 0;
    else if (cell.width > 0) {
      if (column + cell.width > cols) {
        if (breaks.length >= MAX_HISTORY_ROWS + 200) result.simplified = true;
        else breaks.push(cell.offset);
        column = 0;
      }
      column += cell.width;
    }
  }
  let offset = 0, breakIndex = 0;
  for (const run of trimmed.runs) {
    let text = '', cursor = 0;
    while (breakIndex < breaks.length && breaks[breakIndex] < offset + run.text.length) {
      const end = breaks[breakIndex] - offset;
      text += run.text.slice(cursor, end) + '\n'; cursor = end;
      result.softBreaks.push(breaks[breakIndex] + breakIndex); breakIndex++;
    }
    appendRun(result, text + run.text.slice(cursor), run.style); offset += run.text.length;
  }
  return result;
}
// Match the pinned xterm 6 DOM renderer's column widths and font variants.
// A proportional CJK fallback otherwise packs a pre more tightly than xterm.
// Reuse its read-only Unicode width service rather than maintaining another
// Unicode table. Browser coverage also checks this pinned internal adapter.
export function createHistoryGrid(term, host) {
  const unicode = term._core?.unicodeService;
  const measure = host.ownerDocument.createElement('span');
  measure.setAttribute('aria-hidden', 'true');
  Object.assign(measure.style, { position: 'absolute', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
    whiteSpace: 'pre', fontKerning: 'none' });
  const cache = new Map();
  // Bound added DOM, glyph cache and synchronous measurements independently
  // of the existing 1 MiB text / 4,096 style-run limits. One temporary measure
  // node is removed after every render, including errors. Text is never dropped.
  let key = '', cell = 0, nodes = 0, measurements = 0, limited = false;
  function update() {
    const width = host.querySelector('.xterm-screen')?.getBoundingClientRect().width;
    const next = `${width / term.cols}:${term.options.fontSize}:${term.options.fontFamily}`;
    if (next === key) return false;
    key = next; cell = width / term.cols;
    measure.style.fontSize = `${term.options.fontSize}px`; measure.style.fontFamily = term.options.fontFamily;
    cache.clear(); return true;
  }
  function spacing(text, columns, style) {
    const key = `${style.fontWeight}:${style.fontStyle}:${text}`;
    if (cache.has(key)) return cache.get(key);
    if (measurements >= 2048) { limited = true; return 0; }
    measurements++;
    measure.style.fontWeight = style.fontWeight; measure.style.fontStyle = style.fontStyle;
    // Use the same DOM measurement as xterm's WidthCache, including inherited
    // CJK punctuation spacing. Canvas can compress repeated fullwidth marks
    // differently, adding half a cell after every comma in a long paragraph.
    measure.textContent = text.repeat(32);
    const value = columns * cell - measure.offsetWidth / 32;
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    cache.set(key, value); return value;
  }
  function append(parent, text, style) {
    if (!(cell > 0) || typeof unicode?.wcwidth !== 'function' || nodes >= 16384) {
      limited ||= typeof unicode?.wcwidth !== 'function' || nodes >= 16384; parent.append(text); return;
    }
    let cluster = '', columns = 0, group = '', controls = '', groupSpacing, consumed = 0;
    const flush = () => {
      if (!group) return;
      if (nodes >= 16384) { limited = true; parent.append(group); group = ''; return; }
      const span = host.ownerDocument.createElement('span'); span.className = 'history-grid-run';
      span.style.letterSpacing = `${groupSpacing}px`;
      for (const name of ['textDecorationLine', 'textDecorationStyle', 'textDecorationColor']) span.style[name] = style[name];
      span.textContent = group; parent.append(span); nodes++; group = '';
    };
    const emit = () => {
      if (!cluster) return;
      const value = spacing(cluster, columns, style);
      if (group && value !== groupSpacing) flush();
      groupSpacing = value; group += cluster; cluster = '';
    };
    for (const { segment: char } of graphemes.segment(text)) {
      if (nodes >= 16384) {
        limited = true; parent.append(group + cluster + controls + text.slice(consumed)); return;
      }
      if (/^[\n\r\t]+$/.test(char)) { emit(); flush(); controls += char; }
      else {
        if (controls) { parent.append(controls); controls = ''; }
        if (char.length > 64) { emit(); flush(); limited = true; parent.append(char); consumed += char.length; continue; }
        let width = 0;
        if (unicode.getStringCellWidth) width = unicode.getStringCellWidth(char);
        else for (const point of char) width += unicode.wcwidth(point.codePointAt(0));
        if (width === 0 && cluster && cluster.length + char.length <= 64) cluster += char;
        else { emit(); cluster = char; columns = width; }
      }
      consumed += char.length;
    }
    emit(); flush(); if (controls) parent.append(controls);
  }
  return { update, append, begin() { update(); nodes = measurements = 0; limited = false; host.appendChild(measure); },
    end() { measure.remove(); measure.textContent = ''; }, get limited() { return limited; } };
}
export function historyHighlightRanges(text, matches) {
  if (!matches.length) return [];
  const expanded = matches.map((match, index) => ({ ...match, indexes: [index] }));
  const segments = graphemes.segment(text);
  let first = 0;
  for (const segment of segments) {
    const start = segment.index, end = start + segment.segment.length;
    while (first < matches.length && matches[first].end <= start) first++;
    if (first === matches.length) break;
    for (let index = first; index < matches.length && matches[index].start < end; index++) {
      expanded[index].start = Math.min(expanded[index].start, start);
      expanded[index].end = Math.max(expanded[index].end, end);
    }
  }
  const ranges = [];
  for (const match of expanded) {
    const last = ranges.at(-1);
    if (last && match.start < last.end) {
      last.end = Math.max(last.end, match.end); last.indexes.push(...match.indexes);
    } else ranges.push(match);
  }
  return ranges;
}
export function renderHistoryRuns(element, parsed, matches = [], grid) {
  const fragment = element.ownerDocument.createDocumentFragment(), groups = matches.map(() => []);
  const highlights = historyHighlightRanges(parsed.runs.map(run => run.text).join(''), matches);
  grid?.begin();
  const append = (parent, text, style) => grid ? grid.append(parent, text, style) : parent.append(text);
  let offset = 0, matchIndex = 0;
  try {
    for (const run of parsed.runs) {
      const span = element.ownerDocument.createElement('span');
      Object.assign(span.style, run.style);
      let cursor = 0;
      while (cursor < run.text.length) {
        while (matchIndex < highlights.length && highlights[matchIndex].end <= offset + cursor) matchIndex++;
        const match = highlights[matchIndex], end = offset + run.text.length;
        if (!match || match.start >= end) { append(span, run.text.slice(cursor), run.style); break; }
        if (offset + cursor < match.start) { append(span, run.text.slice(cursor, match.start - offset), run.style); cursor = match.start - offset; }
        const boundary = Math.min(end, match.end) - offset, mark = element.ownerDocument.createElement('mark');
        append(mark, run.text.slice(cursor, boundary), run.style); mark.dataset.match = String(match.indexes[0]);
        for (const index of match.indexes) groups[index].push(mark);
        span.appendChild(mark); cursor = boundary;
      }
      offset += run.text.length; fragment.appendChild(span);
    }
  } finally { grid?.end(); }
  element.replaceChildren(fragment);
  return groups;
}
export function renderHistoryStyles(element, text, styled) {
  const parsed = parseHistoryStyles(text, styled);
  renderHistoryRuns(element, parsed);
  return parsed.simplified;
}
