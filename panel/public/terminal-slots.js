// Fixed user slots shared by the browser and manager; the host keeper is separate.
export const TERMINAL_IDS = Object.freeze(['main', ...Array.from({ length: 7 }, (_, index) => `aux${index + 1}`)]);
export const TERMINAL_CAPACITY = TERMINAL_IDS.length;
export const DEFAULT_TERMINAL_LIMIT = 4;
export function terminalLimit(value) {
  const limit = value === undefined ? DEFAULT_TERMINAL_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > TERMINAL_CAPACITY) throw new Error(`MAX_TERMINALS 必须为 1–${TERMINAL_CAPACITY} 的整数`);
  return limit;
}
