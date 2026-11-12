import { HISTORY_ROWS, DEFAULT_HISTORY_ROWS } from './terminal-history-limits.js';

export const BROWSER_PREFERENCES_KEY = 'codex-cloud.display.v1';
export const BROWSER_PREFERENCES_LIMIT = 512;
const defaults = Object.freeze({ layout: 2, zoom: 'width', pan: false, collapsed: true, controlsCollapsed: true,
  autoResolution: false, keepAwake: false, modeStandby: false, mode: 'desktop', terminalFontSize: 15, terminalWidthMode: 'viewport',
  terminalHistoryRows: DEFAULT_HISTORY_ROWS, terminalMouseReporting: false, terminalInputCollapsed: true, pointerMode: 'touch', scrollTarget: 'viewport' });
const oneOf = values => value => values.includes(value);
const boolean = value => typeof value === 'boolean';
const fields = Object.freeze({ zoom: value => ['fit', 'width'].includes(value) || typeof value === 'number' && Number.isFinite(value) && value >= .1 && value <= 2,
  pan: boolean, collapsed: boolean, controlsCollapsed: boolean, autoResolution: boolean, keepAwake: boolean, modeStandby: boolean,
  mode: oneOf(['desktop', 'terminal']), terminalFontSize: value => Number.isInteger(value) && value >= 10 && value <= 28,
  terminalWidthMode: oneOf(['viewport', 'scale', 'manual']), terminalHistoryRows: oneOf(HISTORY_ROWS), terminalMouseReporting: boolean,
  terminalInputCollapsed: boolean, pointerMode: oneOf(['touch', 'trackpad']), scrollTarget: oneOf(['viewport', 'remote']) });
function pick(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key, valid]) => Object.hasOwn(value, key) && valid(value[key])).map(([key]) => [key, value[key]]));
}
export function decodeBrowserPreferences(text, { compact = false } = {}) {
  const value = { ...defaults, terminalFontSize: compact ? 10 : defaults.terminalFontSize };
  try {
    if (typeof text !== 'string' || text.length > BROWSER_PREFERENCES_LIMIT) return value;
    const stored = JSON.parse(text), valid = pick(stored);
    // Older layouts deliberately migrate to width fit and a fixed desktop.
    if (stored?.layout !== 2) for (const key of Object.keys(valid)) if (!['pan', 'collapsed', 'controlsCollapsed'].includes(key)) delete valid[key];
    return Object.assign(value, valid);
  } catch { return value; }
}

// One origin-scoped entry, shared by terminal slots, never sent to the server.
// Open pages keep their view; updates merge only the fields the user changed
// with the latest stored entry, so a stale tab cannot reset another preference.
export function createBrowserPreferences(storage, options = {}) {
  let persisted = !!storage;
  const read = () => {
    try { const text = storage?.getItem(BROWSER_PREFERENCES_KEY); persisted = !!storage; return decodeBrowserPreferences(text, options); }
    catch { persisted = false; return decodeBrowserPreferences(null, options); }
  };
  const value = read();
  return { value, get persisted() { return persisted; }, update(change) {
    const patch = pick(change); Object.assign(value, patch);
    try {
      if (!storage) throw Error('browser storage unavailable');
      const latest = read();
      if (!persisted) throw Error('browser preferences unreadable');
      const next = Object.assign(latest, patch), text = JSON.stringify(next);
      if (text.length > BROWSER_PREFERENCES_LIMIT) throw Error('browser preference bound');
      storage.setItem(BROWSER_PREFERENCES_KEY, text); persisted = true;
    } catch { persisted = false; }
  } };
}
