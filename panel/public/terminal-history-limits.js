// Browser preferences contain only these fixed row counts, never terminal text.
export const HISTORY_ROWS = Object.freeze([2000, 5000, 10000, 20000]);
export const DEFAULT_HISTORY_ROWS = 10000;
export const MAX_HISTORY_ROWS = 20000;
export const HISTORY_BYTES = 1024 * 1024;
export const LEGACY_HISTORY_BYTES = 64 * 1024;
export const HISTORY_CHUNK = 8192;
