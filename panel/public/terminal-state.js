import { TERMINAL_IDS } from './terminal-slots.js';

export const TERMINAL_STATE_KEY = 'codex-cloud.terminals.v1';
export const DRAFT_LIMIT = 32768;
export const DRAFT_SLOTS = 9; // current window and eight terminals; stale identities share this bound
export const STATE_LIMIT = 2 * 1024 * 1024; // includes worst-case JSON escaping
const ids = new Set(TERMINAL_IDS);
export function validTerminalIdentity(value) {
  return !!value && ((value.id === '' && value.token === '') || (ids.has(value.id) && typeof value.token === 'string' && /^%\d{1,10}:\d{1,10}$/.test(value.token)));
}
const keyOf = value => value.id ? `${value.id}:${value.token}` : 'window';
const windowIdentity = { id: '', token: '' };

// Text stays in this browser tab. The server receives neither this state nor
// stale drafts; selecting a target never sends any terminal input.
export function createTerminalState(storage) {
  const drafts = new Map();
  let selection = null, persistenceFailed = false;
  try {
    const raw = storage?.getItem(TERMINAL_STATE_KEY);
    if (raw && raw.length <= STATE_LIMIT) {
      const value = JSON.parse(raw);
      if (value?.version === 1 && Array.isArray(value.drafts) && value.drafts.length <= DRAFT_SLOTS) {
        if (validTerminalIdentity(value.selection)) selection = { id: value.selection.id, token: value.selection.token };
        for (const draft of value.drafts) if (validTerminalIdentity(draft) && typeof draft.text === 'string' && draft.text.length <= DRAFT_LIMIT) {
          drafts.set(keyOf(draft), { id: draft.id, token: draft.token, text: draft.text });
        }
      }
    }
    if (!raw) {
      const legacy = storage?.getItem('codex-cloud.draft');
      if (legacy && legacy.length <= DRAFT_LIMIT) drafts.set('window', { ...windowIdentity, text: legacy });
    }
  } catch { persistenceFailed = true; }
  function persist() {
    const raw = JSON.stringify({ version: 1, selection, drafts: [...drafts.values()] });
    if (raw.length > STATE_LIMIT) { persistenceFailed = true; return; }
    try {
      if (!storage) throw new Error('Session storage unavailable');
      storage.setItem(TERMINAL_STATE_KEY, raw);
      storage.removeItem('codex-cloud.draft');
      persistenceFailed = false;
    } catch { persistenceFailed = true; }
  }
  return {
    get selection() { return selection && { ...selection }; },
    get persistenceFailed() { return persistenceFailed; },
    read(identity) { return validTerminalIdentity(identity) ? drafts.get(keyOf(identity))?.text || '' : ''; },
    save(identity, text) {
      if (!validTerminalIdentity(identity) || typeof text !== 'string' || text.length > DRAFT_LIMIT) return false;
      const key = keyOf(identity);
      if (text && !drafts.has(key) && drafts.size >= DRAFT_SLOTS) return false;
      if (text) drafts.set(key, { id: identity.id, token: identity.token, text }); else drafts.delete(key);
      persist(); return true;
    },
    choose(identity) {
      if (!validTerminalIdentity(identity)) return false;
      selection = { id: identity.id, token: identity.token }; persist(); return true;
    },
    adoptWindow(identity) {
      if (!validTerminalIdentity(identity) || !identity.id || drafts.has(keyOf(identity))) return false;
      const draft = drafts.get('window');
      if (!draft?.text) return false;
      drafts.delete('window'); drafts.set(keyOf(identity), { ...identity, text: draft.text }); persist(); return true;
    },
    stale(catalog, active) {
      const live = new Set(catalog.map(keyOf));
      return [...drafts.values()].filter(draft => draft.id && !live.has(keyOf(draft)) && (!active || keyOf(active) !== keyOf(draft))).length;
    },
    clearStale(catalog, active) {
      const live = new Set(catalog.map(keyOf));
      for (const [key, draft] of drafts) if (draft.id && !live.has(key) && (!active || keyOf(active) !== key)) drafts.delete(key);
      persist();
    },
  };
}
