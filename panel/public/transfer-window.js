// Negotiated before data starts; never infer a larger receive window from load.
export const LEGACY_TRANSFER_WINDOW = 4;
export const MAX_TRANSFER_WINDOW = 16;
export const validTransferWindow = value => value === LEGACY_TRANSFER_WINDOW || value === 8 || value === MAX_TRANSFER_WINDOW;
