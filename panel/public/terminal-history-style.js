// Match the pinned xterm 6 palette. Only text and SGR attributes reach the DOM;
// no terminal parser, HTML, URLs, clipboard operations or network requests.
const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const ansi = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
export const TERMINAL_THEME = Object.freeze({ background: '#151d1a', foreground: '#e7eee9', cursor: '#a8d8b7', selectionBackground: '#3e6652',
  ...Object.fromEntries(names.map((name, index) => [name, ansi[index]])) });
export const HISTORY_STYLE_LIMIT = 4096;
export const HISTORY_TEXT_LIMIT = 65536, HISTORY_SEARCH_LIMIT = 1000, HISTORY_QUERY_LIMIT = 128;
const defaults = () => ({ fg: null, bg: null, underlineColor: null, bold: false, dim: false, italic: false, underline: 0, inverse: false, hidden: false, strike: false, overline: false });
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
  const buffer = term.buffer.active, encoder = new TextEncoder(), rows = [], parsed = { runs: [], simplified: false };
  let bytes = 0, truncated = false;
  const first = Math.min(buffer.viewportY, buffer.length - 1), last = Math.min(buffer.length - 1, first + 2199);
  function row(index, prepend = false) {
    const line = buffer.getLine(index), text = line?.translateToString(true, 0, term.cols).slice(0, HISTORY_TEXT_LIMIT) || '';
    const length = encoder.encode(text).length + 1;
    if (bytes + length > HISTORY_TEXT_LIMIT) { truncated = true; return false; }
    bytes += length; prepend ? rows.unshift({ index, text }) : rows.push({ index, text }); return true;
  }
  for (let index = first; index <= last; index++) if (!row(index)) break;
  for (let index = first - 1; index >= 0; index--) if (!row(index, true)) break;
  const cell = buffer.getNullCell();
  for (let index = 0; index < rows.length; index++) {
    const source = rows[index], line = buffer.getLine(source.index); let length = 0;
    for (let col = 0; col < Math.min(line.length, term.cols) && length < source.text.length; col++) {
      line.getCell(col, cell); if (!cell.getWidth()) continue;
      const chars = (cell.getChars() || ' ').slice(0, source.text.length - length); length += chars.length;
      const value = (foreground) => {
        const mode = foreground ? cell.isFgRGB() : cell.isBgRGB(), palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
        const color = foreground ? cell.getFgColor() : cell.getBgColor();
        return mode ? '#' + color.toString(16).padStart(6, '0') : palette ? color : null;
      };
      appendRun(parsed, chars, css({ ...defaults(), fg: value(true), bg: value(false), bold: !!cell.isBold(), dim: !!cell.isDim(), italic: !!cell.isItalic(),
        underline: cell.isUnderline() ? 1 : 0, inverse: !!cell.isInverse(), hidden: !!cell.isInvisible(), strike: !!cell.isStrikethrough(), overline: !!cell.isOverline() }));
    }
    if (index < rows.length - 1) appendRun(parsed, '\n', css(defaults()));
  }
  return { ...parsed, truncated: truncated || rows[0]?.index > 0 || rows.at(-1)?.index < buffer.length - 1,
    viewportRow: Math.max(0, first - (rows[0]?.index || 0)) };
}
export function renderHistoryRuns(element, parsed, matches = []) {
  const fragment = element.ownerDocument.createDocumentFragment(), groups = matches.map(() => []);
  let offset = 0, matchIndex = 0;
  for (const run of parsed.runs) {
    const span = element.ownerDocument.createElement('span');
    Object.assign(span.style, run.style);
    let cursor = 0;
    while (cursor < run.text.length) {
      while (matchIndex < matches.length && matches[matchIndex].end <= offset + cursor) matchIndex++;
      const match = matches[matchIndex], end = offset + run.text.length;
      if (!match || match.start >= end) { span.append(run.text.slice(cursor)); break; }
      if (offset + cursor < match.start) { span.append(run.text.slice(cursor, match.start - offset)); cursor = match.start - offset; }
      const boundary = Math.min(end, match.end) - offset, mark = element.ownerDocument.createElement('mark');
      mark.textContent = run.text.slice(cursor, boundary); mark.dataset.match = String(matchIndex); groups[matchIndex].push(mark); span.appendChild(mark); cursor = boundary;
    }
    offset += run.text.length; fragment.appendChild(span);
  }
  element.replaceChildren(fragment);
  return groups;
}
export function renderHistoryStyles(element, text, styled) {
  const parsed = parseHistoryStyles(text, styled);
  renderHistoryRuns(element, parsed);
  return parsed.simplified;
}
