// Match the pinned xterm 6 palette. Only text and SGR attributes reach the DOM;
// no terminal parser, HTML, URLs, clipboard operations or network requests.
const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const ansi = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
export const TERMINAL_THEME = Object.freeze({ background: '#151d1a', foreground: '#e7eee9', cursor: '#a8d8b7', selectionBackground: '#3e6652',
  ...Object.fromEntries(names.map((name, index) => [name, ansi[index]])) });
export const HISTORY_STYLE_LIMIT = 4096;
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
export function parseHistoryStyles(text, styled = true) {
  if (typeof text !== 'string' || text.length > 65536) throw new RangeError('history text bound');
  let attrs = defaults(), simplified = false, index = 0;
  const runs = [];
  function append(value) {
    if (!value) return;
    const style = css(simplified ? defaults() : attrs), key = JSON.stringify(style), last = runs.at(-1);
    if (last?.key === key) { last.text += value; return; }
    if (runs.length >= HISTORY_STYLE_LIMIT) {
      simplified = true;
      if (runs.length === HISTORY_STYLE_LIMIT) runs.push({ text: value, style: css(defaults()), key: '' });
      else runs.at(-1).text += value;
      return;
    }
    runs.push({ text: value, style, key });
  }
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
      append(text.slice(start, index));
    }
  }
  return { runs, simplified };
}
export function renderHistoryStyles(element, text, styled) {
  const parsed = parseHistoryStyles(text, styled), fragment = element.ownerDocument.createDocumentFragment();
  for (const run of parsed.runs) {
    const span = element.ownerDocument.createElement('span');
    span.textContent = run.text; Object.assign(span.style, run.style); fragment.appendChild(span);
  }
  element.replaceChildren(fragment);
  return parsed.simplified;
}
